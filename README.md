# Chess Review

Análise gratuita de partidas de xadrez inspirada no **Game Review** do chess.com, feita para a comunidade.

A análise roda **100% no navegador via Stockfish WASM** — você não precisa instalar Stockfish, não precisa de servidor pesado, e os arquivos do engine ficam cacheados na primeira execução. O backend Python só serve o frontend, parseia PGN, identifica aberturas e busca partidas no chess.com / lichess.

## Como funciona

1. Você importa uma partida (PGN colado, arquivo, ou via username chess.com/lichess).
2. O backend parseia o PGN e devolve a lista de lances + FENs + abertura.
3. O navegador, com Stockfish WASM rodando em Web Worker, analisa cada posição e classifica os lances.
4. Resultados aparecem incrementalmente conforme a análise progride.
5. Em qualquer momento você pode **arrastar peças** pra explorar variantes — a engine reanalisa ao vivo.

## Features

- **100% Stockfish WASM no navegador** — não precisa instalar nada de engine. Os ~10MB do Stockfish 18 lite são baixados na primeira execução e ficam em cache.
- **Modo exploração**: arraste qualquer peça no tabuleiro pra criar uma variante. A engine analisa ao vivo. Botão "voltar pra partida" pra retomar.
- **Análise incremental**: lances aparecem classificados conforme o WASM termina cada posição.
- **10 classificações** estilo chess.com com ícones próprios: Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Blunder, Miss.
- **Detecção de aberturas via base do Lichess** (download automático na primeira execução).
- **Acurácia 0–100** por jogador (mesma fórmula do chess.com).
- **Estimativa de ELO** baseada na acurácia.
- **Eval bar vertical** dinâmico ao lado do tabuleiro (mostra mate como M1, M2…).
- **Tabuleiro com overlays**:
  - Highlight amarelo Lichess nas casas do lance jogado (origem mais leve, destino mais forte).
  - Ícone da classificação no canto superior direito da casa de destino.
  - Setas: verde no melhor lance + vermelha no lance jogado, quando foi imprecisão/erro/capote.
- **Painel de engine ao vivo**: top 3 linhas (MultiPV), profundidade, nodes/sec — estilo Lichess.
- **Coach card**: pontos-chave da partida em português + lances críticos clicáveis.
- **Histórico local**: análises ficam salvas no localStorage por hash do PGN.
- **Navegação por teclado**: ◀/▶, Home/End, F pra girar tabuleiro.

## Pré-requisitos

1. **Python 3.10+** (só pra rodar o backend que serve o frontend)
2. Acesso à internet **na primeira execução** (pra baixar Stockfish WASM + base de aberturas)

Não precisa de Stockfish instalado no PC!

## Instalação

```bash
git clone <este-repo> chess-review
cd chess-review
python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows (PowerShell):
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Como rodar

```bash
python run.py
```

O navegador abre automaticamente em <http://localhost:8000>. Para rodar sem abrir o browser:

```bash
python run.py --no-browser
```

### Primeira execução

Na primeira vez, o backend baixa automaticamente:

- **Stockfish 18 lite WASM** (~10MB) do release oficial do `nmrugg/stockfish.js`
- **Base de aberturas open-source do Lichess** (~1MB de TSV)

Ambos ficam em cache em `backend/data/`. Sem internet na primeira execução, o app ainda funciona mas a parte de análise e detecção de abertura ficam indisponíveis.

### Variáveis opcionais

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `ANALYSIS_DEPTH` | `16` | Profundidade padrão do Stockfish WASM |
| `MULTIPV` | `2` | Quantas linhas analisar por posição |
| `CHESS_REVIEW_HOST` | `127.0.0.1` | Host do servidor |
| `CHESS_REVIEW_PORT` | `8000` | Porta do servidor |

## Estrutura do projeto

```
chess-review/
├── backend/
│   ├── app.py            # API FastAPI (parse PGN, aberturas, imports, serve frontend e WASM)
│   ├── config.py         # Configuração (defaults de análise)
│   ├── openings.py       # Detecção de aberturas via base do Lichess (auto-download)
│   ├── sf_assets.py      # Auto-download do Stockfish WASM
│   ├── importers.py      # Import via APIs do chess.com e lichess
│   └── data/             # Cache de aberturas e WASM (gerado em runtime)
├── frontend/
│   ├── index.html        # UI single-page
│   ├── style.css         # Estilos (paleta inspirada no chess.com)
│   ├── icons.js          # SVGs das classificações
│   ├── engine_wasm.js    # Wrapper do Stockfish WASM
│   ├── analysis.js       # Lógica completa de análise da partida (no browser)
│   └── app.js            # UI principal (importação, navegação, exploração, histórico)
├── examples/
│   └── kasparov-deep-blue-1997.pgn
├── requirements.txt
├── run.py                # Ponto de entrada (uvicorn + abre browser)
└── README.md
```

## API do backend

| Método | Rota | Descrição |
|--------|------|-----------|
| GET    | `/api/health` | Estado do backend e dos assets |
| GET    | `/sf/{filename}` | Serve os arquivos do Stockfish WASM |
| POST   | `/api/pgn/parse` | Parseia PGN e devolve lances + FENs + abertura |
| GET    | `/api/chesscom/{user}?limit=20` | Partidas recentes do chess.com |
| GET    | `/api/lichess/{user}?limit=20` | Partidas recentes do lichess |

A análise em si **não** é feita no backend — só no navegador.

## Como funciona a classificação

Cada lance é classificado comparando a *probabilidade de vitória* da posição antes e depois do lance jogado, contra a melhor jogada do engine. A conversão de centipawns para winrate usa a sigmoide do Lichess:

```
winrate = 1 / (1 + exp(-0.00368208 × cp))
```

| Categoria   | Queda de winrate | Notas |
|-------------|-------------------|-------|
| Brilliant   | até 2%            | + sacrifício real detectado por análise de troca, posição equilibrada |
| Great       | 0%                | Único lance que mantém a vantagem (gap > 2 peões para a 2ª melhor opção) |
| Best        | 0%                | Exatamente o lance do engine |
| Excellent   | até 2%            | Praticamente igual ao melhor |
| Good        | até 5%            | Pequena imprecisão tolerável |
| Book        | —                 | Lance ainda dentro da base de aberturas do Lichess |
| Inaccuracy  | até 10%           | Imprecisão visível |
| Mistake     | até 20%           | Erro |
| Blunder     | acima de 20%      | Capote |
| Miss        | —                 | Oponente errou e o jogador não puniu |

Acurácia: `103.1668 × exp(-0.04354 × loss%) - 3.1669` (mesma fórmula do chess.com).

## Roadmap

- Suporte a análise em lote (várias partidas)
- Export do PGN com comentários do engine (`{[%eval ...]}` + classificações)
- Tradução para outras línguas
- Modo "Coach guiado" passo-a-passo
- Tema claro/escuro
- Versão multi-thread do Stockfish WASM (precisa de COOP/COEP — opcional)

Contribuições bem-vindas!

## Inspiração e referências

- [Chesskit](https://github.com/GuillaumeSD/Chesskit) (Next.js/TypeScript)
- [OpenChess-Insights](https://github.com/LinkAnJarad/OpenChess-Insights) (Python/Flask)
- [eval.bar](https://github.com/goodvibs/eval.bar) (Stockfish WASM)
- chess.com Game Review — inspiração de UX

## Licença

MIT. Use, compartilhe e melhore.

## Créditos

- [Stockfish](https://stockfishchess.org/) — o engine
- [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js) — build WASM (GPLv3)
- [python-chess](https://python-chess.readthedocs.io/) — parser PGN
- [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) — base de aberturas
- [chessboard.js](https://chessboardjs.com/) + [chess.js](https://github.com/jhlywa/chess.js) + [Chart.js](https://www.chartjs.org/) — UI
