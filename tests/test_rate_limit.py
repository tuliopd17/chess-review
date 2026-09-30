"""Testes unitários do rate limit / cache em memória."""
import pytest
from backend import rate_limit


def setup_function():
    # Isola estado entre testes.
    with rate_limit._lock:
        rate_limit._hits.clear()
        rate_limit._cache.clear()


def test_cache_roundtrip():
    assert rate_limit.cache_get("k") is None
    rate_limit.cache_set("k", {"games": [1]}, ttl=60)
    assert rate_limit.cache_get("k") == {"games": [1]}


def test_rate_limit_blocks_after_max():
    key = "ip-test"
    for _ in range(rate_limit.RATE_LIMIT_MAX):
        rate_limit.check_rate_limit(key)
    try:
        rate_limit.check_rate_limit(key)
        assert False, "deveria ter estourado o limite"
    except rate_limit.RateLimitExceeded as e:
        assert e.retry_after >= 1


def test_rate_limit_recovers_after_window_and_removes_inactive_clients(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(rate_limit.time, "monotonic", lambda: now[0])
    for _ in range(rate_limit.RATE_LIMIT_MAX):
        rate_limit.check_rate_limit("old-client")
    with pytest.raises(rate_limit.RateLimitExceeded):
        rate_limit.check_rate_limit("old-client")
    now[0] += rate_limit.RATE_LIMIT_WINDOW_S
    rate_limit.check_rate_limit("new-client")
    assert "old-client" not in rate_limit._hits
    rate_limit.check_rate_limit("old-client")


def test_rate_limit_memory_is_bounded(monkeypatch):
    monkeypatch.setattr(rate_limit, "RATE_LIMIT_MAX_KEYS", 3)
    for i in range(10):
        rate_limit.check_rate_limit(f"client-{i}")
    assert len(rate_limit._hits) == 3
    assert "client-9" in rate_limit._hits


def test_cache_expires_at_ttl(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(rate_limit.time, "monotonic", lambda: now[0])
    rate_limit.cache_set("game", [1], ttl=5)
    now[0] += 5
    assert rate_limit.cache_get("game") is None


def test_updating_full_cache_preserves_other_entries(monkeypatch):
    monkeypatch.setattr(rate_limit, "CACHE_MAX_ENTRIES", 2)
    rate_limit.cache_set("first", 1)
    rate_limit.cache_set("second", 2)
    rate_limit.cache_set("second", 3)
    assert rate_limit.cache_get("first") == 1
    assert rate_limit.cache_get("second") == 3
