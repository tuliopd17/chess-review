"""Garante que a raiz do repo está no sys.path pra `import backend...` nos testes.

O pacote `backend` mora na raiz; rodando `pytest` da raiz isto normalmente já
funciona, mas fixar aqui deixa o CI e a execução local idênticos.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
