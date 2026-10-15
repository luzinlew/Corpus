#!/usr/bin/env python3
"""Offline tests of run_outline_v3.py against a local mock gateway. No network except 127.0.0.1."""
import json, os, secrets, shutil, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mock_gateway import Mock
RUNNER = os.path.join(HERE, "run_outline_v3.py")
REQ = os.path.join(os.path.dirname(HERE), "handoff", "outline-v3-comparison")
TEST_OUT = os.path.join(HERE, "test_out")
shutil.rmtree(TEST_OUT, ignore_errors=True); os.makedirs(TEST_OUT)
KEY = "sk-ant-api03-" + secrets.token_hex(20)      # fake, generated at runtime
KEY2 = "plainkey_" + secrets.token_hex(20)         # fake, not sk-ant shaped
KEYS = [KEY, KEY2]
results = []
STATS = []


def run(name, mock, flags, key=KEY, req_dir=REQ, extra=()):
    out = os.path.join(TEST_OUT, name); os.makedirs(out, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC", "CORPUS_OUTLINE"))}
    env["CORPUS_OUTLINE_API_KEY"] = key
    env["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:1"     # must be ignored
    p = subprocess.run([sys.executable, "-I", RUNNER, *flags, "--mock-gateway", mock.url, "--out-dir", out,
                        "--requests-dir", req_dir, *extra], env=env, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
    open(os.path.join(out, "captured_stdout.txt"), "w").write(p.stdout)
    open(os.path.join(out, "captured_stderr.txt"), "w").write(p.stderr)
    STATS.append((name, mock.paid, mock.non_outline))
    return p, out


def ledger(out):
    f = os.path.join(out, "ledger.jsonl")
    return [json.loads(l) for l in open(f)] if os.path.exists(f) else []


def check(label, cond, detail=""):
    results.append((label, bool(cond)))
    print(("PASS " if cond else "FAIL ") + label + (("  [" + detail + "]") if detail and not cond else ""))


def evs(out, e): return [r for r in ledger(out) if r["event"] == e]


# (a) success
with Mock(KEY) as m:
    p, out = run("a_success", m, ["--run"])
    s = json.load(open(os.path.join(out, "run-summary.json")))
    check("a: exit 0, summary ok", p.returncode == 0 and s["ok"], p.stdout[-300:])
    check("a: 2 paid calls, 2 responses saved", m.paid == 2 and all(os.path.exists(os.path.join(out, "response-%d.json" % i)) for i in (1, 2)))
    check("a: ledger has paid_call_sent x2 and completed x2", len(evs(out, "paid_call_sent")) == 2 and len(evs(out, "paid_call_completed")) == 2)
    exp = (10000 * 0.1 + 1000 * 0.5) / 1e6
    check("a: actual cost = in*0.10/1e6+out*0.50/1e6", abs(s["calls"][0]["actualUSD"] - exp) < 1e-12 and s["calls"][0]["requestId"].startswith("req_mock"))
    check("a: count_tokens before messages, models first", [x[1] for x in m.log][:4] == ["/v1/models/claude-haiku-5-5", "/v1/messages/count_tokens", "/v1/messages/count_tokens", "/v1/messages"])
    check("a: ledger holds no document text", all(len(json.dumps(r)) < 800 for r in ledger(out)))
    check("a: ANTHROPIC_BASE_URL ignored (mock got the calls)", m.paid == 2)
    # (g) second run refuses, same out dir
    n0 = m.paid
    p2, _ = run("a_success", m, ["--run"])
    check("g: second --run refused, nothing sent", p2.returncode == 3 and m.paid == n0 and "refused" in p2.stdout)
    check("g: summary of first run not overwritten", json.load(open(os.path.join(out, "run-summary.json")))["ok"])
    check("i(a): <=2 paid, 0 non-outline", m.paid <= 2 and m.non_outline == 0)

# dry-check
with Mock(KEY) as m:
    p, out = run("dry", m, ["--dry-check"])
    check("dry-check: exit 0, nothing paid", p.returncode == 0 and m.paid == 0 and not evs(out, "paid_call_sent"))

# (b) wrong key
with Mock(KEY) as m:
    p, out = run("b_badkey", m, ["--run"], key=KEY2)
    check("b: 401 -> exit 1, nothing paid, no count_tokens", p.returncode == 1 and m.paid == 0 and m.ct_calls == 0 and "401" in p.stdout)
    check("b: no paid_call_sent in ledger", not evs(out, "paid_call_sent"))

# (c) budget / token cap
with Mock(KEY, count_tokens=(100001, 5000)) as m:
    p, out = run("c_budget", m, ["--run"])
    check("c: >100000 tokens -> refused, nothing sent", p.returncode == 1 and m.paid == 0 and not evs(out, "paid_call_sent"), p.stdout[-200:])
with Mock(KEY, count_tokens=(99000, 99000)) as m:
    p, out = run("c_budget2", m, ["--run"])
    check("c: 2x99K tokens ($0.024) is within budget -> goes through", p.returncode == 0 and m.paid == 2)

# (d) 500 on first
with Mock(KEY, messages=("500", "ok")) as m:
    p, out = run("d_500", m, ["--run"], key=KEY)
    check("d: 500 -> no retry, second not sent", p.returncode == 1 and m.paid == 1, "paid=%d" % m.paid)
    check("d: ledger paid_call_failed, error file saved", len(evs(out, "paid_call_failed")) == 1 and os.path.exists(os.path.join(out, "response-1.error.txt")))
    check("d: summary reservedUSD 0 for refused call", json.load(open(os.path.join(out, "run-summary.json")))["calls"][0]["outcome"] == "http_error")

# (e) timeout and drop
for mode in ("hang", "drop"):
    with Mock(KEY, messages=(mode, "ok"), hang_seconds=4.0) as m:
        p, out = run("e_" + mode, m, ["--run"], extra=["--timeout", "1.5"])
        s = json.load(open(os.path.join(out, "run-summary.json")))
        check("e(%s): outcome unknown, reserved, no retry, second not sent" % mode,
              p.returncode == 1 and m.paid == 1 and s["calls"][0]["outcome"] == "outcome unknown, reserved" and s["reservedUSD_unknown"] > 0, "paid=%d %s" % (m.paid, s["calls"]))
        check("e(%s): ledger paid_call_unknown" % mode, len(evs(out, "paid_call_unknown")) == 1)
with Mock(KEY, messages=("garbage", "ok")) as m:
    p, out = run("e_garbage", m, ["--run"])
    check("e: invalid JSON 200 -> reserved, no retry, stop", p.returncode == 1 and m.paid == 1 and len(evs(out, "paid_call_invalid")) == 1)
with Mock(KEY, messages=("max_tokens", "ok")) as m:
    p, out = run("e_maxtok", m, ["--run"])
    check("e: stop_reason max_tokens -> kept, no retry (2 total calls)", p.returncode == 0 and m.paid == 2 and "warning" in json.load(open(os.path.join(out, "run-summary.json")))["calls"][0])

# (f) key echo, using both key shapes
for k, tag in ((KEY, "sk"), (KEY2, "plain")):
    with Mock(k, messages=("500", "ok"), models_status=200) as m:
        p, out = run("f_echo_" + tag, m, ["--run"], key=k)
        check("f(%s): error body echoed key -> redacted in stdout" % tag, p.returncode == 1 and "***" in (p.stdout + open(os.path.join(out, "response-1.error.txt")).read()) and k not in p.stdout + p.stderr)
    with Mock(k) as m:
        p, out = run("f_401_" + tag, m, ["--dry-check"], key=k[:-1] + ("0" if k[-1] != "0" else "1"))   # wrong key, mock echoes it in the 401 message
        check("f(%s): 401 message echoes sent key -> redacted" % tag, p.returncode == 1 and "***" in p.stdout)

# (h) tampered requests
def tampered(name, mutate, fix_manifest=False):
    d = os.path.join(TEST_OUT, "req_" + name); shutil.copytree(REQ, d)
    r = json.load(open(os.path.join(d, "request-1.json"))); mutate(r)
    open(os.path.join(d, "request-1.json"), "w", encoding="utf-8").write(json.dumps(r, indent=2, ensure_ascii=False) + "\n")
    if fix_manifest:
        import hashlib
        mf = json.load(open(os.path.join(d, "comparison-manifest.json")))
        mf["rows"][0]["newRequestSha256"] = hashlib.sha256(json.dumps(r, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        json.dump(mf, open(os.path.join(d, "comparison-manifest.json"), "w"))
    return d
cases = [("text", lambda r: r["messages"][0].__setitem__("content", r["messages"][0]["content"] + " "), False, "sha256 mismatch"),
         ("model", lambda r: r.__setitem__("model", "claude-opus-5"), True, "model"),
         ("maxtok", lambda r: r.__setitem__("max_tokens", 8192), True, "max_tokens"),
         ("thinking", lambda r: r.__setitem__("thinking", {"type": "enabled", "budget_tokens": 2000}), True, "thinking"),
         ("system", lambda r: r.__setitem__("system", "x"), True, "system"),
         ("twomsgs", lambda r: r["messages"].append({"role": "assistant", "content": "x"}), True, "exactly one")]
for nm, fn, fix, word in cases:
    d = tampered(nm, fn, fix)
    with Mock(KEY) as m:
        p, out = run("h_" + nm, m, ["--run"], req_dir=d)
        check("h: tampered %s -> refused, nothing paid (%s)" % (nm, word), p.returncode == 1 and m.paid == 0 and word in p.stdout and m.ct_calls == 0, p.stdout[-200:])

# (i) global: other plumbing
bad_mock = Mock(KEY)
r = subprocess.run([sys.executable, "-I", RUNNER, "--run", "--mock-gateway", "http://example.com"], env={**os.environ, "CORPUS_OUTLINE_API_KEY": KEY}, capture_output=True, text=True, stdin=subprocess.DEVNULL)
check("mock-gateway to non-local host refused", r.returncode == 2 and "refused" in r.stdout)
r = subprocess.run([sys.executable, "-I", RUNNER, "--run"], env={k: v for k, v in os.environ.items() if k != "CORPUS_OUTLINE_API_KEY"}, capture_output=True, text=True, stdin=subprocess.DEVNULL)
check("no key + no tty -> refuses, key never asked via args", r.returncode == 2 and "no key" in r.stdout)
r = subprocess.run([sys.executable, "-I", RUNNER], capture_output=True, text=True)
check("no flags -> help only", r.returncode == 0 and "--dry-check" in r.stdout)

# global: no plan/lesson, never >2 paid, no key anywhere in R/
check("i: every runner invocation saw <=2 paid calls and 0 non-outline (plan/lesson) requests: " + str(max(x[1] for x in STATS)) + " max paid", all(x[1] <= 2 and x[2] == 0 for x in STATS))
leaks = []
for root, _, files in os.walk(HERE):
    for f in files:
        pth = os.path.join(root, f)
        try: data = open(pth, "rb").read()
        except OSError: continue
        for k in KEYS:
            if k.encode() in data: leaks.append((pth, k[:8]))
check("f: key value absent from every file under R/ (incl. captured stdout/stderr, ledgers, summaries, responses)", not leaks, str(leaks))
ledger_paid = sum(len(evs(os.path.join(TEST_OUT, d), "paid_call_sent")) for d in os.listdir(TEST_OUT) if os.path.isdir(os.path.join(TEST_OUT, d)))
print("total paid_call_sent over all scenarios (mock):", ledger_paid)
bad = [l for l, ok in results if not ok]
print("\nRESULT: %d checks, %d failed" % (len(results), len(bad)))
print("ALL RUNNER TESTS PASSED" if not bad else "FAILED: " + "; ".join(bad))
sys.exit(1 if bad else 0)
