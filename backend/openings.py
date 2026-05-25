"""
Detecção de aberturas usando a base open-source do Lichess.

Na primeira execução, baixa os arquivos a.tsv..e.tsv do repositório
lichess-org/chess-openings e cacheia em backend/data/. As execuções
seguintes carregam do cache local.

Cada linha do TSV tem o formato:
    ECO\tName\tPGN\tEPD/UCI...

Indexamos por uma chave normalizada da sequência UCI de lances (sem números
nem espaços extras) para lookup rápido O(1).
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

# Cache em memória: chave = sequência de lances UCI separados por espaço.
# Ex: "e2e4 c7c5 g1f3" -> ("B27", "Sicilian Defense: ...").
_OPENING_INDEX: Dict[str, Tuple[str, str]] = {}
_LOADED = False
_MAX_PLIES_INDEXED = 0  # mais longa sequência indexada — limite do lookup


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


def _parse_tsv_pgn_to_uci(pgn_text: str) -> list[str]:
    """Converte a coluna PGN do TSV em lista de UCIs."""
    game = chess.pgn.read_game(StringIO(pgn_text))
    if game is None:
        return []
    board = game.board()
    ucis = []
    for move in game.mainline_moves():
        ucis.append(move.uci())
        board.push(move)
    return ucis


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
                    ucis = _parse_tsv_pgn_to_uci(pgn_col)
                    if not ucis:
                        continue
                    key = " ".join(ucis)
                    _OPENING_INDEX[key] = (eco, name_)
                    if len(ucis) > _MAX_PLIES_INDEXED:
                        _MAX_PLIES_INDEXED = len(ucis)
        except Exception as e:
            print(f"[openings] erro lendo {name}: {e}")

    _LOADED = True
    print(f"[openings] carregadas {len(_OPENING_INDEX)} aberturas (até {_MAX_PLIES_INDEXED} plies).")


def is_loaded() -> bool:
    """Retorna True se a base de aberturas já foi carregada em memória."""
    return _LOADED and len(_OPENING_INDEX) > 0


def lookup_after_moves(uci_moves: list[str]) -> Optional[Tuple[str, str]]:
    """
    Dada uma sequência UCI de lances já jogados, retorna (ECO, nome) da
    abertura correspondente à posição mais profunda que ainda bate na base.
    Retorna None se nenhum prefixo bater (posição já fora do livro).
    """
    _load()
    # Tenta do prefixo mais longo para o mais curto. Limitado a _MAX_PLIES_INDEXED
    # para evitar trabalho inútil.
    for i in range(min(len(uci_moves), _MAX_PLIES_INDEXED), 0, -1):
        key = " ".join(uci_moves[:i])
        if key in _OPENING_INDEX:
            return _OPENING_INDEX[key]
    return None


def detect_opening_for_game(moves_uci: list[str]) -> dict:
    """
    Para uma partida (lista de UCIs), retorna:
      - eco, name: identificação da abertura na posição mais profunda reconhecida
      - last_book_ply: número do último lance (1-indexado) que ainda estava na base
      - in_book: lista de booleans, um por lance, indicando se aquele lance ainda era book
    """
    _load()
    in_book = []
    last_known_eco = None
    last_known_name = None
    last_book_ply = 0

    for i in range(1, len(moves_uci) + 1):
        # Limitamos a busca à profundidade indexada — acima disso é certamente fora do livro.
        if i > _MAX_PLIES_INDEXED:
            in_book.append(False)
            continue
        key = " ".join(moves_uci[:i])
        if key in _OPENING_INDEX:
            in_book.append(True)
            last_known_eco, last_known_name = _OPENING_INDEX[key]
            last_book_ply = i
        else:
            in_book.append(False)

    return {
        "eco": last_known_eco,
        "name": last_known_name,
        "last_book_ply": last_book_ply,
        "in_book": in_book,
    }
