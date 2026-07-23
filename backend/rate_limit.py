"""Rate limit + cache em memória (por processo).

Suficiente pro Cloud Run free tier: protege o proxy chess.com/lichess de
abuso básico e evita re-fetch do mesmo usuário em poucos minutos. Em múltiplas
instâncias o limite é por container — melhor que nada, sem Redis.
"""
from __future__ import annotations

import time
from collections import defaultdict
from threading import Lock
from typing import Any, Optional


# Limite de pedidos de import por IP (janela deslizante de 60s).
RATE_LIMIT_MAX = 30
RATE_LIMIT_WINDOW_S = 60.0

# Cache de respostas de import (username+source+limit).
CACHE_TTL_S = 300.0  # 5 minutos
CACHE_MAX_ENTRIES = 256

_lock = Lock()
_hits: dict[str, list[float]] = defaultdict(list)
_cache: dict[str, tuple[float, Any]] = {}


def client_key(request) -> str:
    """IP do cliente (respeita X-Forwarded-For do Cloudflare/Cloud Run)."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    if request.client:
        return request.client.host or "unknown"
    return "unknown"


class RateLimitExceeded(Exception):
    def __init__(self, retry_after: int = 60):
        self.retry_after = retry_after
        super().__init__("Muitas requisições. Tente de novo em instantes.")


def check_rate_limit(key: str) -> None:
    now = time.monotonic()
    with _lock:
        stamps = _hits[key]
        # Descarta timestamps fora da janela.
        cutoff = now - RATE_LIMIT_WINDOW_S
        i = 0
        while i < len(stamps) and stamps[i] < cutoff:
            i += 1
        if i:
            del stamps[:i]
        if len(stamps) >= RATE_LIMIT_MAX:
            oldest = stamps[0] if stamps else now
            retry = max(1, int(RATE_LIMIT_WINDOW_S - (now - oldest)) + 1)
            raise RateLimitExceeded(retry_after=retry)
        stamps.append(now)


def cache_get(key: str) -> Optional[Any]:
    now = time.monotonic()
    with _lock:
        entry = _cache.get(key)
        if not entry:
            return None
        expires, value = entry
        if expires < now:
            del _cache[key]
            return None
        return value


def cache_set(key: str, value: Any, ttl: float = CACHE_TTL_S) -> None:
    now = time.monotonic()
    with _lock:
        if len(_cache) >= CACHE_MAX_ENTRIES:
            # Remove expirados; se ainda cheio, remove o mais antigo.
            expired = [k for k, (exp, _) in _cache.items() if exp < now]
            for k in expired:
                del _cache[k]
            if len(_cache) >= CACHE_MAX_ENTRIES:
                oldest_key = min(_cache, key=lambda k: _cache[k][0])
                del _cache[oldest_key]
        _cache[key] = (now + ttl, value)
