"""
Auto-download e cache dos binários do Stockfish (versão browser).

Histórico:
  - v0.3: tentamos `stockfish-18-lite-single` (nmrugg). Quebra com
    "RuntimeError: unreachable" em alguns browsers/CPUs (provavelmente por
    instruções WASM avançadas — bulk-memory, non-trapping float-to-int — que
    o runtime aborta).
  - v0.4: trocamos pra **Stockfish 16 NNUE single-threaded** (branch
    `Stockfish16` do nmrugg, mais antigo e mais compatível) + fallback
    `stockfish-18-asm.js` (asm.js puro, roda em literalmente qualquer
    browser que rode JS, mais lento mas confiável).

Os arquivos são servidos pelo nosso backend em /sf/ pra evitar CORS.
"""
from __future__ import annotations

import urllib.request
from pathlib import Path
from typing import Optional


DATA_DIR = Path(__file__).resolve().parent / "data" / "sf"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Tag/commit estáveis da branch Stockfish16 do nmrugg.
# Esses arquivos foram testados em produção por anos via Chesskit/eval.bar.
SF16_BRANCH = "Stockfish16"

# URLs por arquivo, tentadas em ordem.
ASSET_URLS = {
    # === Stockfish 16 NNUE single-threaded (escolha principal) ===
    "stockfish-nnue-16-single.js": [
        f"https://cdn.jsdelivr.net/gh/nmrugg/stockfish.js@{SF16_BRANCH}/src/stockfish-nnue-16-single.js",
        f"https://raw.githubusercontent.com/nmrugg/stockfish.js/{SF16_BRANCH}/src/stockfish-nnue-16-single.js",
    ],
    "stockfish-nnue-16-single.wasm": [
        f"https://cdn.jsdelivr.net/gh/nmrugg/stockfish.js@{SF16_BRANCH}/src/stockfish-nnue-16-single.wasm",
        f"https://raw.githubusercontent.com/nmrugg/stockfish.js/{SF16_BRANCH}/src/stockfish-nnue-16-single.wasm",
    ],

    # === Fallback final: ASM.js puro (sem WASM, roda em qualquer browser) ===
    "stockfish-18-asm.js": [
        "https://github.com/nmrugg/stockfish.js/releases/download/v18.0.0/stockfish-18-asm.js",
        "https://cdn.jsdelivr.net/gh/nmrugg/stockfish.js@v18.0.0/src/stockfish-18-asm.js",
    ],
}

# Tamanho mínimo razoável por arquivo.
# IMPORTANTE: o loader `stockfish-nnue-16-single.js` é um STUB pequeno (~25 KB)
# que só carrega o `.wasm` (onde está a engine de verdade). O valor antigo de
# 50 KB rejeitava o loader legítimo, derrubando a app pro fallback asm.js
# (~10x mais lento). O floor agora só serve pra barrar páginas de erro/404.
MIN_SIZE_BYTES = {
    "stockfish-nnue-16-single.js": 15_000,
    "stockfish-nnue-16-single.wasm": 400_000,
    "stockfish-18-asm.js": 5_000_000,
}

# Arquivos OBRIGATÓRIOS pra app funcionar (precisa pelo menos UMA dessas combos:
#   - SF16 NNUE WASM (.js + .wasm), OU
#   - ASM-JS (.js sozinho)
REQUIRED_COMBOS = [
    ["stockfish-nnue-16-single.js", "stockfish-nnue-16-single.wasm"],
    ["stockfish-18-asm.js"],
]


def _looks_valid(filename: str, data: bytes) -> tuple[bool, str]:
    """
    Sanidade do conteúdo baixado (além do tamanho). Pega casos em que o servidor
    devolve 200 com uma página de erro/HTML no lugar do binário.

    Retorna (ok, motivo). `motivo` só é usado quando ok=False.
    """
    if filename.endswith(".wasm"):
        # Todo módulo WASM começa com o magic '\0asm'.
        if data[:4] != b"\x00asm":
            return False, "não é um módulo WASM (magic inválido)"
    elif filename.endswith(".js"):
        # Páginas de erro costumam vir como HTML.
        head = data.lstrip()[:64].lower()
        if head.startswith(b"<!doctype") or head.startswith(b"<html"):
            return False, "conteúdo parece HTML (provável página de erro)"
    return True, ""


def ensure_downloaded(filename: str) -> Optional[Path]:
    """
    Garante que `filename` está disponível em DATA_DIR. Faz download das URLs
    fallback se necessário. Retorna o Path do arquivo (ou None se falhou tudo).
    """
    if filename not in ASSET_URLS:
        return None
    target = DATA_DIR / filename
    min_size = MIN_SIZE_BYTES.get(filename, 10_000)
    if target.exists() and target.stat().st_size > min_size:
        return target

    for url in ASSET_URLS[filename]:
        try:
            print(f"[sf_assets] baixando {filename} de {url} ...")
            req = urllib.request.Request(url, headers={"User-Agent": "chess-review/0.4"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()

            if len(data) <= min_size:
                print(f"[sf_assets] arquivo muito pequeno ({len(data)} bytes), tentando próxima URL")
                continue

            valid, reason = _looks_valid(filename, data)
            if not valid:
                print(f"[sf_assets] download inválido ({reason}), tentando próxima URL")
                continue

            target.write_bytes(data)
            print(f"[sf_assets] OK ({len(data)} bytes)")
            return target
        except Exception as e:
            print(f"[sf_assets] falha {url}: {e}")
            try: target.unlink(missing_ok=True)
            except: pass

    return None


def best_available() -> Optional[str]:
    """
    Retorna o NOME do arquivo .js que o frontend deve usar (já baixado).
    Tenta combos em ordem de preferência. Faz download na hora se necessário.
    """
    for combo in REQUIRED_COMBOS:
        ok = True
        for fn in combo:
            if ensure_downloaded(fn) is None:
                ok = False
                break
        if ok:
            return combo[0]  # primeiro item do combo é o .js
    return None


def are_ready() -> bool:
    """True se pelo menos UM combo está disponível."""
    return best_available() is not None


def cleanup_old_files() -> None:
    """Remove arquivos de versões antigas que ficaram em cache."""
    old = [
        "stockfish-18-lite-single.js",
        "stockfish-18-lite-single.wasm",
        "stockfish.js",
        "stockfish.wasm",
        "stockfish.worker.js",
    ]
    for fn in old:
        p = DATA_DIR / fn
        if p.exists():
            try:
                p.unlink()
                print(f"[sf_assets] removido cache antigo: {fn}")
            except Exception:
                pass
