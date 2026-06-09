# Chess Review — imagem de produção
#
# App stateless e leve: o Stockfish roda no NAVEGADOR (WASM), o backend só serve
# o frontend, parseia PGN, detecta aberturas e importa partidas. Sem banco.
#
# Os binários do Stockfish WASM são PRÉ-BAIXADOS no build (passo RUN abaixo), pra
# imagem ficar self-contained e não depender de internet no boot.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 1) Dependências primeiro (camada cacheada — só refaz se requirements mudar)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 2) Código + dados (aberturas .tsv + frontend)
COPY . .

# 3) Pré-baixa os assets pra dentro da imagem (sem depender de download no boot):
#    - Stockfish WASM (NNUE rápido + fallback asm.js)
#    - Base de aberturas do Lichess (.tsv), caso não tenham vindo no COPY
#    Idempotente: se já existem, só valida e segue.
RUN python -c "import backend.sf_assets as s; [s.ensure_downloaded(f) for f in ('stockfish-18-lite-single.js','stockfish-18-lite-single.wasm','stockfish-nnue-16-single.js','stockfish-nnue-16-single.wasm','stockfish-18-asm.js')]; import backend.openings as o; o.detect_opening_for_game(['e2e4']); print('Stockfish WASM:', s.are_ready(), '| aberturas:', o.is_loaded())"

# A plataforma (Render/Railway) injeta a porta via $PORT; fallback 8000 (Fly/local).
ENV PORT=8000
EXPOSE 8000

# Shell-form pra expandir ${PORT}. 1 worker já segura bem (o pesado é client-side);
# aumente com --workers N se precisar de mais concorrência.
CMD uvicorn backend.app:app --host 0.0.0.0 --port ${PORT:-8000}
