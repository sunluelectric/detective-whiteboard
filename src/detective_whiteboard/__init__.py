import argparse
import functools
import http.server
import socket
import threading
import webbrowser
from pathlib import Path

STATIC_DIR = Path(__file__).parent / "static"


def lan_address() -> str:
    # Connecting a UDP socket sends no packets; it only picks the outgoing interface.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "<this machine's IP>"


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the detective whiteboard.")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on; 0.0.0.0 allows LAN access")
    parser.add_argument("--port", type=int, default=8000, help="port to listen on (default 8000)")
    args = parser.parse_args()

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=STATIC_DIR)
    server = http.server.ThreadingHTTPServer((args.host, args.port), handler)
    host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    url = f"http://{host}:{args.port}/"
    print(f"Detective Whiteboard running at {url} (Ctrl+C to stop)", flush=True)
    if args.host == "0.0.0.0":
        print(f"From other machines on the LAN: http://{lan_address()}:{args.port}/", flush=True)
    threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
