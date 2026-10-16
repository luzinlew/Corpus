#!/usr/bin/env python3
"""Slice the saved outline v3 requests into page chunks (T-033 step A). Free, offline, stdlib only.

Only the INPUT pages are sliced. Prompt prefix, system, model, thinking, max_tokens, block ids/texts/emphasis,
material name and language stay byte-identical to request-1/2.json (verified against comparison-manifest sha256).
  python3 -I make_chunks.py [--requests-dir DIR] [--out DIR]
"""
import argparse, hashlib, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REQ_DIR = os.path.join(os.path.dirname(HERE), "handoff", "outline-v3-comparison")
SLICING = {1: [[1, 2, 3], [4, 5, 6]], 2: [[1, 2, 3], [4, 5, 6], [7, 8], [9, 10]]}   # Lev 2026-10-16
MAX_CALLS, MAX_USD = 7, 0.10


def compact(d):
    return json.dumps(d, separators=(",", ":"), ensure_ascii=False)


def sha(s):
    return hashlib.sha256(s if isinstance(s, bytes) else s.encode("utf-8")).hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--requests-dir", default=DEFAULT_REQ_DIR)
    ap.add_argument("--out", default=os.path.join(HERE, "chunks"))
    a = ap.parse_args(argv)
    man = json.load(open(os.path.join(a.requests_dir, "comparison-manifest.json"), encoding="utf-8"))
    os.makedirs(a.out, exist_ok=True)
    rows = []
    for parent, groups in SLICING.items():
        d = json.load(open(os.path.join(a.requests_dir, "request-%d.json" % parent), encoding="utf-8"))
        mrow = man["rows"][parent - 1]
        if sha(compact(d)) != mrow["newRequestSha256"]:
            sys.exit("request-%d does not match manifest sha256" % parent)
        content = d["messages"][0]["content"]
        prefix, inp_text = content.split("INPUT:\n", 1)
        prefix += "INPUT:\n"
        inp = json.loads(inp_text)
        if compact(inp) != inp_text or set(inp) != {"name", "pages"}:
            sys.exit("request-%d: INPUT is not reproducible as compact JSON {name,pages}" % parent)
        if sha(inp_text) != mrow["inputSha256"]:
            sys.exit("request-%d: input sha mismatch" % parent)
        by_n = {p["n"]: p for p in inp["pages"]}
        flat = [n for g in groups for n in g]
        if flat != [p["n"] for p in inp["pages"]] or len(set(flat)) != len(flat):
            sys.exit("request-%d: slicing %s does not cover pages %s exactly once in order" % (parent, groups, [p["n"] for p in inp["pages"]]))
        for k, g in enumerate(groups, 1):
            sub = {"name": inp["name"], "pages": [by_n[n] for n in g]}          # whole pages, unchanged objects
            req = {k2: d[k2] for k2 in d}                                       # same key order as the original
            req["messages"] = [{"role": "user", "content": prefix + compact(sub)}]
            cid = "%d-%d" % (parent, k)
            body = compact(req)
            open(os.path.join(a.out, "request-%s.json" % cid), "w", encoding="utf-8").write(body)
            blocks = [b for p in sub["pages"] for b in p["blocks"]]
            rows.append({"id": cid, "parent": parent, "file": mrow["file"], "lang": mrow["lang"], "pages": g,
                         "blocks": len(blocks), "blockIdsSha256": sha(compact([b["id"] for b in blocks])),
                         "inputChars": len(compact(sub)), "messageChars": len(req["messages"][0]["content"]),
                         "requestSha256": sha(body), "prefixSha256": sha(prefix)})
        # the chunks together carry exactly the original block list
        all_blocks = [b for g in groups for n in g for b in by_n[n]["blocks"]]
        if compact(all_blocks) != compact([b for p in inp["pages"] for b in p["blocks"]]):
            sys.exit("request-%d: chunk blocks differ from original" % parent)
    cm = {"step": "T-033 A", "sourceManifestRows": [r["newRequestSha256"] for r in man["rows"]], "promptVersion": man.get("newPromptVersion"),
          "slicing": {str(k): v for k, v in SLICING.items()}, "maximumPaidCalls": MAX_CALLS, "maximumUSD": MAX_USD,
          "automaticRetry": False, "plan": False, "lesson": False, "model": "claude-haiku-5-5", "maxTokens": 4096, "rows": rows}
    if len(rows) > MAX_CALLS:
        sys.exit("more chunks than allowed calls")
    json.dump(cm, open(os.path.join(a.out, "chunk-manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for r in rows:
        print("%s %s pages=%s blocks=%d inputChars=%d messageChars=%d sha=%s.." % (r["id"], r["file"], r["pages"], r["blocks"], r["inputChars"], r["messageChars"], r["requestSha256"][:10]))
    print("chunks: %d (limit %d), budget $%.2f" % (len(rows), MAX_CALLS, MAX_USD))


if __name__ == "__main__":
    main()
