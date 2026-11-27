import argparse
import http.server
import json
import os
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

STATIC_DIR = Path(__file__).parent / "static"
OPENAI_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-6-luna"
# The choices in the chat panel, each with the reasoning effort to send (None leaves it to the model's
# default; gpt-6.2-astra does not accept "none").
MODELS = {"gpt-6-luna": "none", "gpt-6.2-astra": None}
TEMPLATE_FILE = "card_template.json"
# One <name>.json per whiteboard. The last opened one is kept in its own file rather than taken from
# timestamps, so the layout moves easily to a database later.
DATA_DIR = Path.cwd() / "data"
LAST_FILE = DATA_DIR / "last_whiteboard.txt"
FORBIDDEN = '/\\:*?"<>|'
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
        data = json.loads(Path(path).read_text())
        valid = isinstance(data, dict) and all(
            isinstance(tags, list) and all(isinstance(tag, str) and tag.strip() for tag in tags) for tags in data.values()
        )
        if not valid:
            raise ValueError('expected {"Template name": ["Tag", ...], ...}')
    except (OSError, ValueError) as err:
        return {"templates": {}, "error": f"Could not read {path}: {err}"}
    return {"templates": data}


class StorageError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def board_file(name) -> Path:
    if not isinstance(name, str) or not name.strip() or name != name.strip() or not name.isprintable() or set(name) & set(FORBIDDEN):
        raise StorageError(400, f"A whiteboard name must not be blank or contain any of: {' '.join(FORBIDDEN)}")
    return DATA_DIR / f"{name}.json"


def existing_board_file(name) -> Path:
    path = board_file(name)
    if not path.exists():
        raise StorageError(404, f'There is no whiteboard named "{name}".')
    return path


def write_json(path: Path, data: dict) -> None:
    # Written beside the target and moved into place, so a crash never leaves half a file.
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    os.replace(temp, path)


def last_board() -> str:
    return LAST_FILE.read_text().strip() if LAST_FILE.exists() else ""


def set_last_board(name: str) -> None:
    if name:
        board_file(name)
    LAST_FILE.write_text(name)


def list_boards() -> dict:
    boards = sorted((path.stem for path in DATA_DIR.glob("*.json")), key=str.lower)
    last = last_board()
    return {"boards": boards, "last": last if last in boards else None}


def save_board(name, data: dict, create: bool) -> None:
    path = board_file(name)
    if create and path.exists():
        raise StorageError(409, f'A whiteboard named "{name}" already exists.')
    write_json(path, data)


def rename_board(old, new) -> None:
    source = existing_board_file(old)
    target = board_file(new)
    # On a case-insensitive file system a change of case only finds the same file.
    same = target.exists() and target.samefile(source)
    if target.exists() and not same:
        raise StorageError(409, f'A whiteboard named "{new}" already exists.')
    data = json.loads(source.read_text())
    data["name"] = new
    if same:
        source.rename(target)
    write_json(target, data)
    if not same:
        source.unlink()
    if last_board() == old:
        set_last_board(new)


def delete_board(name) -> None:
    existing_board_file(name).unlink()
    if last_board() == name:
        set_last_board("")


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
            self.send_json(*self.route(method, urllib.parse.urlsplit(self.path).path, body))
        except StorageError as err:
            self.send_json(err.status, error(str(err)))
        except (OSError, ValueError) as err:
            self.send_json(500, error(f"Storage failed: {err}"))

    def route(self, method: str, path: str, body: dict | None) -> tuple[int, dict]:
        ok = (200, {"ok": True})
        if method == "POST" and path == "/api/chat":
            if not {"instructions", "input", "tools"} <= body.keys():
                return 400, error("The request needs instructions, input and tools.")
            return chat(body)
        if method == "GET" and path == "/api/boards":
            return 200, list_boards()
        if method == "POST" and path == "/api/rename":
            rename_board(body.get("from"), body.get("to"))
            return ok
        if method == "PUT" and path == "/api/last":
            set_last_board(body.get("name") or "")
            return ok
        if path.startswith("/api/boards/"):
            name = urllib.parse.unquote(path.removeprefix("/api/boards/"))
            if method == "GET":
                return 200, json.loads(existing_board_file(name).read_text())
            if method in ("POST", "PUT"):
                save_board(name, body, create=method == "POST")
                return ok
            if method == "DELETE":
                delete_board(name)
                return ok
        return 404, error(f"Unknown request {method} {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the detective whiteboard.")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on; 0.0.0.0 allows LAN access")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default 8000)")
    args = parser.parse_args()

    load_dotenv(find_dotenv(usecwd=True))
    DATA_DIR.mkdir(exist_ok=True)
    server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    url = f"http://{host}:{args.port}/"
    print(f"Detective Whiteboard running at {url} (Ctrl+C to stop)", flush=True)
    print(f"Whiteboards are saved in {DATA_DIR}", flush=True)
    if args.host == "0.0.0.0":
        print(f"From other machines on the LAN: http://{lan_address()}:{args.port}/", flush=True)
    if os.environ.get("OPENAI_API_KEY"):
        choices = models()
        print(f"Assistant models: {', '.join(choices['models'])} (default {choices['default']})", flush=True)
    else:
        print("Assistant disabled: OPENAI_API_KEY is not set in .env", flush=True)
    threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
