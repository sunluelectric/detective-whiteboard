import argparse
import http.server
import json
import os
import socket
import threading
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from dotenv import find_dotenv, load_dotenv

STATIC_DIR = Path(__file__).parent / "static"
OPENAI_URL = "https://api.openai.com/v1/responses"
DEFAULT_MODEL = "gpt-6-luna"
# The choices in the chat panel, each with the reasoning effort to send (None leaves it to the model's
# default; gpt-6.2-astra does not accept "none").
MODELS = {"gpt-6-luna": "none", "gpt-6.2-astra": None}


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
    if MODELS.get(model):
        payload["reasoning"] = {"effort": MODELS[model]}
    request = urllib.request.Request(
        OPENAI_URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return 200, json.load(response)
    except urllib.error.HTTPError as err:
        text = err.read().decode(errors="replace")
        try:
            return err.code, json.loads(text)
        except ValueError:
            return err.code, error(f"OpenAI returned {err.code}: {text[:300]}")
    except (urllib.error.URLError, TimeoutError) as err:
        return 502, error(f"Could not reach OpenAI: {getattr(err, 'reason', err)}")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def send_json(self, status: int, reply: dict) -> None:
        data = json.dumps(reply).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/models":
            self.send_json(200, models())
        else:
            super().do_GET()

    def do_POST(self):
        if self.path != "/api/chat":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_json(*chat(body))


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the detective whiteboard.")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on; 0.0.0.0 allows LAN access")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default 8000)")
    args = parser.parse_args()

    load_dotenv(find_dotenv(usecwd=True))
    server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    url = f"http://{host}:{args.port}/"
    print(f"Detective Whiteboard running at {url} (Ctrl+C to stop)", flush=True)
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
