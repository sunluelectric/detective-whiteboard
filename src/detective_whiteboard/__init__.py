import argparse
import http.server
import json
import os
import re
import signal
import socket
import ssl
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

import certifi
from dotenv import find_dotenv, load_dotenv
from pymongo.errors import PyMongoError

from .container import ContainerError, MongoContainer
from .storage import Storage, StorageError

STATIC_DIR = Path(__file__).parent / "static"
OPENAI_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-6-luna"
# The choices in the chat panel, each with the reasoning effort to send (None leaves it to the model's
# default; gpt-6.2-astra does not accept "none").
MODELS = {"gpt-6-luna": "none", "gpt-6.2-astra": None}
TEMPLATE_FILE = "card_template.json"
# MongoDB keeps its files here (see container.py).
MONGO_DIR = Path.cwd() / "data" / "mongo"
DEFAULT_DB_PORT = 27018
# Python from python.org has no CA certificates of its own until its installer script is run.
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def lan_address() -> str:
    # Connecting a UDP socket sends no packets; it only picks the outgoing interface.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "<this machine's IP>"


def error(message: str) -> dict:
    return {"error": {"message": message}}


def models() -> dict:
    """The selectable models and the default, which is OPENAI_MODEL when set."""
    default = os.environ.get("OPENAI_MODEL", DEFAULT_MODEL)
    return {"models": list(MODELS) if default in MODELS else [default, *MODELS], "default": default}


def templates() -> dict:
    """The card templates in card_template.json, found like .env and read on every request so edits apply at once."""
    path = find_dotenv(TEMPLATE_FILE, usecwd=True)
    if not path:
        return {"templates": {}}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        valid = isinstance(data, dict) and all(
            isinstance(tags, list) and all(isinstance(tag, str) and tag.strip() for tag in tags) for tags in data.values()
        )
        if not valid:
            raise ValueError('expected {"Template name": ["Tag", ...], ...}')
    except (OSError, ValueError) as err:
        return {"templates": {}, "error": f"Could not read {path}: {err}"}
    return {"templates": data}


def chat(body: dict) -> tuple[int, dict]:
    """Forwards a Responses API request to OpenAI with the API key, which never reaches the browser.

    Nothing is stored at OpenAI: the whiteboard file holds the chat, and reasoning is returned encrypted
    so the browser can send it back with the next request.
    """
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        return 500, error("OPENAI_API_KEY is not set. Add it to the .env file and restart the app.")
    choices = models()
    model = body.get("model") or choices["default"]
    if model not in choices["models"]:
        return 400, error(f"Model {model} is not one of: {', '.join(choices['models'])}")
    payload = {
        "model": model,
        "instructions": body["instructions"],
        "input": body["input"],
        "tools": body["tools"],
        "store": False,
        "include": ["reasoning.encrypted_content"],
    }
    if effort := MODELS.get(model):
        payload["reasoning"] = {"effort": effort}
    request = urllib.request.Request(
        OPENAI_URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300, context=SSL_CONTEXT) as response:
            text = response.read().decode(errors="replace")
        return 200, json.loads(text)
    except urllib.error.HTTPError as err:
        text = err.read().decode(errors="replace")
        try:
            return err.code, json.loads(text)
        except ValueError:
            return err.code, error(f"OpenAI returned {err.code}: {text[:300]}")
    except (urllib.error.URLError, TimeoutError) as err:
        return 502, error(f"Could not reach OpenAI: {getattr(err, 'reason', err)}")
    except ValueError:
        return 502, error(f"OpenAI returned a reply that is not JSON: {text[:300]}")


class Handler(http.server.SimpleHTTPRequestHandler):
    storage: Storage  # set in main()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def end_headers(self):
        # Without it browsers may keep running old copies of the page and scripts after an update.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status: int, reply: dict) -> None:
        data = json.dumps(reply).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/models":
            self.send_json(200, models())
        elif path == "/api/templates":
            self.send_json(200, templates())
        elif path.startswith("/api/"):
            self.handle_api("GET")
        else:
            super().do_GET()

    def do_POST(self):
        self.handle_api("POST")

    def do_PUT(self):
        self.handle_api("PUT")

    def do_DELETE(self):
        self.handle_api("DELETE")

    def handle_api(self, method: str) -> None:
        # Other web pages can send plain-text requests here without a CORS check, but not JSON ones, and a
        # browser always sends their Origin. Either check alone stops them from spending the API key or
        # changing whiteboards.
        if method != "GET":
            origin = self.headers.get("Origin")
            if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get("Host"):
                self.send_json(403, error("Requests from other sites are not allowed."))
                return
        body = None
        if method in ("POST", "PUT"):
            if self.headers.get_content_type() != "application/json":
                self.send_json(415, error("The request must be JSON."))
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            except ValueError:
                self.send_json(400, error("The request is not valid JSON."))
                return
            if not isinstance(body, dict):
                self.send_json(400, error("The request must be a JSON object."))
                return
        try:
            self.send_json(*self.route(method, self.path, body))
        except StorageError as err:
            self.send_json(err.status, error(str(err)))
        except PyMongoError as err:
            self.send_json(500, error(f"Storage failed: {err}"))

    def route(self, method: str, path: str, body: dict | None) -> tuple[int, dict]:
        if method == "POST" and path == "/api/chat":
            if not {"instructions", "input", "tools"} <= body.keys():
                return 400, error("The request needs instructions, input and tools.")
            return chat(body)
        url = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(url.query)
        storage = self.storage
        # (method, path pattern, handler): the handler gets the IDs in the path and returns the reply.
        routes = [
            ("GET", r"/api/projects", lambda: storage.list()),
            ("POST", r"/api/projects", lambda: {"id": storage.create_project(body.get("name"))}),
            ("POST", r"/api/projects/(\w+)/rename", lambda p: storage.rename_project(p, body.get("name"))),
            ("DELETE", r"/api/projects/(\w+)", lambda p: storage.delete_project(p)),
            ("POST", r"/api/projects/(\w+)/boards", lambda p: {"id": storage.create(p, body, query.get("overwrite") == ["true"])}),
            ("GET", r"/api/boards/(\w+)", lambda b: storage.read(b)),
            ("PUT", r"/api/boards/(\w+)", lambda b: storage.save(b, body)),
            ("DELETE", r"/api/boards/(\w+)", lambda b: storage.delete(b)),
            ("POST", r"/api/boards/(\w+)/rename", lambda b: storage.rename(b, body.get("name"))),
            ("PUT", r"/api/last", lambda: storage.set_last(body.get("board"))),
        ]
        for route_method, pattern, handler in routes:
            match = re.fullmatch(pattern, url.path)
            if method == route_method and match:
                return 200, handler(*match.groups()) or {"ok": True}
        return 404, error(f"Unknown request {method} {url.path}")


def stop_on_signal(signum, frame):
    raise KeyboardInterrupt


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the detective whiteboard.")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on; 0.0.0.0 allows LAN access")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default 8000)")
    parser.add_argument("--db-port", type=int, default=DEFAULT_DB_PORT, help=f"local port for MongoDB (default {DEFAULT_DB_PORT})")
    args = parser.parse_args()

    load_dotenv(find_dotenv(usecwd=True))
    database = MongoContainer(MONGO_DIR, args.db_port)
    try:
        Handler.storage = Storage(database.start())
    except (ContainerError, PyMongoError) as err:
        database.stop()
        raise SystemExit(f"Could not start MongoDB: {err}")
    server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    url = f"http://{host}:{args.port}/"
    print(f"Detective Whiteboard running at {url} (Ctrl+C to stop)", flush=True)
    print(f"Whiteboards are stored in MongoDB ({database.name}, files in {MONGO_DIR})", flush=True)
    if args.host == "0.0.0.0":
        print(f"From other machines on the LAN: http://{lan_address()}:{args.port}/", flush=True)
    if os.environ.get("OPENAI_API_KEY"):
        choices = models()
        print(f"Assistant models: {', '.join(choices['models'])} (default {choices['default']})", flush=True)
    else:
        print("Assistant disabled: OPENAI_API_KEY is not set in .env", flush=True)
    threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    # Closing the terminal or `kill` stop the app like Ctrl+C, so MongoDB is stopped too.
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, stop_on_signal)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        database.stop()
