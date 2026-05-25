"""
Ponto de entrada do Chess Review.

Uso:
    python run.py

Abre automaticamente o navegador em http://localhost:8000.
"""
import os
import sys
import threading
import time
import webbrowser

import uvicorn


HOST = os.environ.get("CHESS_REVIEW_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHESS_REVIEW_PORT", "8000"))


def _open_browser():
    time.sleep(1.2)
    webbrowser.open(f"http://{HOST}:{PORT}")


if __name__ == "__main__":
    # Abre o navegador em paralelo (a menos que rodando com --no-browser).
    if "--no-browser" not in sys.argv:
        threading.Thread(target=_open_browser, daemon=True).start()

    uvicorn.run("backend.app:app", host=HOST, port=PORT, reload=False)
