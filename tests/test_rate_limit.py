"""Testes unitários do rate limit / cache em memória."""
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
