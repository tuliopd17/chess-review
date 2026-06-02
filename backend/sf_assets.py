"""
Auto-download e cache dos binários do Stockfish (versão browser).

Histórico:
  - v0.3: tentamos `stockfish-18-lite-single` (nmrugg). Quebrava com
    "RuntimeError: unreachable". Na época culpamos instruções WASM avançadas,
    mas os issues oficiais (nmrugg/stockfish.js #101 e #33) mostram que é uma
    CONDIÇÃO DE CORRIDA dos builds single-threaded: dispara quando se manda
    comandos `go` sobrepostos sem esperar o `bestmove` anterior.
  - v0.4: por causa daquele crash, recuamos pra **Stockfish 16 NNUE
    single-threaded** (branch `Stockfish16` do nmrugg) + fallback asm.js.
  - v0.5: o `engine_wasm.js` passou a serializar as análises (fila serial +
    espera o `bestmove` antes do próximo `go`), que é exatamente o workaround
    do crash acima. Com a corrida eliminada, voltamos pro **Stockfish 18
    lite-single** como engine principal (NNUE mais nova/forte, ~7MB,
    single-threaded, sem precisar de SharedArrayBuffer/COOP-COEP). SF16 NNUE e
    asm.js seguem como fallbacks em cascata.

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

# Release oficial do SF18 (única release do nmrugg que traz os binários do SF18).
# O `src/` do repo não tem os arquivos compilados — eles só vêm anexados à
# release. Mirror secundário: pacote npm `stockfish` (arquivos em /bin/).
SF18_RELEASE = "v18.0.0"
SF18_NPM = "18.0.7"

# URLs por arquivo, tentadas em ordem.
ASSET_URLS = {
    # === Stockfish 18 lite-single (escolha principal) ===
    # NNUE mais nova/forte que o SF16. Loader stub ~20 KB + .wasm ~7 MB.
    "stockfish-18-lite-single.js": [
        f"https://github.com/nmrugg/stockfish.js/releases/download/{SF18_RELEASE}/stockfish-18-lite-single.js",
        f"https://unpkg.com/stockfish@{SF18_NPM}/bin/stockfish-18-lite-single.js",
    ],
    "stockfish-18-lite-single.wasm": [
        f"https://github.com/nmrugg/stockfish.js/releases/download/{SF18_RELEASE}/stockfish-18-lite-single.wasm",
        f"https://unpkg.com/stockfish@{SF18_NPM}/bin/stockfish-18-lite-single.wasm",
    ],

    # === Stockfish 16 NNUE single-threaded (fallback) ===
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
    "stockfish-18-lite-single.js": 15_000,     # loader stub (~20 KB)
    "stockfish-18-lite-single.wasm": 5_000_000,  # engine de verdade (~7 MB)
    "stockfish-nnue-16-single.js": 15_000,
    "stockfish-nnue-16-single.wasm": 400_000,
    "stockfish-18-asm.js": 5_000_000,
}

# Combos em ordem de preferência. Precisa de pelo menos UM completo:
#   - SF18 lite-single WASM (.js + .wasm)  <- principal
#   - SF16 NNUE WASM (.js + .wasm)         <- fallback
#   - ASM-JS (.js sozinho)                 <- fallback final (roda em qualquer JS)
REQUIRED_COMBOS = [
    ["stockfish-18-lite-single.js", "stockfish-18-lite-single.wasm"],
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
    """Remove arquivos de versões antigas que ficaram em cache.

    NÃO inclui `stockfish-18-lite-single.*` aqui — a partir da v0.5 esses são a
    engine principal (ver histórico no topo do módulo).
    """
    old = [
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
