"""
Importa partidas das APIs públicas do chess.com e do lichess.

Ambas as APIs são gratuitas e não exigem autenticação para listar partidas
públicas de um usuário.
"""
from __future__ import annotations

import httpx
from datetime import datetime
from typing import List, Dict


CHESS_COM_BASE = "https://api.chess.com/pub"
LICHESS_BASE = "https://lichess.org/api"

USER_AGENT = "ChessReview/1.0 (open-source community tool)"


async def fetch_chesscom_recent(username: str, limit: int = 20) -> List[Dict]:
    """
    Busca as partidas mais recentes do usuário no chess.com.

    A API do chess.com agrupa partidas por mês. Pegamos o arquivo do mês corrente
    e, se faltar partida, o mês anterior — até atingir `limit`.

    Retorna uma lista de dicts com:
      - id: URL única da partida (usada como ID estável)
      - white, black: nomes dos jogadores
      - result: '1-0', '0-1' ou '1/2-1/2'
      - end_time: timestamp (ISO) do fim da partida
      - time_class: 'rapid', 'blitz', 'bullet', etc.
      - pgn: o PGN completo
    """
    headers = {"User-Agent": USER_AGENT}
    games: List[Dict] = []

    async with httpx.AsyncClient(timeout=20.0, headers=headers) as client:
        # Lista de meses disponíveis (mais recentes primeiro).
        archives_resp = await client.get(f"{CHESS_COM_BASE}/player/{username}/games/archives")
        if archives_resp.status_code == 404:
            raise ValueError(f"Usuário '{username}' não encontrado no chess.com")
        archives_resp.raise_for_status()
        archives = archives_resp.json().get("archives", [])

        # Itera do mais recente ao mais antigo até bater o limite.
        for archive_url in reversed(archives):
            if len(games) >= limit:
                break
            month_resp = await client.get(archive_url)
            month_resp.raise_for_status()
            month_games = month_resp.json().get("games", [])
            # Mais recentes primeiro dentro do mês.
            for g in reversed(month_games):
                if len(games) >= limit:
                    break
                games.append({
                    "id": g.get("url", ""),
                    "white": g.get("white", {}).get("username", "?"),
                    "black": g.get("black", {}).get("username", "?"),
                    "white_rating": g.get("white", {}).get("rating"),
                    "black_rating": g.get("black", {}).get("rating"),
                    "result": _chesscom_result(g),
                    "end_time": datetime.utcfromtimestamp(g.get("end_time", 0)).isoformat() if g.get("end_time") else None,
                    "time_class": g.get("time_class", ""),
                    "pgn": g.get("pgn", ""),
                    "source": "chess.com",
                })
    return games


def _chesscom_result(game: Dict) -> str:
    """Converte resultado do chess.com em '1-0' / '0-1' / '1/2-1/2'."""
    w = game.get("white", {}).get("result", "")
    b = game.get("black", {}).get("result", "")
    if w == "win":
        return "1-0"
    if b == "win":
        return "0-1"
    return "1/2-1/2"


async def fetch_lichess_recent(username: str, limit: int = 20) -> List[Dict]:
    """
    Busca as partidas mais recentes do usuário no lichess.

    A API do lichess retorna PGN em streaming (NDJSON ou texto). Aqui usamos
    a forma JSON streaming para extrair metadados + PGN.
    """
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/x-ndjson",
    }
    params = {
        "max": limit,
        "pgnInJson": "true",
        "moves": "true",
        "tags": "true",
        "clocks": "false",
        "evals": "false",
        "opening": "true",
    }

    games: List[Dict] = []
    async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
        async with client.stream("GET", f"{LICHESS_BASE}/games/user/{username}", params=params) as resp:
            if resp.status_code == 404:
                raise ValueError(f"Usuário '{username}' não encontrado no lichess")
            resp.raise_for_status()
            import json
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    g = json.loads(line)
                except json.JSONDecodeError:
                    continue
                players = g.get("players", {})
                white = players.get("white", {})
                black = players.get("black", {})
                games.append({
                    "id": g.get("id", ""),
                    "white": white.get("user", {}).get("name", "Anonymous"),
                    "black": black.get("user", {}).get("name", "Anonymous"),
                    "white_rating": white.get("rating"),
                    "black_rating": black.get("rating"),
                    "result": _lichess_result(g),
                    "end_time": datetime.utcfromtimestamp(g.get("lastMoveAt", 0) / 1000).isoformat() if g.get("lastMoveAt") else None,
                    "time_class": g.get("speed", ""),
                    "pgn": g.get("pgn", ""),
                    "source": "lichess",
                })
    return games


def _lichess_result(game: Dict) -> str:
    winner = game.get("winner")
    if winner == "white":
        return "1-0"
    if winner == "black":
        return "0-1"
    return "1/2-1/2"
