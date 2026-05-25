"""
Detecção de aberturas usando a base open-source do Lichess.

Na primeira execução, baixa os arquivos a.tsv..e.tsv do repositório
lichess-org/chess-openings e cacheia em backend/data/. As execuções
seguintes carregam do cache local.

Cada linha do TSV tem o formato:
    ECO\tName\tPGN

Indexamos por POSIÇÃO (EPD), não por sequência de lances. O EPD é a parte
"posicional" do FEN (peças + lado a mover + roque + en passant legal), sem os
contadores de lance. Como ele é função pura do estado do tabuleiro, a mesma
posição alcançada por ORDENS DE LANCES DIFERENTES gera a mesma chave — então
transposições são reconhecidas (o casamento por sequência UCI antigo não pegava
isso, e por isso "saía do livro" cedo demais).
"""
from __future__ import annotations

import os
import urllib.request
from pathlib import Path
from typing import Optional, Dict, Tuple

import chess
import chess.pgn
from io import StringIO


DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

OPENINGS_BASE_URL = "https://raw.githubusercontent.com/lichess-org/chess-openings/master"
OPENINGS_FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"]

# Cache em memória: chave = EPD da posição -> (ECO, nome).
# Ex.: o EPD após 1.e4 c6 -> ("B10", "Caro-Kann Defense").
_OPENING_INDEX: Dict[str, Tuple[str, str]] = {}
_LOADED = False
_MAX_PLIES_INDEXED = 0  # linha mais longa indexada — limita a varredura na detecção


def _download_if_missing() -> None:
    """Baixa os 5 arquivos TSV do Lichess se ainda não existirem."""
    for name in OPENINGS_FILES:
        dest = DATA_DIR / name
        if dest.exists() and dest.stat().st_size > 1000:
            continue
        url = f"{OPENINGS_BASE_URL}/{name}"
        try:
            urllib.request.urlretrieve(url, dest)
        except Exception as e:
            # Se falhar, segue sem essa letra — vai degradar para o que tem.
            print(f"[openings] Falha ao baixar {name}: {e}")


def _final_epd_from_pgn(pgn_text: str) -> Tuple[Optional[str], int]:
    """Reproduz o PGN da abertura e devolve (EPD da posição final, nº de plies)."""
    game = chess.pgn.read_game(StringIO(pgn_text))
    if game is None:
        return None, 0
    board = game.board()
    n = 0
    for move in game.mainline_moves():
        board.push(move)
        n += 1
    if n == 0:
        return None, 0
    return board.epd(), n


def _load() -> None:
    """Carrega todos os TSVs em memória. Chamado lazy na primeira consulta."""
    global _LOADED, _MAX_PLIES_INDEXED
    if _LOADED:
        return
    _download_if_missing()

    for name in OPENINGS_FILES:
        path = DATA_DIR / name
        if not path.exists():
            continue
        try:
            with open(path, encoding="utf-8") as f:
                # primeira linha = cabeçalho
                next(f, None)
                for line in f:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) < 3:
                        continue
                    eco, name_, pgn_col = parts[0], parts[1], parts[2]
                    epd, nplies = _final_epd_from_pgn(pgn_col)
                    if epd is None:
                        continue
                    # Indexa a posição FINAL de cada entrada nomeada. Posições
                    # intermediárias que também são entradas nomeadas entram por
                    # conta própria (a base do Lichess é densa em prefixos).
                    _OPENING_INDEX[epd] = (eco, name_)
                    if nplies > _MAX_PLIES_INDEXED:
                        _MAX_PLIES_INDEXED = nplies
        except Exception as e:
            print(f"[openings] erro lendo {name}: {e}")

    _LOADED = True
    print(f"[openings] carregadas {len(_OPENING_INDEX)} aberturas por posição (até {_MAX_PLIES_INDEXED} plies).")


def is_loaded() -> bool:
    """Retorna True se a base de aberturas já foi carregada em memória."""
    return _LOADED and len(_OPENING_INDEX) > 0


def _deepest_match(moves_uci: list[str]) -> Tuple[Optional[Tuple[str, str]], int]:
    """
    Reproduz os lances num tabuleiro e acha a POSIÇÃO nomeada mais profunda que
    aparece na base. Retorna ((eco, nome) ou None, ply 1-indexado dessa posição).
    Casa por EPD, então pega transposições.
    """
    _load()
    board = chess.Board()
    deepest: Optional[Tuple[str, str]] = None
    deepest_ply = 0
    # Posições além da linha mais longa indexada não podem casar.
    limit = min(len(moves_uci), _MAX_PLIES_INDEXED) if _MAX_PLIES_INDEXED else 0
    for i in range(limit):
        try:
            board.push_uci(moves_uci[i])
        except Exception:
            break
        hit = _OPENING_INDEX.get(board.epd())
        if hit:
            deepest = hit
            deepest_ply = i + 1  # ply 1-indexado
    return deepest, deepest_ply


def lookup_after_moves(uci_moves: list[str]) -> Optional[Tuple[str, str]]:
    """
    Dada uma sequência UCI de lances já jogados, retorna (ECO, nome) da abertura
    correspondente à posição mais profunda que ainda bate na base (por POSIÇÃO,
    com transposições). Retorna None se nada bater.
    """
    hit, _ = _deepest_match(uci_moves)
    return hit


def detect_opening_for_game(moves_uci: list[str]) -> dict:
    """
    Para uma partida (lista de UCIs), retorna:
      - eco, name: identificação da abertura na posição nomeada mais profunda
      - last_book_ply: último lance (1-indexado) ainda dentro do livro
      - in_book: lista de booleans, um por lance, indicando se ainda era book

    A fase de livro é contígua até a posição nomeada mais profunda alcançada —
    isso cobre tanto transposições quanto posições intermediárias não nomeadas
    (que ficariam como "buracos" se checássemos cada lance isoladamente).
    """
    hit, last_book_ply = _deepest_match(moves_uci)
    in_book = [i < last_book_ply for i in range(len(moves_uci))]
    return {
        "eco": hit[0] if hit else None,
        "name": hit[1] if hit else None,
        "last_book_ply": last_book_ply,
        "in_book": in_book,
    }
