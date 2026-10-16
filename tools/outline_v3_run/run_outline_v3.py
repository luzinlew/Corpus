#!/usr/bin/env python3
"""Controlled outline v3 test: two Haiku 5.5 calls (or, with --chunks, up to 7 page-chunk calls), no retries, hard budget.

Usage:  python3 -I run_outline_v3.py --dry-check | --run   (see README.md)
The API key is read ONLY from CORPUS_OUTLINE_API_KEY or a hidden getpass prompt.
Stdlib only.
"""
import argparse, getpass, hashlib, http.client, json, os, re, socket, sys, time
import urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REQ_DIR = os.path.join(os.path.dirname(HERE), "handoff", "outline-v3-comparison")
DEFAULT_OUT = os.path.join(HERE, "out")
REAL_BASE = "https://api.anthropic.com"
MODEL = "claude-haiku-5-5"
VERSION = "2023-06-01"
PRICE_IN, PRICE_OUT = 0.10 / 1e6, 0.50 / 1e6   # USD per token, Haiku 5.5, input <= 100K tokens
MAX_TOKENS = 4096
BUDGET_HARD = 0.30
MAX_INPUT_TOKENS = 100000
MAX_PAID_CALLS = 2
CHUNK_MAX_CALLS = 16         # T-033 A: 7 calls; T-035 A2: one page a chunk, 16 calls (Lev 2026-10-16)
CHUNK_BUDGET_HARD = 0.10
ALLOWED = {("GET", "/v1/models/" + MODEL), ("POST", "/v1/messages/count_tokens"), ("POST", "/v1/messages")}

KEY = ""          # set in main(); never printed
_SK = re.compile(r"sk-ant-[A-Za-z0-9_\-\.]*")
_BEARER = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9_\-\.]{8,}")


def scrub(x):
    s = x if isinstance(x, str) else str(x)
    if KEY:
        for v in {KEY, json.dumps(KEY)[1:-1], urllib.parse.quote(KEY, safe=""), KEY.replace("/", "\\/")}:
            if v:
                s = s.replace(v, "***")
    s = _SK.sub("***", s)
    return _BEARER.sub(r"\1***", s)


def say(*a):
    print(scrub(" ".join(str(x) for x in a)), flush=True)


class Stop(Exception):
    pass


class Ledger:
    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)

    def add(self, event, **kw):
        rec = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event}
        rec.update(kw)
        line = scrub(json.dumps(rec, ensure_ascii=False, sort_keys=True))
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, (line + "\n").encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)

    def records(self):
        if not os.path.exists(self.path):
            return []
        out = []
        for ln in open(self.path, encoding="utf-8"):
            ln = ln.strip()
            if ln:
                try:
                    out.append(json.loads(ln))
                except ValueError:
                    out.append({"event": "unparsable"})
        return out

    def paid_sent(self):
        return sum(1 for r in self.records() if r.get("event") == "paid_call_sent")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Unknown(Exception):
    """Request may have reached the server; the outcome is not known."""


class Client:
    def __init__(self, base, timeout, mock):
        self.base, self.timeout = base.rstrip("/"), timeout
        handlers = [NoRedirect()]
        if mock:
            handlers.append(urllib.request.ProxyHandler({}))   # localhost only: never via proxy
        self.opener = urllib.request.build_opener(*handlers)

    def call(self, method, path, body=None):
        if (method, path) not in ALLOWED:
            raise Stop("endpoint not allowed: %s %s" % (method, path))
        headers = {"x-api-key": KEY, "anthropic-version": VERSION, "accept": "application/json",
                   "user-agent": "corpus-outline-v3-runner/1"}
        if body is not None:
            headers["content-type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=self.timeout) as r:
                return r.status, dict(r.headers.items()), r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                txt = e.read().decode("utf-8", "replace")
            except Exception:
                txt = ""
            return e.code, dict(e.headers.items()) if e.headers else {}, txt
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
                http.client.HTTPException, OSError) as e:
            raise Unknown(type(e).__name__ + ": " + scrub(e))


def compact(d):
    return json.dumps(d, separators=(",", ":"), ensure_ascii=False)


def sha(b):
    return hashlib.sha256(b if isinstance(b, bytes) else b.encode("utf-8")).hexdigest()


def load_and_check(req_dir):
    man = json.load(open(os.path.join(req_dir, "comparison-manifest.json"), encoding="utf-8"))
    if man.get("automaticRetry") is not False or man.get("plan") or man.get("lesson") or man.get("maximumPaidCalls", 99) > MAX_PAID_CALLS:
        raise Stop("manifest constraints not as expected")
    reqs = []
    for i in (1, 2):
        p = os.path.join(req_dir, "request-%d.json" % i)
        raw = open(p, "rb").read()
        d = json.loads(raw.decode("utf-8"))
        old = json.load(open(os.path.join(req_dir, "old-request-%d.json" % i), encoding="utf-8"))
        row = man["rows"][i - 1]
        # How Codex hashed: sha256 of the compact JSON text (JSON.stringify, no spaces, raw UTF-8).
        h_compact, h_bytes = sha(compact(d)), sha(raw)
        if h_compact == row["newRequestSha256"]:
            method, body = "compact-json (JSON.stringify-equivalent)", compact(d).encode("utf-8")
        elif h_bytes == row["newRequestSha256"]:
            method, body = "raw-file-bytes", raw
        else:
            raise Stop("request-%d sha256 mismatch with manifest (compact=%s.. bytes=%s..)" % (i, h_compact[:10], h_bytes[:10]))
        if set(d) != {"model", "thinking", "max_tokens", "system", "messages"}:
            raise Stop("request-%d: unexpected keys %s" % (i, sorted(d)))
        if d["model"] != MODEL: raise Stop("request-%d: model != %s" % (i, MODEL))
        if d["thinking"] != {"type": "disabled"}: raise Stop("request-%d: thinking not disabled" % i)
        if d["max_tokens"] != MAX_TOKENS or row.get("maxTokens") != MAX_TOKENS: raise Stop("request-%d: max_tokens != 4096" % i)
        if d["system"] != old["system"]: raise Stop("request-%d: system differs from old request" % i)
        m = d["messages"]
        if not (isinstance(m, list) and len(m) == 1 and m[0].get("role") == "user" and isinstance(m[0].get("content"), str)
                and set(m[0]) == {"role", "content"}):
            raise Stop("request-%d: must be exactly one user message with string content" % i)
        c = m[0]["content"]
        if not c.startswith("CORPUS-OUTLINE") or "INPUT:\n" not in c:
            raise Stop("request-%d: not an outline prompt" % i)
        if len(c) != row["newMessageChars"]:
            raise Stop("request-%d: message length differs from manifest" % i)
        reqs.append({"i": i, "data": d, "body": body, "sha": sha(body), "method": method, "chars": len(c),
                     "inputSha": sha(c.split("INPUT:\n", 1)[1])})
    return man, reqs


def load_chunks(chunks_dir, req_dir, max_calls):
    """Chunk requests made by make_chunks.py; each is re-derived from the verified original request and compared."""
    cm = json.load(open(os.path.join(chunks_dir, "chunk-manifest.json"), encoding="utf-8"))
    if cm.get("automaticRetry") is not False or cm.get("plan") is not False or cm.get("lesson") is not False:
        raise Stop("chunk manifest constraints not as expected")
    if not (isinstance(cm.get("maximumPaidCalls"), int) and cm["maximumPaidCalls"] <= CHUNK_MAX_CALLS):
        raise Stop("chunk manifest allows more than %d calls" % CHUNK_MAX_CALLS)
    rows = cm["rows"]
    if not (1 <= len(rows) <= max_calls <= CHUNK_MAX_CALLS):
        raise Stop("chunk count %d must be <= --max-calls %d <= %d" % (len(rows), max_calls, CHUNK_MAX_CALLS))
    _, originals = load_and_check(req_dir)            # sha/model/thinking/max_tokens/system checks of the two originals
    orig = {r["i"]: r for r in originals}
    covered = {}
    reqs = []
    for row in rows:
        o = orig.get(row["parent"])
        if not o:
            raise Stop("chunk %s: unknown parent" % row["id"])
        raw = open(os.path.join(chunks_dir, "request-%s.json" % row["id"]), "rb").read()
        if sha(raw) != row["requestSha256"]:
            raise Stop("chunk %s: sha256 mismatch with chunk manifest" % row["id"])
        d = json.loads(raw.decode("utf-8"))
        od = o["data"]
        if list(d) != list(od) or any(d[k] != od[k] for k in ("model", "thinking", "max_tokens", "system")):
            raise Stop("chunk %s: model/thinking/max_tokens/system differ from original request" % row["id"])
        m = d["messages"]
        if not (isinstance(m, list) and len(m) == 1 and set(m[0]) == {"role", "content"} and m[0]["role"] == "user"):
            raise Stop("chunk %s: must be exactly one user message with string content" % row["id"])
        prefix, inp = m[0]["content"].split("INPUT:\n", 1)
        oprefix, oinp = od["messages"][0]["content"].split("INPUT:\n", 1)
        if prefix != oprefix:
            raise Stop("chunk %s: prompt prefix differs from original" % row["id"])
        sub, full = json.loads(inp), json.loads(oinp)
        if compact(sub) != inp or set(sub) != {"name", "pages"} or sub["name"] != full["name"]:
            raise Stop("chunk %s: INPUT shape/name differs" % row["id"])
        fp = {p["n"]: p for p in full["pages"]}
        for p in sub["pages"]:
            if fp.get(p["n"]) != p:
                raise Stop("chunk %s: page %s is not the original whole page" % (row["id"], p.get("n")))
        if [p["n"] for p in sub["pages"]] != row["pages"]:
            raise Stop("chunk %s: pages differ from manifest" % row["id"])
        covered.setdefault(row["parent"], []).extend(row["pages"])
        reqs.append({"i": row["id"], "data": d, "body": raw, "sha": sha(raw), "method": "chunk-file-bytes",
                     "chars": len(m[0]["content"]), "inputSha": sha(inp), "parent": row["parent"], "pages": row["pages"]})
    skipped = cm.get("skippedPages") or {}
    for n, o in orig.items():
        pages = json.loads(o["data"]["messages"][0]["content"].split("INPUT:\n", 1)[1])["pages"]
        for p in pages:   # a page left out must really have no text block
            if p["n"] in skipped.get(str(n), []) and any(b["text"].strip() for b in p["blocks"]):
                raise Stop("chunk manifest skips page %d of request %d, which has text" % (p["n"], n))
        want = [p["n"] for p in pages if p["n"] not in skipped.get(str(n), [])]
        if covered.get(n) != want:
            raise Stop("chunks of request %d cover pages %s, expected %s" % (n, covered.get(n), want))
    return cm, reqs


def bound(tokens):
    return tokens * PRICE_IN + MAX_TOKENS * PRICE_OUT


def actual_cost(usage):
    u = usage or {}
    cc, cr = u.get("cache_creation_input_tokens") or 0, u.get("cache_read_input_tokens") or 0
    cost = (u.get("input_tokens") or 0) * PRICE_IN + (u.get("output_tokens") or 0) * PRICE_OUT
    cost += cc * PRICE_IN * 1.25 + cr * PRICE_IN * 0.10   # assumed standard cache multipliers; only if nonzero
    return cost, bool(cc or cr)


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(scrub(text))


def main(argv=None):
    global KEY
    ap = argparse.ArgumentParser(description="Controlled outline v3 test (2 paid calls max, no retries).")
    ap.add_argument("--dry-check", action="store_true", help="steps 1-3 only (free)")
    ap.add_argument("--run", action="store_true", help="steps 1-5 (two paid calls)")
    ap.add_argument("--allow-second-run", action="store_true", help="permit --run although a paid call is already in the ledger")
    ap.add_argument("--mock-gateway", metavar="URL", help="test only: http://127.0.0.1:PORT or http://localhost:PORT")
    ap.add_argument("--requests-dir", default=DEFAULT_REQ_DIR)
    ap.add_argument("--chunks", metavar="DIR", help="T-033 A: send the page chunks from make_chunks.py instead of the two whole requests")
    ap.add_argument("--max-calls", type=int, help="with --chunks: explicit cap on paid calls (required, <= 16)")
    ap.add_argument("--out-dir", default=DEFAULT_OUT)
    ap.add_argument("--timeout", type=float, default=120.0)
    a = ap.parse_args(argv)
    if not (a.dry_check or a.run):
        ap.print_help()
        return 0
    if a.dry_check and a.run:
        say("choose one of --dry-check / --run"); return 2
    if a.chunks and not (a.max_calls and 1 <= a.max_calls <= CHUNK_MAX_CALLS):
        say("with --chunks, --max-calls N is required, 1 <= N <= %d" % CHUNK_MAX_CALLS); return 2
    if a.max_calls and not a.chunks:
        say("--max-calls is only for --chunks"); return 2
    max_calls = a.max_calls if a.chunks else MAX_PAID_CALLS
    if not (0 < a.timeout <= 120):
        say("timeout must be in (0,120]"); return 2
    if a.mock_gateway:
        u = urllib.parse.urlparse(a.mock_gateway)
        if u.scheme != "http" or u.hostname not in ("localhost", "127.0.0.1") or u.username or u.password:
            say("refused: --mock-gateway must be http://localhost or http://127.0.0.1"); return 2
        base = a.mock_gateway
    else:
        base = REAL_BASE
    KEY = os.environ.get("CORPUS_OUTLINE_API_KEY", "").strip()
    if not KEY:
        if sys.stdin.isatty():
            KEY = getpass.getpass("Anthropic API key (hidden): ").strip()
        if not KEY:
            say("no key: set CORPUS_OUTLINE_API_KEY or run in a terminal for hidden input"); return 2
    out = a.out_dir
    os.makedirs(out, exist_ok=True)
    led = Ledger(os.path.join(out, "ledger.jsonl"))
    mode = "run" if a.run else "dry-check"
    if a.run and led.paid_sent() and not a.allow_second_run:
        say("refused: ledger already has a paid call; use --allow-second-run only with explicit permission")
        led.add("refused_second_run"); return 3
    cl = Client(base, a.timeout, bool(a.mock_gateway))
    led.add("start", mode=mode, base=base, mock=bool(a.mock_gateway), timeout=a.timeout)
    summary = {"mode": mode, "chunks": bool(a.chunks), "maxCalls": max_calls, "base": base, "model": MODEL, "paidCallsSent": 0, "spentUSD_actual": 0.0,
               "reservedUSD_unknown": 0.0, "calls": [], "ok": False, "stoppedBecause": ""}
    try:
        # 1. free auth check
        try:
            st, hd, txt = cl.call("GET", "/v1/models/" + MODEL)
        except Unknown as e:
            led.add("auth_check", ok=False, error=str(e)); raise Stop("auth check failed: " + str(e))
        led.add("auth_check", ok=st == 200, status=st, request_id=hd.get("request-id") or hd.get("Request-Id"),
                reason=None if st == 200 else scrub(txt)[:300])
        if st != 200:
            raise Stop("auth check HTTP %s: %s" % (st, scrub(txt)[:300]))
        say("1. auth ok (GET /v1/models/%s -> 200)" % MODEL)
        # 2. validate requests
        if a.chunks:
            man, reqs = load_chunks(a.chunks, a.requests_dir, max_calls)
            for r in reqs:
                led.add("request_validated", n=r["i"], parent=r["parent"], pages=r["pages"], sha256=r["sha"], messageChars=r["chars"], inputSha256=r["inputSha"])
        else:
            man, reqs = load_and_check(a.requests_dir)
            for r in reqs:
                led.add("request_validated", n=r["i"], sha256=r["sha"], hashMethod=r["method"], messageChars=r["chars"],
                        inputSha256=r["inputSha"], inputSha256MatchesManifest=(r["inputSha"] == man["rows"][r["i"] - 1]["inputSha256"]))
        say("2. requests validated:", ", ".join("%s sha=%s.." % (r["i"], r["sha"][:10]) for r in reqs))
        # 3. free count_tokens
        total = 0.0
        for r in reqs:
            d = r["data"]
            body = compact({"model": d["model"], "system": d["system"], "messages": d["messages"]}).encode("utf-8")
            try:
                st, hd, txt = cl.call("POST", "/v1/messages/count_tokens", body)
            except Unknown as e:
                led.add("count_tokens", n=r["i"], ok=False, error=str(e)); raise Stop("count_tokens failed: " + str(e))
            try:
                tok = json.loads(txt)["input_tokens"]
                assert isinstance(tok, int) and tok >= 0
            except Exception:
                tok = None
            if st != 200 or tok is None:
                led.add("count_tokens", n=r["i"], ok=False, status=st, reason=scrub(txt)[:300])
                raise Stop("count_tokens HTTP %s: %s" % (st, scrub(txt)[:200]))
            r["tokens"], r["bound"] = tok, bound(tok)
            total += r["bound"]
            led.add("count_tokens", n=r["i"], ok=True, input_tokens=tok, upperBoundUSD=r["bound"])
            if tok > MAX_INPUT_TOKENS:
                raise Stop("request %s: %d input tokens > %d (price tier unknown)" % (r["i"], tok, MAX_INPUT_TOKENS))
        budget = CHUNK_BUDGET_HARD if a.chunks else BUDGET_HARD
        try:
            budget = min(budget, float(man.get("maximumUSD", budget)))
        except (TypeError, ValueError):
            pass
        summary["budgetUSD"], summary["upperBoundTotalUSD"] = budget, total
        summary["countedInputTokens"] = [r["tokens"] for r in reqs]
        say("3. counted tokens:", [r["tokens"] for r in reqs], "upper bound total $%.5f (budget $%.2f)" % (total, budget))
        if total > budget:
            raise Stop("upper bound $%.5f exceeds budget $%.2f; nothing sent" % (total, budget))
        if a.dry_check:
            summary["ok"] = True
            led.add("dry_check_ok", upperBoundTotalUSD=total)
            return 0
        # 4./5. paid calls
        committed = 0.0
        for idx, r in enumerate(reqs):
            if committed + r["bound"] > budget:
                raise Stop("budget (with reserve) does not allow request %s" % r["i"])
            if led.paid_sent() >= max_calls and not a.allow_second_run:
                raise Stop("paid call limit reached")
            led.add("paid_call_sent", n=r["i"], sha256=r["sha"], reservedUSD=r["bound"])   # written BEFORE sending
            summary["paidCallsSent"] += 1
            rec = {"n": r["i"], "requestSha256": r["sha"], "countedInputTokens": r["tokens"], "upperBoundUSD": r["bound"]}
            summary["calls"].append(rec)
            try:
                st, hd, txt = cl.call("POST", "/v1/messages", r["body"])
            except Unknown as e:
                rec.update(outcome="outcome unknown, reserved", reservedUSD=r["bound"], error=str(e))
                summary["reservedUSD_unknown"] += r["bound"]
                led.add("paid_call_unknown", n=r["i"], note="outcome unknown, reserved", reservedUSD=r["bound"], error=str(e))
                raise Stop("request %s: outcome unknown (reserved $%.5f); not retrying, stopping" % (r["i"], r["bound"]))
            rid = hd.get("request-id") or hd.get("Request-Id")
            rec.update(httpStatus=st, requestId=rid)
            if st >= 400:
                write(os.path.join(out, "response-%s.error.txt" % r["i"]), txt)
                res = r["bound"] if a.chunks else 0.0      # T-033 A: a failed call counts as spent at its upper bound
                rec.update(outcome="http_error", reservedUSD=res)
                summary["reservedUSD_unknown"] += res
                led.add("paid_call_failed", n=r["i"], status=st, request_id=rid, reason=scrub(txt)[:300], reservedUSD=res)
                raise Stop("request %s: HTTP %s: %s (no retry)" % (r["i"], st, scrub(txt)[:200]))
            try:
                resp = json.loads(txt)
                usage = resp["usage"]
                assert isinstance(usage.get("input_tokens"), int) and isinstance(usage.get("output_tokens"), int)
                assert isinstance(resp.get("content"), list)
            except Exception:
                write(os.path.join(out, "response-%s.invalid.txt" % r["i"]), txt)
                rec.update(outcome="invalid response, reserved", reservedUSD=r["bound"])
                summary["reservedUSD_unknown"] += r["bound"]
                led.add("paid_call_invalid", n=r["i"], status=st, request_id=rid, note="invalid response, reserved", reservedUSD=r["bound"], bytes=len(txt))
                raise Stop("request %s: response not valid JSON/shape; reserved; not retrying" % r["i"])
            write(os.path.join(out, "response-%s.json" % r["i"]), json.dumps(resp, ensure_ascii=False, indent=2) + "\n")
            cost, cache = actual_cost(usage)
            committed += cost
            summary["spentUSD_actual"] += cost
            rec.update(outcome="completed", usage=usage, stopReason=resp.get("stop_reason"), actualUSD=cost,
                       cacheTokensPresent=cache, responseBytes=len(txt), model=resp.get("model"))
            if cache:
                rec["note"] = "cache tokens present: priced with assumed 1.25x/0.10x input multipliers"
            led.add("paid_call_completed", n=r["i"], request_id=rid, input_tokens=usage["input_tokens"],
                    output_tokens=usage["output_tokens"], stop_reason=resp.get("stop_reason"), actualUSD=cost, cacheTokensPresent=cache)
            say("4. request %s done: in=%s out=%s stop=%s cost=$%.5f id=%s" % (r["i"], usage["input_tokens"],
                usage["output_tokens"], resp.get("stop_reason"), cost, rid))
            if resp.get("stop_reason") != "end_turn":
                rec["warning"] = "stop_reason=%s (response kept, not retried)" % resp.get("stop_reason")
                say("   warning: stop_reason", resp.get("stop_reason"))
        summary["ok"] = True
        return 0
    except Stop as e:
        summary["stoppedBecause"] = scrub(str(e))
        led.add("stopped", reason=scrub(str(e)))
        say("STOPPED:", e)
        return 1
    except Exception as e:      # never leak a traceback with secrets
        summary["stoppedBecause"] = "internal error: " + type(e).__name__ + ": " + scrub(e)
        led.add("stopped", reason=summary["stoppedBecause"])
        say("STOPPED (internal error):", type(e).__name__, scrub(e))
        return 1
    finally:
        summary["totalCostIncludingReserveUSD"] = summary["spentUSD_actual"] + summary["reservedUSD_unknown"]
        if a.run or summary.get("calls"):
            write(os.path.join(out, "run-summary.json" if a.run else "dry-check-summary.json"),
                  json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
        elif a.dry_check:
            write(os.path.join(out, "dry-check-summary.json"), json.dumps(summary, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as e:
        print(scrub("fatal: %s: %s" % (type(e).__name__, e)), file=sys.stderr)
        sys.exit(1)
