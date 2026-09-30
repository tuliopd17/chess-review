"""Funções puras de normalização de resultado (sem rede)."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import importers, rate_limit
from backend import app as app_module


def setup_function():
    with rate_limit._lock:
        rate_limit._hits.clear()
        rate_limit._cache.clear()


def test_chesscom_result():
    assert importers._chesscom_result({"white": {"result": "win"}, "black": {"result": "resigned"}}) == "1-0"
    assert importers._chesscom_result({"white": {"result": "checkmated"}, "black": {"result": "win"}}) == "0-1"
    assert importers._chesscom_result({"white": {"result": "agreed"}, "black": {"result": "agreed"}}) == "1/2-1/2"


def test_lichess_result():
    assert importers._lichess_result({"winner": "white"}) == "1-0"
    assert importers._lichess_result({"winner": "black"}) == "0-1"
    assert importers._lichess_result({}) == "1/2-1/2"


def test_chesscom_uses_shared_client_and_skips_unsupported_games():
    urls = []

    def response(request):
        urls.append(str(request.url))
        if request.url.path.endswith("archives"):
            return httpx.Response(200, json={"archives": ["https://api.chess.com/pub/player/a/games/2026/09"]})
        return httpx.Response(200, json={"games": [
            {"url": "standard", "pgn": "1. e4 *", "end_time": 1_700_000_000, "rules": "chess"},
            {"url": "variant", "pgn": "1. e4 *", "rules": "chess960"},
            {"url": "empty", "pgn": ""},
        ]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as shared:
            games = await importers.fetch_chesscom_recent("a", client=shared)
            assert not shared.is_closed
            assert [game["id"] for game in games] == ["standard"]
            assert games[0]["end_time"] == "2023-11-14T22:13:20+00:00"

    asyncio.run(run())
    assert len(urls) == 2


def test_lichess_stream_skips_invalid_lines_and_respects_limit():
    rows = [
        "bad-json",
        json.dumps({"id": "variant", "variant": "atomic", "pgn": "1. e4 *"}),
        json.dumps({"id": "first", "variant": "standard", "pgn": "1. e4 *", "lastMoveAt": 1_700_000_000_000}),
        json.dumps({"id": "second", "pgn": "1. d4 *"}),
    ]

    def response(request):
        assert request.headers["Accept"] == "application/x-ndjson"
        return httpx.Response(200, text="\n".join(rows))

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(response)) as shared:
            games = await importers.fetch_lichess_recent("a", limit=1, client=shared)
            assert [game["id"] for game in games] == ["first"]
            assert games[0]["end_time"] == "2023-11-14T22:13:20+00:00"

    asyncio.run(run())


@pytest.mark.parametrize("error, status", [
    (httpx.ReadTimeout("slow"), 504),
    (httpx.ConnectError("offline"), 502),
    (importers.UserNotFound("Usuário não encontrado"), 404),
    (ValueError("JSON inválido"), 502),
])
def test_import_routes_translate_upstream_failures(monkeypatch, error, status):
    async def fetch(*args, **kwargs):
        raise error

    monkeypatch.setattr(importers, "fetch_chesscom_recent", fetch)
    with TestClient(app_module.app) as client:
        response = client.get("/api/chesscom/test-player")
        assert response.status_code == status


def test_import_routes_translate_upstream_rate_limit(monkeypatch):
    async def fetch(*args, **kwargs):
        request = httpx.Request("GET", "https://lichess.org/api/games/user/a")
        response = httpx.Response(429, request=request, headers={"Retry-After": "120"})
        response.raise_for_status()

    monkeypatch.setattr(importers, "fetch_lichess_recent", fetch)
    with TestClient(app_module.app) as client:
        response = client.get("/api/lichess/test-player")
        assert response.status_code == 503
        assert response.headers["Retry-After"] == "120"


def test_simultaneous_imports_share_one_request_and_populate_cache(monkeypatch):
    calls = []

    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()

        async def fetch(username, *, limit, client):
            calls.append((username, limit, client))
            entered.set()
            await release.wait()
            return [{"id": "game"}]

        monkeypatch.setattr(importers, "fetch_chesscom_recent", fetch)
        async with app_module.app.router.lifespan_context(app_module.app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_module.app), base_url="http://test") as client:
                first = asyncio.create_task(client.get("/api/chesscom/Player"))
                await entered.wait()
                others = [asyncio.create_task(client.get("/api/chesscom/player")) for _ in range(2)]
                await asyncio.sleep(0.01)
                release.set()
                responses = await asyncio.gather(first, *others)
                assert all(response.status_code == 200 for response in responses)
                assert len(calls) == 1
                assert calls[0][0] == "player"
                assert calls[0][2] is app_module.app.state.import_client
                assert sum(response.json()["cached"] for response in responses) == 2
                assert (await client.get("/api/chesscom/player")).json()["cached"]
                assert not app_module.app.state.import_jobs

    asyncio.run(run())


def test_failed_shared_import_can_be_retried(monkeypatch):
    calls = []

    async def fetch(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise importers.UserNotFound("Usuário não encontrado")
        return []

    monkeypatch.setattr(importers, "fetch_lichess_recent", fetch)
    with TestClient(app_module.app) as client:
        assert client.get("/api/lichess/test-player").status_code == 404
        assert client.get("/api/lichess/test-player").status_code == 200
        assert len(calls) == 2


def test_invalid_username_does_not_contact_upstream(monkeypatch):
    async def fetch(*args, **kwargs):
        pytest.fail("Nome inválido não deve chamar o servidor externo")

    monkeypatch.setattr(importers, "fetch_chesscom_recent", fetch)
    response = TestClient(app_module.app).get("/api/chesscom/invalid%20user")
    assert response.status_code == 400
