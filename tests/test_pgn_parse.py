"""Rota /api/pgn/parse via TestClient (offline).

Não usamos `with TestClient(...)` de propósito: o context manager dispara os
eventos de startup (warmup que baixaria assets do Stockfish). Instanciar direto
mantém o teste offline — só exercitamos a rota de parse.
"""
from fastapi.testclient import TestClient

from backend.app import app

client = TestClient(app)

SCHOLARS_MATE = """[Event "Test"]
[White "A"]
[Black "B"]
[Result "1-0"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0
"""


def test_parse_scholars_mate():
    r = client.post("/api/pgn/parse", json={"pgn": SCHOLARS_MATE})
    assert r.status_code == 200
    data = r.json()
    assert data["headers"]["White"] == "A"
    moves = data["moves"]
    assert len(moves) == 7  # 4 brancas + 3 pretas

    first = moves[0]
    assert first["san"] == "e4"
    assert first["uci"] == "e2e4"
    assert first["color"] == "white"
    assert first["ply"] == 1
    assert first["fen_before"].startswith("rnbqkbnr")

    last = moves[-1]
    assert last["san"] == "Qxf7#"
    assert last["is_checkmate"] is True
    assert last["is_capture"] is True
    assert last["captured_piece"] == "p"

    # Abertura detectada (Italiana / Giuoco) e in_book presente por lance.
    assert data["opening"]["name"]
    assert len(moves[0]["in_book"]) if isinstance(moves[0].get("in_book"), list) else True
    assert all("in_book" in m for m in moves)


def test_parse_pgn_vazio_400():
    r = client.post("/api/pgn/parse", json={"pgn": "   "})
    assert r.status_code == 400
