"""Rota /api/pgn/parse via TestClient, sem rede."""
import asyncio
import threading

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
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


MULTI_PGN = """[Event "G1"]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0

[Event "G2"]
[White "Carol"]
[Black "Dave"]
[Result "0-1"]

1. d4 d5 2. c4 0-1
"""


def test_parse_multi_game_defaults_to_first():
    r = client.post("/api/pgn/parse", json={"pgn": MULTI_PGN})
    assert r.status_code == 200
    data = r.json()
    assert data["games_total"] == 2
    assert data["game_index"] == 0
    assert data["headers"]["White"] == "Alice"
    assert len(data["available_games"]) == 2
    assert data["available_games"][1]["white"] == "Carol"


def test_parse_multi_game_selects_index():
    r = client.post("/api/pgn/parse", json={"pgn": MULTI_PGN, "game_index": 1})
    assert r.status_code == 200
    data = r.json()
    assert data["game_index"] == 1
    assert data["headers"]["White"] == "Carol"
    assert data["headers"]["Black"] == "Dave"
    # 1. d4 d5 2. c4  → 3 lances
    assert len(data["moves"]) == 3


def test_parse_multi_game_index_out_of_range():
    r = client.post("/api/pgn/parse", json={"pgn": MULTI_PGN, "game_index": 5})
    assert r.status_code == 400


@pytest.mark.parametrize("pgn", [
    "hello world",
    "1. e4 e5 2. Bh6 *",  # SAN ilegal: não pode devolver só os 2 primeiros lances.
    "1. e4 -- *",  # Stockfish/chess.js não analisam lances nulos do PGN.
    '[Variant "Atomic"]\n\n1. e4 e5 *',
    '[SetUp "1"]\n[FEN "8/8/8/8/8/8/8/7K w - - 0 1"]\n\n1. Kh2 *',
])
def test_invalid_or_unsupported_pgn_is_rejected(pgn):
    response = client.post("/api/pgn/parse", json={"pgn": pgn})
    assert response.status_code == 400


def test_pgn_variations_do_not_replace_mainline():
    response = client.post("/api/pgn/parse", json={
        "pgn": "1. e4 {Comentário} (1. d4 d5 (1... Nf6)) e5 2. Nf3 *",
    })
    assert response.status_code == 200
    assert [move["san"] for move in response.json()["moves"]] == ["e4", "e5", "Nf3"]


def test_fen_with_black_to_move_preserves_move_number_and_has_no_false_opening():
    response = client.post("/api/pgn/parse", json={
        "pgn": '[SetUp "1"]\n[FEN "8/8/8/8/8/8/4k3/7K b - - 0 42"]\n\n42... Kf3 43. Kh2 *',
    })
    assert response.status_code == 200
    data = response.json()
    assert [(move["move_number"], move["color"]) for move in data["moves"]] == [(42, "black"), (43, "white")]
    assert data["opening"]["name"] is None
    assert all(not move["in_book"] for move in data["moves"])


def test_pgn_size_is_bounded(monkeypatch):
    response = client.post("/api/pgn/parse", json={"pgn": " " * (app_module.MAX_PGN_CHARS + 1)})
    assert response.status_code == 422


def test_pgn_game_and_move_counts_are_bounded(monkeypatch):
    monkeypatch.setattr(app_module, "MAX_PGN_GAMES", 1)
    assert client.post("/api/pgn/parse", json={"pgn": MULTI_PGN}).status_code == 400
    monkeypatch.setattr(app_module, "MAX_GAME_PLIES", 2)
    assert client.post("/api/pgn/parse", json={"pgn": SCHOLARS_MATE}).status_code == 400


def test_slow_parse_does_not_block_health(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    original_read = app_module._read_all_games

    def slow_read(text):
        started.set()
        assert release.wait(5)
        return original_read(text)

    monkeypatch.setattr(app_module, "_read_all_games", slow_read)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
            parsing = asyncio.create_task(http.post("/api/pgn/parse", json={"pgn": SCHOLARS_MATE}))
            try:
                assert await asyncio.to_thread(started.wait, 2)
                health = await asyncio.wait_for(http.get("/api/health"), timeout=2)
                assert health.status_code == 200
            finally:
                release.set()
            assert (await parsing).status_code == 200

    asyncio.run(run())
