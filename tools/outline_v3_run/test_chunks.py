#!/usr/bin/env python3
"""Offline tests of run_outline_v3.py --chunks against the local mock. No network except 127.0.0.1.
CHUNKS_DIR=chunks (T-033 A, 6 chunks, cap 7) or CHUNKS_DIR=chunks1 (T-035 A2, 16 chunks, cap 16)."""
import hashlib, json, os, secrets, shutil, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mock_gateway import Mock
RUNNER = os.path.join(HERE, "run_outline_v3.py")
REQ = os.path.join(os.path.dirname(HERE), "handoff", "outline-v3-comparison")
CH = os.path.join(HERE, os.environ.get("CHUNKS_DIR", "chunks"))
TEST_OUT = os.path.join(HERE, "test_chunks_out_" + os.path.basename(CH))
shutil.rmtree(TEST_OUT, ignore_errors=True); os.makedirs(TEST_OUT)
KEY = "sk-ant-api03-" + secrets.token_hex(20)
KEY2 = "plainkey_" + secrets.token_hex(20)
CM = json.load(open(os.path.join(CH, "chunk-manifest.json")))
IDS = [r["id"] for r in CM["rows"]]
N, CAP, HARD = len(IDS), CM["maximumPaidCalls"], 16
results, STATS = [], []
SIX = (10000,) * N


def run(name, mock, flags, key=KEY, chunks=CH, extra=("--max-calls", str(CAP))):
    out = os.path.join(TEST_OUT, name); os.makedirs(out, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC", "CORPUS_OUTLINE"))}
    env["CORPUS_OUTLINE_API_KEY"] = key
    env["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:1"
    p = subprocess.run([sys.executable, "-I", RUNNER, *flags, "--mock-gateway", mock.url, "--out-dir", out, "--requests-dir", REQ,
                        "--chunks", chunks, *extra], env=env, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
    open(os.path.join(out, "captured_stdout.txt"), "w").write(p.stdout)
    open(os.path.join(out, "captured_stderr.txt"), "w").write(p.stderr)
    STATS.append((name, mock.paid, mock.non_outline))
    return p, out


def evs(out, e):
    f = os.path.join(out, "ledger.jsonl")
    return [r for r in (json.loads(l) for l in open(f)) if r["event"] == e] if os.path.exists(f) else []


def check(label, cond, detail=""):
    results.append((label, bool(cond)))
    print(("PASS " if cond else "FAIL ") + label + (("  [" + detail + "]") if detail and not cond else ""))


# (a) success: exactly the 6 chunk files, in order, unchanged
with Mock(KEY, count_tokens=SIX) as m:
    p, out = run("a_success", m, ["--run"])
    s = json.load(open(os.path.join(out, "run-summary.json")))
    check("a: exit 0, ok, %d paid calls (no extra call)" % N, p.returncode == 0 and s["ok"] and m.paid == N and s["paidCallsSent"] == N, p.stdout[-300:])
    check("a: responses saved per chunk", all(os.path.exists(os.path.join(out, "response-%s.json" % i)) for i in IDS))
    sent = [json.dumps(b, separators=(",", ":"), ensure_ascii=False) for b in m.bodies]
    files = [open(os.path.join(CH, "request-%s.json" % i), encoding="utf-8").read() for i in IDS]
    check("a: bodies sent == chunk files, in manifest order", sent == files)
    orig = [json.load(open(os.path.join(REQ, "request-%d.json" % n))) for n in (1, 2)]
    same = all(b["model"] == "claude-haiku-5-5" and b["max_tokens"] == 4096 and b["thinking"] == {"type": "disabled"} and b["system"] == orig[0]["system"] for b in m.bodies)
    check("a: model/max_tokens/thinking/system as in the whole-document v3 requests", same)
    pref = [o["messages"][0]["content"].split("INPUT:\n")[0] for o in orig]
    check("a: prompt prefix byte-identical to the parent request", all(b["messages"][0]["content"].split("INPUT:\n")[0] == pref[int(i[0]) - 1] for b, i in zip(m.bodies, IDS)))
    log = [x[1] for x in m.log]
    check("a: models, then %d count_tokens, then messages" % N, log[0] == "/v1/models/claude-haiku-5-5" and log[1:N + 1] == ["/v1/messages/count_tokens"] * N and log[N + 1:] == ["/v1/messages"] * N, str(log))
    check("a: upper bound and budget in summary", s["budgetUSD"] == 0.10 and abs(s["upperBoundTotalUSD"] - N * (10000 * 0.1 + 4096 * 0.5) / 1e6) < 1e-12)
    n0 = m.paid
    p2, _ = run("a_success", m, ["--run"])
    check("a: second --run refused, nothing sent", p2.returncode == 3 and m.paid == n0)

# dry-check
with Mock(KEY, count_tokens=SIX) as m:
    p, out = run("dry", m, ["--dry-check"])
    check("dry: exit 0, %d count_tokens, 0 paid" % N, p.returncode == 0 and m.ct_calls == N and m.paid == 0 and not evs(out, "paid_call_sent"))

# (b) explicit call cap
with Mock(KEY, count_tokens=SIX) as m:
    p, _ = run("b_nomax", m, ["--run"], extra=())
    check("b: --chunks without --max-calls -> refused before any network", p.returncode == 2 and not m.log)
    p, _ = run("b_max17", m, ["--run"], extra=("--max-calls", str(HARD + 1)))
    check("b: --max-calls %d (over the hard cap 16) -> refused" % (HARD + 1), p.returncode == 2 and not m.log)
    p, _ = run("b_maxless", m, ["--run"], extra=("--max-calls", str(N - 1)))
    check("b: --max-calls %d < %d chunks -> refused, nothing paid, no count_tokens" % (N - 1, N), p.returncode == 1 and m.paid == 0 and m.ct_calls == 0 and "max-calls" in p.stdout, p.stdout[-200:])

# (c) budget from manifest (min with 0.10) is enforced before paying
def tampered(name, fn, fix_sha=True, cmfn=None):
    d = os.path.join(TEST_OUT, "ch_" + name); shutil.copytree(CH, d)
    cm = json.load(open(os.path.join(d, "chunk-manifest.json")))
    if fn:
        pth = os.path.join(d, "request-1-2.json"); r = json.load(open(pth)); fn(r)
        body = json.dumps(r, separators=(",", ":"), ensure_ascii=False); open(pth, "w", encoding="utf-8").write(body)
        if fix_sha: cm["rows"][1]["requestSha256"] = hashlib.sha256(body.encode()).hexdigest()
    if cmfn: cmfn(cm)
    json.dump(cm, open(os.path.join(d, "chunk-manifest.json"), "w"), ensure_ascii=False)
    return d
d = tampered("budget", None, cmfn=lambda cm: cm.__setitem__("maximumUSD", 0.01))
with Mock(KEY, count_tokens=SIX) as m:
    p, out = run("c_budget", m, ["--run"], chunks=d)
    check("c: upper bound > manifest $0.01 -> stop, nothing paid", p.returncode == 1 and m.paid == 0 and "exceeds budget" in p.stdout, p.stdout[-200:])
d = tampered("calls", None, cmfn=lambda cm: cm.__setitem__("maximumPaidCalls", HARD + 1))
with Mock(KEY, count_tokens=SIX) as m:
    p, out = run("c_calls", m, ["--run"], chunks=d)
    check("c: manifest allowing 17 calls -> refused", p.returncode == 1 and m.paid == 0)
d = tampered("retry", None, cmfn=lambda cm: cm.__setitem__("automaticRetry", True))
with Mock(KEY, count_tokens=SIX) as m:
    p, out = run("c_retry", m, ["--run"], chunks=d)
    check("c: manifest with automaticRetry -> refused", p.returncode == 1 and m.paid == 0)

# (d) failures stop the run, failed call reserved at its upper bound, no retry
with Mock(KEY, count_tokens=SIX, messages=("ok", "500", "ok")) as m:
    p, out = run("d_500", m, ["--run"])
    s = json.load(open(os.path.join(out, "run-summary.json")))
    b = (10000 * 0.1 + 4096 * 0.5) / 1e6
    check("d: 500 on chunk 2 -> stop, 2 sent, the rest not sent", p.returncode == 1 and m.paid == 2, "paid=%d" % m.paid)
    check("d: failed call reserved at upper bound", s["calls"][1]["outcome"] == "http_error" and abs(s["calls"][1]["reservedUSD"] - b) < 1e-12 and abs(s["reservedUSD_unknown"] - b) < 1e-12)
for mode in ("hang", "drop", "garbage"):
    with Mock(KEY, count_tokens=SIX, messages=(mode, "ok"), hang_seconds=4.0) as m:
        p, out = run("d_" + mode, m, ["--run"], extra=("--max-calls", str(CAP), "--timeout", "1.5"))
        s = json.load(open(os.path.join(out, "run-summary.json")))
        check("d(%s): stop after 1 call, reserved, no retry" % mode, p.returncode == 1 and m.paid == 1 and s["reservedUSD_unknown"] > 0, "paid=%d" % m.paid)
with Mock(KEY, count_tokens=SIX, messages=("max_tokens", "ok")) as m:
    p, out = run("d_maxtok", m, ["--run"])
    check("d: max_tokens on chunk 1 -> kept with warning, no retry, %d calls total" % N, p.returncode == 0 and m.paid == N and "warning" in json.load(open(os.path.join(out, "run-summary.json")))["calls"][0])

# (e) tampered chunks
cases = [("sha", lambda r: r["messages"][0].__setitem__("content", r["messages"][0]["content"] + " "), False, "sha256 mismatch"),
         ("system", lambda r: r.__setitem__("system", "x"), True, "system"),
         ("model", lambda r: r.__setitem__("model", "claude-sonnet-5-5"), True, "model"),
         ("maxtok", lambda r: r.__setitem__("max_tokens", 8192), True, "max_tokens"),
         ("prefix", lambda r: r["messages"][0].__setitem__("content", "X" + r["messages"][0]["content"]), True, "prefix"),
         ("blocktext", lambda r: r["messages"][0].__setitem__("content", r["messages"][0]["content"].replace('"emphasis":false', '"emphasis":true', 1)), True, "whole page"),
         ("droppage", lambda r: r["messages"][0].__setitem__("content", r["messages"][0]["content"].split("INPUT:\n")[0] + "INPUT:\n" + json.dumps(
             {**json.loads(r["messages"][0]["content"].split("INPUT:\n")[1]), "pages": json.loads(r["messages"][0]["content"].split("INPUT:\n")[1])["pages"][:-1]}, separators=(",", ":"), ensure_ascii=False)), True, "pages differ"),
         ("twomsgs", lambda r: r["messages"].append({"role": "assistant", "content": "x"}), True, "exactly one")]
for nm, fn, fix, word in cases:
    d = tampered(nm, fn, fix)
    with Mock(KEY, count_tokens=SIX) as m:
        p, out = run("e_" + nm, m, ["--run"], chunks=d)
        check("e: tampered chunk %s -> refused, nothing paid (%s)" % (nm, word), p.returncode == 1 and m.paid == 0 and m.ct_calls == 0 and word in p.stdout, p.stdout[-200:])
d = tampered("coverage", None, cmfn=lambda cm: cm.__setitem__("rows", [r for r in cm["rows"] if r["id"] != "2-3"]))
with Mock(KEY, count_tokens=SIX) as m:
    p, out = run("e_coverage", m, ["--run"], chunks=d)
    check("e: chunks not covering all pages -> refused", p.returncode == 1 and m.paid == 0 and "cover pages" in p.stdout, p.stdout[-200:])
last = CM["rows"][-1]
d = tampered("skiptext", None, cmfn=lambda cm: (cm.__setitem__("rows", cm["rows"][:-1]), cm.__setitem__("skippedPages", {str(last["parent"]): last["pages"]})))
with Mock(KEY, count_tokens=SIX) as m:
    p, out = run("e_skiptext", m, ["--run"], chunks=d)
    check("e: manifest skipping a page that has text -> refused, nothing paid", p.returncode == 1 and m.paid == 0 and "which has text" in p.stdout, p.stdout[-200:])

# (f) key never leaks
for k, tag in ((KEY, "sk"), (KEY2, "plain")):
    with Mock(k, count_tokens=SIX, messages=("500",)) as m:
        p, out = run("f_echo_" + tag, m, ["--run"], key=k)
        check("f(%s): echoed key redacted" % tag, p.returncode == 1 and "***" in p.stdout + open(os.path.join(out, "response-1-1.error.txt")).read() and k not in p.stdout + p.stderr)

check("g: every invocation <= %d paid (max %d) and 0 non-outline (plan/lesson)" % (CAP, max(x[1] for x in STATS)), all(x[1] <= CAP and x[2] == 0 for x in STATS))
leaks = []
for root, _, fs in os.walk(HERE):
    for f in fs:
        try: data = open(os.path.join(root, f), "rb").read()
        except OSError: continue
        leaks += [(os.path.join(root, f), k[:8]) for k in (KEY, KEY2) if k.encode() in data]
check("f: key value absent from every file under R/", not leaks, str(leaks))
bad = [l for l, ok in results if not ok]
print("\nRESULT: %d checks, %d failed" % (len(results), len(bad)))
print("ALL CHUNK TESTS PASSED" if not bad else "FAILED: " + "; ".join(bad))
sys.exit(1 if bad else 0)
