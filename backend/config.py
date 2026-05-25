"""
Configuração do Chess Review.

A análise é feita pelo Stockfish WASM rodando no navegador — o backend não
precisa mais de Stockfish local. Estes parâmetros são apenas defaults que o
frontend pode ler via /api/health no futuro.
"""
import os

# Profundidade default usada pelo Stockfish WASM no browser.
ANALYSIS_DEPTH = int(os.environ.get("ANALYSIS_DEPTH", "16"))

# MultiPV default (top N linhas analisadas em cada posição).
MULTIPV = int(os.environ.get("MULTIPV", "2"))
