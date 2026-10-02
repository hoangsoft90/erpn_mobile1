"""HTTP bridge: vietnamese_nlp.normalize() over localhost (user decision 2026-09-13).

The bridge decision is LOCKED: Python (vietnamese_nlp) talks to Node (dsh plugin
/ skill layer) over a LOCAL HTTP service — no Dart/JS port, no subprocess.
This module is the Python side of that bridge.

Design constraints (deliberate):
- stdlib only (http.server) — the project keeps zero runtime dependencies; Flask
  is installed on this machine but adding it buys nothing for two endpoints.
- binds 127.0.0.1 ONLY. The service is a pure text -> JSON function and holds no
  data, but the localhost-only rule is part of the locked bridge decision, so it
  is enforced in code, not by convention.
- GET /health and GET|POST /normalize. Errors return {"ok": false} JSON — never
  a traceback (stdout/stderr are read by humans and by dsh logs).

Run (from repo root):
    python3 -m nlp_service.server                 # port 8787
    python3 -m nlp_service.server --port 0        # ephemeral port (tests)
A ready line  {"ready": true, "port": N}  is printed to stdout once listening.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Make `vietnamese_nlp` importable no matter the cwd (repo_root/src).
_REPO_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_REPO_SRC) not in sys.path:
    sys.path.insert(0, str(_REPO_SRC))

from vietnamese_nlp import normalize  # noqa: E402  (path fix must run first)

MAX_TEXT_LEN = 2000  # one utterance; anything longer is not a voice query

DEFAULT_PORT = int(os.environ.get("NLP_SERVICE_PORT", "8787"))


def _cors(handler: BaseHTTPRequestHandler) -> None:
    """Minimal CORS so the future Flutter-web client can call the bridge too."""
    handler.send_header("Access-Control-Allow-Origin", "http://localhost")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")


class Handler(BaseHTTPRequestHandler):
    server_version = "erpn-nlp-bridge/0.1"

    # --- helpers ---------------------------------------------------------
    def _send_json(self, status: int, payload: dict) -> None:
        body = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        _cors(self)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json(status, {"ok": False, "error": message})

    def _extract_text(self) -> str | None:
        """Pull `text` from query string (GET) or JSON body (POST); None if absent."""
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if qs.get("text"):
            return qs["text"][0]
        if parsed.path == "/normalize" and self.command == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                return None
            raw = self.rfile.read(length) if length else b""
            if not raw:
                return None
            try:
                body = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return None
            return body.get("text") if isinstance(body, dict) else None
        return None

    # --- routes ----------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server API)
        self.send_response(204)
        _cors(self)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json(200, {"ok": True, "service": "vietnamese_nlp", "version": "0.1.0"})
            return
        if path == "/normalize":
            self._handle_normalize()
            return
        self._error(404, f"no such path: {path}")

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        if urlparse(self.path).path == "/normalize":
            self._handle_normalize()
            return
        self._error(404, "POST only supported on /normalize")

    def _handle_normalize(self) -> None:
        text = self._extract_text()
        if text is None:
            self._error(400, "missing required parameter: text (query ?text= or JSON body {\"text\": ...})")
            return
        if len(text) > MAX_TEXT_LEN:
            self._error(400, f"text too long ({len(text)} > {MAX_TEXT_LEN} chars)")
            return
        try:
            result = normalize(text)
        except TypeError as exc:  # non-str input — client bug, report cleanly
            self._error(400, str(exc))
            return
        except Exception as exc:  # never leak a traceback to the caller
            self._error(500, f"normalize failed: {exc}")
            return
        self._send_json(200, {"ok": True, "result": result.to_dict()})

    def log_message(self, fmt: str, *args) -> None:  # keep stdout clean for the ready line
        sys.stderr.write("[nlp-service] %s\n" % (fmt % args))


def main() -> None:
    ap = argparse.ArgumentParser(description="vietnamese_nlp HTTP bridge (localhost only)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="default 8787; 0 = ephemeral (tests)")
    args = ap.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    port = server.server_address[1]
    print(json.dumps({"ready": True, "port": port}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
