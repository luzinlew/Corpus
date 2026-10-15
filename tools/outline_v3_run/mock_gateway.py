#!/usr/bin/env python3
"""Local mock of the three Anthropic endpoints used by run_outline_v3.py (127.0.0.1 only; for tests)."""
import json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Mock:
    def __init__(self, key, count_tokens=(10000, 5000), messages=("ok", "ok"), models_status=200, hang_seconds=3.0):
        self.key, self.count_tokens, self.messages = key, list(count_tokens), list(messages)
        self.models_status, self.hang_seconds = models_status, hang_seconds
        self.log = []            # (method, path, authorized, kind)
        self.paid = 0            # POST /v1/messages received
        self.non_outline = 0     # messages whose prompt is not an outline (plan/lesson/other)
        self.ct_calls = 0
        mock = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *a): pass
            def _send(self, code, obj, extra=None):
                b = (obj if isinstance(obj, str) else json.dumps(obj)).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("request-id", "req_mock_%d" % len(mock.log))
                self.send_header("content-length", str(len(b)))
                for k, v in (extra or {}).items(): self.send_header(k, v)
                self.end_headers(); self.wfile.write(b)
            def _auth(self):
                return self.headers.get("x-api-key") == mock.key and self.headers.get("anthropic-version") == "2023-06-01"
            def _err(self, code, msg):
                self._send(code, {"type": "error", "error": {"type": "authentication_error" if code == 401 else "api_error", "message": msg}})
            def do_GET(self):
                ok = self._auth(); mock.log.append(("GET", self.path, ok, ""))
                if not ok: return self._err(401, "invalid x-api-key: " + (self.headers.get("x-api-key") or ""))   # echoes the key
                if mock.models_status != 200: return self._err(mock.models_status, "models unavailable")
                self._send(200, {"id": "claude-haiku-5-5", "type": "model"})
            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                ok = self._auth()
                if self.path == "/v1/messages/count_tokens":
                    mock.log.append(("POST", self.path, ok, "")); i = mock.ct_calls; mock.ct_calls += 1
                    if not ok: return self._err(401, "invalid")
                    t = mock.count_tokens[min(i, len(mock.count_tokens) - 1)]
                    return self._send(200, {"input_tokens": t})
                if self.path == "/v1/messages":
                    c = (body.get("messages") or [{}])[0].get("content", "")
                    outline = isinstance(c, str) and c.startswith("CORPUS-OUTLINE")
                    mock.log.append(("POST", self.path, ok, "outline" if outline else "other"))
                    i = mock.paid; mock.paid += 1
                    if not outline: mock.non_outline += 1
                    if not ok: return self._err(401, "invalid")
                    mode = mock.messages[min(i, len(mock.messages) - 1)]
                    if mode == "500": return self._err(500, "boom; your key was " + self.headers.get("x-api-key", "") + " (echo)")
                    if mode == "hang":
                        time.sleep(mock.hang_seconds); return
                    if mode == "drop":
                        self.close_connection = True; self.connection.close(); return
                    if mode == "garbage": return self._send(200, "<html>not json</html>")
                    stop = "max_tokens" if mode == "max_tokens" else "end_turn"
                    txt = json.dumps({"topics": [], "knowledge": [], "knowledge_limited": False})
                    return self._send(200, {"id": "msg_mock%d" % i, "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
                        "content": [{"type": "text", "text": txt}], "stop_reason": stop,
                        "usage": {"input_tokens": mock.count_tokens[min(i, len(mock.count_tokens) - 1)], "output_tokens": 1000,
                                  "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}})
                mock.log.append(("POST", self.path, ok, "unexpected")); self._err(404, "no such endpoint")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self): self.thread.start(); return self
    def __exit__(self, *a): self.server.shutdown(); self.server.server_close()


if __name__ == "__main__":
    import os
    with Mock(os.environ.get("MOCK_KEY", "mock-key")) as m:
        print(m.url, flush=True); time.sleep(3600)
