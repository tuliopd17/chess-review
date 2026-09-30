"""Assets locais, cache HTTP e downloads concorrentes sem acesso à rede."""
import io
import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from backend.app import app
from backend import sf_assets


def test_health_and_home_do_not_download_engine(monkeypatch, tmp_path):
    monkeypatch.setattr(sf_assets, "DATA_DIR", tmp_path)

    def fail(*args, **kwargs):
        raise AssertionError("Health/home não devem acessar a rede")

    monkeypatch.setattr(sf_assets.urllib.request, "urlopen", fail)
    client = TestClient(app)
    assert client.get("/api/health").json()["stockfish_wasm_ready"] is False
    assert client.get("/").status_code == 200


def test_unknown_engine_asset_is_rejected():
    assert TestClient(app).get("/sf/unknown.wasm").status_code == 404


def test_concurrent_downloads_are_shared_and_atomic(monkeypatch, tmp_path):
    filename = "stockfish-18-lite-single.wasm"
    content = b"\x00asm" + b"engine" * 10
    entered = threading.Event()
    release = threading.Event()
    calls = []
    monkeypatch.setattr(sf_assets, "DATA_DIR", tmp_path)
    monkeypatch.setitem(sf_assets.MIN_SIZE_BYTES, filename, 10)

    def download(*args, **kwargs):
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return io.BytesIO(content)

    monkeypatch.setattr(sf_assets.urllib.request, "urlopen", download)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(sf_assets.ensure_downloaded, filename)
        assert entered.wait(2)
        second = pool.submit(sf_assets.ensure_downloaded, filename)
        assert not (tmp_path / filename).exists()
        release.set()
        assert first.result() == second.result() == tmp_path / filename
    assert len(calls) == 1
    assert (tmp_path / filename).read_bytes() == content
    assert len(list(tmp_path.iterdir())) == 1


def test_invalid_cached_wasm_is_not_reported_ready(monkeypatch, tmp_path):
    monkeypatch.setattr(sf_assets, "DATA_DIR", tmp_path)
    monkeypatch.setitem(sf_assets.MIN_SIZE_BYTES, "stockfish-18-lite-single.js", 10)
    monkeypatch.setitem(sf_assets.MIN_SIZE_BYTES, "stockfish-18-lite-single.wasm", 10)
    (tmp_path / "stockfish-18-lite-single.js").write_bytes(b"engine loader" * 3)
    (tmp_path / "stockfish-18-lite-single.wasm").write_bytes(b"<html>error</html>" * 3)
    assert sf_assets.best_available(download=False) is None


def test_vendor_cache_revalidates_and_returns_304():
    client = TestClient(app)
    initial = client.get("/static/vendor/highstock.js")
    assert initial.status_code == 200
    assert "must-revalidate" in initial.headers["Cache-Control"]
    cached = client.get("/static/vendor/highstock.js", headers={"If-None-Match": initial.headers["ETag"]})
    assert cached.status_code == 304
