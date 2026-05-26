"""
API FastAPI do Chess Review.

Toda a análise da partida agora roda no NAVEGADOR via Stockfish WASM.
O backend é responsável por:
  - servir o frontend estático e os arquivos do Stockfish WASM (auto-download)
  - parsear PGN e extrair lista de FENs/UCIs para o JS analisar
  - detectar aberturas via base do Lichess
  - importar partidas do chess.com e do lichess
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

import chess
import chess.pgn
from io import StringIO
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from . import importers
from . import openings
from . import sf_assets


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles que revalida sempre (Cache-Control: no-cache).

    O ETag/Last-Modified continuam valendo, então arquivos inalterados devolvem
    304 (rápido); mas o browser nunca usa uma cópia obsoleta sem checar. Isso
    evita o clássico "editei o JS mas o navegador continua rodando o antigo".
    Os binários do Stockfish NÃO passam por aqui (são servidos por /sf/ com cache
    agressivo próprio, já que têm versão no nome do arquivo).
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app = FastAPI(title="Chess Review", version="0.4.0")


@app.on_event("startup")
async def _startup_warmup():
    # Remove arquivos da versão SF18 lite-single (que quebrava em vários browsers).
    try:
        sf_assets.cleanup_old_files()
    except Exception as e:
        print(f"[startup] cleanup_old_files falhou: {e}")
    # Pré-carrega o índice de aberturas (rápido com cache em disco) pra que a 1ª
    # análise não pague o custo de construção — elimina a demora no primeiro jogo.
    try:
        openings.load()
    except Exception as e:
        print(f"[startup] openings.load falhou: {e}")


class PGNRequest(BaseModel):
    pgn: str


# ===========================================================================
# Health & assets
# ===========================================================================

@app.get("/api/health")
async def health():
    """Versão simplificada — só reporta status dos assets do WASM e openings."""
    sf_filename = sf_assets.best_available()
    return {
        "ok": True,
        "stockfish_wasm_ready": sf_filename is not None,
        "stockfish_wasm_url": f"/sf/{sf_filename}" if sf_filename else None,
        "stockfish_filename": sf_filename,
        "openings_loaded": openings.is_loaded(),
    }


@app.get("/sf/{filename}")
async def sf_asset(filename: str):
    """Serve os arquivos do Stockfish WASM (baixados na primeira execução).

    IMPORTANTE: o Content-Type pro .wasm precisa ser exatamente
    'application/wasm' pra que o browser faça streaming compile (que é mais
    rápido). E pro .js do Worker, alguns browsers recusam Worker que não tenha
    'application/javascript' ou 'text/javascript' — confiamos no media_type
    da FastAPI.
    """
    path = sf_assets.ensure_downloaded(filename)
    if not path or not path.exists():
        raise HTTPException(404, f"Asset '{filename}' não disponível")
    if filename.endswith(".wasm"):
        media = "application/wasm"
    elif filename.endswith(".js"):
        media = "application/javascript"
    else:
        media = "application/octet-stream"
    return FileResponse(
        str(path),
        media_type=media,
        # Cache agressivo — os binários têm versão no nome do arquivo.
        headers={
            "Cache-Control": "public, max-age=86400",
            # Headers úteis pra cross-origin (não bloqueiam nada por padrão).
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


# ===========================================================================
# Parser de PGN
# ===========================================================================

@app.post("/api/pgn/parse")
async def parse_pgn_route(req: PGNRequest):
    """
    Lê um PGN e devolve:
      - headers (dict)
      - moves: lista de {ply, move_number, color, san, uci, from, to,
                          fen_before, fen_after, is_capture, is_check, is_checkmate,
                          captured_piece, in_book}
      - opening: {eco, name, last_book_ply}
    O frontend depois pega cada FEN e manda o Stockfish WASM analisar.
    """
    if not req.pgn or not req.pgn.strip():
        raise HTTPException(400, "PGN vazio")

    try:
        game = chess.pgn.read_game(StringIO(req.pgn))
    except Exception as e:
        raise HTTPException(400, f"PGN inválido: {e}")
    if game is None:
        raise HTTPException(400, "PGN vazio ou inválido")

    headers = dict(game.headers)
    board = game.board()
    moves_data = []
    uci_list = []

    for ply, mv in enumerate(list(game.mainline_moves()), start=1):
        mover = board.turn
        fen_before = board.fen()
        san = board.san(mv)
        uci = mv.uci()
        from_sq = chess.square_name(mv.from_square)
        to_sq = chess.square_name(mv.to_square)

        is_capture = board.is_capture(mv)
        if is_capture:
            if board.is_en_passant(mv):
                captured_piece = "p"
            else:
                cap = board.piece_at(mv.to_square)
                captured_piece = cap.symbol().lower() if cap else None
        else:
            captured_piece = None

        board.push(mv)
        fen_after = board.fen()
        is_check = board.is_check()
        is_checkmate = board.is_checkmate()

        uci_list.append(uci)
        moves_data.append({
            "ply": ply,
            "move_number": (ply + 1) // 2,
            "color": "white" if mover == chess.WHITE else "black",
            "san": san,
            "uci": uci,
            "from": from_sq,
            "to": to_sq,
            "fen_before": fen_before,
            "fen_after": fen_after,
            "is_capture": is_capture,
            "is_check": is_check,
            "is_checkmate": is_checkmate,
            "captured_piece": captured_piece,
        })

    # Detecta abertura.
    op = openings.detect_opening_for_game(uci_list)
    for i, m in enumerate(moves_data):
        m["in_book"] = op["in_book"][i] if i < len(op["in_book"]) else False

    return {
        "headers": headers,
        "moves": moves_data,
        "opening": {
            "eco": op["eco"],
            "name": op["name"],
            "last_book_ply": op["last_book_ply"],
        },
    }


# ===========================================================================
# Imports
# ===========================================================================

@app.get("/api/chesscom/{username}")
async def chesscom_games(username: str, limit: int = 20):
    try:
        games = await importers.fetch_chesscom_recent(username, limit=limit)
        return {"games": games}
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/lichess/{username}")
async def lichess_games(username: str, limit: int = 20):
    try:
        games = await importers.fetch_lichess_recent(username, limit=limit)
        return {"games": games}
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


# ===========================================================================
# Frontend estático
# ===========================================================================

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


def _assets_version() -> str:
    """Versão derivada do mtime mais recente dos arquivos do frontend.

    Usada como query-string (`?v=...`) nas tags de <script>/<link> pra forçar o
    browser a rebaixar os assets sempre que QUALQUER um deles muda — mata o
    problema de cache servindo JS antigo depois de uma edição.
    """
    try:
        latest = max(p.stat().st_mtime for p in FRONTEND_DIR.glob("*") if p.is_file())
        return str(int(latest))
    except ValueError:
        return "0"


if FRONTEND_DIR.exists():
    app.mount("/static", NoCacheStaticFiles(directory=str(FRONTEND_DIR)), name="static")

    @app.get("/")
    async def index():
        html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
        # Acrescenta ?v=<versão> em qualquer href/src que aponte pra /static/
        # (cache-bust dos assets locais; não toca em URLs de CDN).
        v = _assets_version()
        html = re.sub(r'(/static/[^"\']+?\.(?:js|css))', rf"\1?v={v}", html)
        return Response(
            content=html,
            media_type="text/html",
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )
