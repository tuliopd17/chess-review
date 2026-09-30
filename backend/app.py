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

import asyncio
import re
from contextlib import asynccontextmanager
from pathlib import Path

import chess
import chess.pgn
import httpx
from io import StringIO
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import importers
from . import openings
from . import rate_limit
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


class VendorStaticFiles(StaticFiles):
    """Libs locais revalidáveis: várias URLs não contêm versão/hash.

    ETag evita transferir novamente as libs inalteradas e permite atualizar
    Highcharts/cm-chessboard sem prender usuários à versão anterior por um ano.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
        return response


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Parsing/IO não devem ocupar o event loop que atende os demais usuários.
    await run_in_threadpool(_startup_warmup)
    async with httpx.AsyncClient(
        headers={"User-Agent": importers.USER_AGENT},
        timeout=httpx.Timeout(30.0, connect=10.0),
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    ) as client:
        app.state.import_client = client
        app.state.import_jobs = {}
        try:
            yield
        finally:
            pending = list(app.state.import_jobs.values())
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            del app.state.import_client
            del app.state.import_jobs


app = FastAPI(title="Chess Review", version="0.6.0", lifespan=_lifespan)


def _startup_warmup():
    # Remove caches de versões antigas (multi-thread SF11 etc).
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


MAX_PGN_CHARS = 2_000_000
MAX_PGN_GAMES = 501
MAX_GAME_PLIES = 2_000


class PGNRequest(BaseModel):
    pgn: str = Field(max_length=MAX_PGN_CHARS)
    # Índice da partida quando o PGN tem várias (0 = primeira).
    game_index: int = Field(default=0, ge=0, le=500)


class _MainlineBuilder(chess.pgn.GameBuilder):
    """Ignora variantes/comentários; a API analisa somente a linha principal."""

    def begin_game(self):
        super().begin_game()
        self.plies = 0

    def begin_variation(self):
        return chess.pgn.SKIP

    def end_variation(self):
        pass

    def visit_comment(self, comment):
        pass

    def visit_move(self, board, move):
        if board.is_variant_end() or not move:
            raise ValueError("Lances nulos não são suportados na análise")
        if self.plies >= MAX_GAME_PLIES:
            raise ValueError(f"Partida excede o limite de {MAX_GAME_PLIES} lances")
        self.plies += 1
        super().visit_move(board, move)

    def handle_error(self, error):
        # python-chess normalmente devolve uma partida truncada com game.errors.
        # Interromper aqui evita analisar um PGN parcialmente inválido.
        raise error


def _read_all_games(pgn_text: str) -> list:
    """Lê todas as partidas de um texto PGN (arquivo multi-game)."""
    games = []
    sio = StringIO(pgn_text)
    while True:
        try:
            game = chess.pgn.read_game(sio, Visitor=_MainlineBuilder)
        except Exception as e:
            raise HTTPException(400, f"PGN inválido: {e}")
        if game is None:
            break
        if len(games) >= MAX_PGN_GAMES:
            raise HTTPException(400, f"PGN excede o limite de {MAX_PGN_GAMES} partidas")
        board = game.board()
        if type(board) is not chess.Board or board.chess960:
            raise HTTPException(400, "Somente partidas de xadrez padrão são suportadas")
        if not board.is_valid():
            raise HTTPException(400, "PGN contém uma posição inicial inválida")
        if not any(game.mainline_moves()):
            raise HTTPException(400, "PGN não contém lances válidos")
        games.append(game)
    return games


def _game_summary(game, index: int) -> dict:
    h = game.headers
    n_moves = sum(1 for _ in game.mainline_moves())
    return {
        "index": index,
        "white": h.get("White", "?"),
        "black": h.get("Black", "?"),
        "result": h.get("Result", "*"),
        "event": h.get("Event", ""),
        "date": h.get("Date", h.get("UTCDate", "")),
        "round": h.get("Round", ""),
        "moves_count": n_moves,
    }


def _parse_game(game) -> dict:
    """Extrai headers, moves (com FENs) e abertura de um game python-chess."""
    headers = dict(game.headers)
    board = game.board()
    initial_fen = board.fen()
    moves_data = []
    uci_list = []

    for ply, mv in enumerate(game.mainline_moves(), start=1):
        mover = board.turn
        move_number = board.fullmove_number
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
            "move_number": move_number,
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

    # Uma posição montada via FEN não começa na posição usada pela base ECO.
    if initial_fen == chess.STARTING_FEN:
        op = openings.detect_opening_for_game(uci_list)
    else:
        op = {"eco": None, "name": None, "last_book_ply": 0, "in_book": []}
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
# Health & assets
# ===========================================================================

@app.get("/api/health")
def health():
    """Versão simplificada — só reporta status dos assets do WASM e openings."""
    sf_filename = sf_assets.best_available(download=False)
    return {
        "ok": True,
        "stockfish_wasm_ready": sf_filename is not None,
        "stockfish_wasm_url": f"/sf/{sf_filename}" if sf_filename else None,
        "stockfish_filename": sf_filename,
        "openings_loaded": openings.is_loaded(),
    }


@app.get("/sf/{filename}")
def sf_asset(filename: str):
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
        # Cache agressivo e immutable — os binários têm versão no nome do arquivo,
        # então uma vez baixados (~10MB do WASM) o browser nunca mais rebaixa nem
        # revalida. 1 ano.
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            # Headers úteis pra cross-origin (não bloqueiam nada por padrão).
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


# ===========================================================================
# Parser de PGN
# ===========================================================================

@app.post("/api/pgn/parse")
def parse_pgn_route(req: PGNRequest):
    """
    Lê um PGN e devolve:
      - headers (dict)
      - moves: lista de {ply, move_number, color, san, uci, from, to,
                          fen_before, fen_after, is_capture, is_check, is_checkmate,
                          captured_piece, in_book}
      - opening: {eco, name, last_book_ply}
      - game_index / games_total / available_games (arquivo multi-partida)

    O frontend depois pega cada FEN e manda o Stockfish WASM analisar.
    """
    if not req.pgn or not req.pgn.strip():
        raise HTTPException(400, "PGN vazio")

    games = _read_all_games(req.pgn)
    if not games:
        raise HTTPException(400, "PGN vazio ou inválido")

    if req.game_index >= len(games):
        raise HTTPException(
            400,
            f"Partida #{req.game_index + 1} não existe (arquivo tem {len(games)} partida(s))",
        )

    game = games[req.game_index]
    parsed = _parse_game(game)
    available = [_game_summary(g, i) for i, g in enumerate(games)] if len(games) > 1 else []

    return {
        **parsed,
        "game_index": req.game_index,
        "games_total": len(games),
        "available_games": available,
    }


# ===========================================================================
# Imports
# ===========================================================================

async def _import_games(source: str, username: str, request: Request, limit: int):
    username = username.strip().lower()
    if not re.fullmatch(r"[a-z0-9_-]{1,64}", username):
        raise HTTPException(400, "Nome de usuário inválido")
    try:
        rate_limit.check_rate_limit(rate_limit.client_key(request))
    except rate_limit.RateLimitExceeded as e:
        raise HTTPException(
            status_code=429,
            detail=str(e),
            headers={"Retry-After": str(e.retry_after)},
        )

    limit = max(1, min(int(limit or 20), 50))
    cache_key = f"{source}:{username}:{limit}"
    cached = rate_limit.cache_get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    async def fetch():
        fetcher = importers.fetch_chesscom_recent if source == "chesscom" else importers.fetch_lichess_recent
        games = await fetcher(username, limit=limit, client=getattr(request.app.state, "import_client", None))
        payload = {"games": games}
        rate_limit.cache_set(cache_key, payload)
        return payload

    try:
        # Pedidos simultâneos do mesmo usuário compartilham uma chamada externa.
        jobs = getattr(request.app.state, "import_jobs", None)
        shared = jobs is not None and cache_key in jobs
        if jobs is None:
            payload = await fetch()
        else:
            if not shared:
                task = asyncio.create_task(fetch())
                jobs[cache_key] = task

                def completed(done):
                    jobs.pop(cache_key, None)
                    # Consome a exceção se o cliente fechar antes do término.
                    if not done.cancelled():
                        done.exception()

                task.add_done_callback(completed)
            payload = await asyncio.shield(jobs[cache_key])
        return {**payload, "cached": shared}
    except importers.UserNotFound as e:
        raise HTTPException(404, str(e))
    except (ValueError, KeyError, TypeError):
        raise HTTPException(502, "O servidor de partidas retornou uma resposta inválida. Tente novamente.")
    except httpx.TimeoutException:
        raise HTTPException(504, "O servidor de partidas demorou para responder. Tente novamente.")
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 429:
            retry = e.response.headers.get("Retry-After", "60")
            raise HTTPException(503, "O servidor de partidas está ocupado. Tente novamente em instantes.",
                                headers={"Retry-After": retry if retry.isdigit() else "60"})
        raise HTTPException(502, "O servidor de partidas está indisponível. Tente novamente.")
    except httpx.RequestError:
        raise HTTPException(502, "Não foi possível conectar ao servidor de partidas. Tente novamente.")


@app.get("/api/chesscom/{username}")
async def chesscom_games(username: str, request: Request, limit: int = 20):
    return await _import_games("chesscom", username, request, limit)


@app.get("/api/lichess/{username}")
async def lichess_games(username: str, request: Request, limit: int = 20):
    return await _import_games("lichess", username, request, limit)


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


VENDOR_DIR = FRONTEND_DIR / "vendor"

if FRONTEND_DIR.exists():
    # Monta /static/vendor antes de /static (Starlette usa a ordem de mounts).
    if VENDOR_DIR.exists():
        app.mount("/static/vendor", VendorStaticFiles(directory=str(VENDOR_DIR)), name="vendor")
    app.mount("/static", NoCacheStaticFiles(directory=str(FRONTEND_DIR)), name="static")

    @app.get("/")
    def index():
        html = (FRONTEND_DIR / "index.html").read_text(encoding="utf-8")
        # Acrescenta ?v=<versão> em qualquer href/src que aponte pra /static/
        # (cache-bust dos assets locais; libs vendor usam ETag para revalidar).
        v = _assets_version()
        html = re.sub(
            r'(/static/(?!vendor/)[^"\']+?\.(?:js|css))', rf"\1?v={v}", html
        )

        # Injeta a URL do engine no <head> server-side. Elimina o roundtrip
        # /api/health no boot do worker (engine_wasm.js lê window.__CR_ENGINE_URL__
        # direto), então o worker sobe imediatamente e o loader já começa a baixar
        # o WASM. (Não usamos <link rel=preload> pro .js/.wasm de propósito: o
        # destino real é "worker"/fetch do Emscripten, e um preload com `as`/CORS
        # divergente causaria download duplicado dos ~10MB. O ganho de latência
        # vem da injeção + cache immutable; preload só depois de medir.)
        sf_filename = sf_assets.best_available(download=False)
        if sf_filename:
            sf_js_url = f"/sf/{sf_filename}"
            inject = f'<script>window.__CR_ENGINE_URL__={sf_js_url!r};</script>\n'
            html = html.replace("</head>", inject + "</head>", 1)

        return Response(
            content=html,
            media_type="text/html",
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )

    # ---------- SEO: robots.txt e sitemap.xml ----------
    # Permite indexação total, aponta o sitemap. Não bloqueia /static/ (Google
    # precisa do JS/CSS pra renderizar a página) nem /sf/ (Stockfish WASM).
    @app.get("/robots.txt", include_in_schema=False)
    async def robots_txt():
        body = (
            "User-agent: *\n"
            "Allow: /\n"
            "Disallow: /api/\n"
            "\n"
            "Sitemap: https://www.chessreview.com.br/sitemap.xml\n"
        )
        return Response(content=body, media_type="text/plain")

    @app.get("/sitemap.xml", include_in_schema=False)
    async def sitemap_xml():
        # Site tem só a home (SPA). Quando adicionar páginas (per-abertura,
        # tutoriais, glossário), inclui aqui — uma <url> por rota.
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
            '  <url>\n'
            '    <loc>https://www.chessreview.com.br/</loc>\n'
            '    <changefreq>weekly</changefreq>\n'
            '    <priority>1.0</priority>\n'
            '  </url>\n'
            '</urlset>\n'
        )
        return Response(content=body, media_type="application/xml")
