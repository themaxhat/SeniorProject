"""
AI Counselor — local web server.

Run it:
    pip install -r requirements.txt
    python app.py

It serves the website from this folder and opens it in your browser.
It listens on 127.0.0.1 only (this computer), which is also what lets the
browser allow microphone access without HTTPS.

Options (environment variables):
    PORT=5050          change the port
    NO_BROWSER=1       don't open a browser window automatically
"""

import os
import threading
import webbrowser
from pathlib import Path

from flask import Flask, abort, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", 5050))     # 5000 is taken by AirPlay on recent macOS

# Only these files are ever served. app.py, requirements.txt and the
# prototype image stay private even though they sit in the same folder.
PUBLIC_FILES = {
    "homepage.html",
    "index.html",
    "style.css",
    "script.js",
    "ui.js",
    "orb.png",
}

app = Flask(__name__, static_folder=None)


@app.route("/")
def home():
    return send_from_directory(BASE_DIR, "homepage.html")


@app.route("/<path:filename>")
def public_file(filename):
    if filename not in PUBLIC_FILES:
        abort(404)
    return send_from_directory(BASE_DIR, filename)


@app.after_request
def add_headers(response):
    # Always fetch fresh files while the frontend is being developed
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    # The microphone may only be used by this site itself
    response.headers["Permissions-Policy"] = "microphone=(self)"
    return response


# ---------------------------------------------------------------------------
# TEAMMATE INTEGRATION AREA
# The AI agent, speech-to-text and text-to-speech are not implemented here.
# When their endpoints are agreed, add the routes below and call them from
# script.js (see the "HOOKS" section at the bottom of that file).
# ---------------------------------------------------------------------------


def open_browser():
    webbrowser.open(f"http://{HOST}:{PORT}/")


if __name__ == "__main__":
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(1.0, open_browser).start()
    print(f"AI Counselor is running at http://{HOST}:{PORT}/  (press Ctrl+C to stop)")
    app.run(host=HOST, port=PORT, debug=False)
