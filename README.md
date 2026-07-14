# Chess Review

Site: www.chessreview.com.br

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
- **11 classificações** estilo chess.com com ícones próprios: Brilliant, Great, Best, Excellent, Good, Book, Forced, Inaccuracy, Mistake, Blunder, Miss.
- **Detecção de aberturas via base do Lichess** (download automático na primeira execução).
- **Acurácia 0–100** por jogador (mesma fórmula do chess.com).
- **Estimativa de ELO** baseada na acurácia.
- **Eval bar vertical** dinâmico ao lado do tabuleiro (mostra mate como M1, M2…).
- **Tabuleiro com overlays**:
  - Highlight amarelo Lichess nas casas do lance jogado (origem mais leve, destino mais forte).
  - Ícone da classificação no canto superior direito da casa de destino.
  - Setas: verde no melhor lance + vermelha no lance jogado, quando foi imprecisão/erro/capivarada.
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

## Deploy (produção)

Roda no **Google Cloud Run** via Docker. App stateless, sem banco — escala a zero quando não tem tráfego (custo $0 dentro do free tier).

**Deploy contínuo:** todo push na branch `master` dispara um build/deploy automático
no Cloud Run (Cloud Build trigger configurado no Google Cloud). Não precisa rodar
nada à mão — `git push` já sobe pra produção.

> ⚠️ Antes de commitar mudanças de CSS no frontend, rode `npm run build:css` pra
> regenerar o `frontend/tw.css` (Tailwind). O Dockerfile **não** builda o CSS —
> ele consome o `tw.css` já commitado (ver "Build do frontend" abaixo).

Deploy manual (fallback, ou pra primeira configuração):

```bash
# da raiz do repo; o Cloud Build builda o Dockerfile e injeta $PORT
gcloud run deploy chess-review \
  --source . \
  --region southamerica-east1 \
  --allow-unauthenticated \
  --memory 512Mi --cpu 1 \
  --min-instances 0 --max-instances 3
```

URL pública gerada pelo Cloud Run; domínio custom (`www.chessreview.com.br`) servido
via Cloudflare Worker na frente do Cloud Run. O `Dockerfile` é portável (`$PORT` com
fallback 8000), então roda igual em qualquer plataforma de container.

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
│   ├── style.css         # Estilos à mão (paleta/tokens inspirados no chess.com)
│   ├── tw.css            # CSS do Tailwind (BUILDADO/commitado — não editar à mão)
│   ├── styles/
│   │   └── tw.input.css  # Entrada do Tailwind (tokens chess.com como tema)
│   ├── icons.js          # SVGs das classificações
│   ├── engine_wasm.js    # Wrapper do Stockfish WASM (pool de Web Workers)
│   ├── board_init.js     # Bootstrap do cm-chessboard (ESM) -> window.crBoard
│   ├── analysis.js       # Lógica completa de análise da partida (no browser)
│   ├── app.js            # UI principal (importação, navegação, exploração, histórico)
│   └── vendor/           # Libs de terceiros self-hosted (cm-chessboard, chess.js,
│                         #   Highcharts) — servidas same-origin, cache immutable
├── examples/
│   └── kasparov-deep-blue-1997.pgn
├── package.json          # Tooling do build de CSS (Tailwind) — o app é Python
├── requirements.txt
├── run.py                # Ponto de entrada (uvicorn + abre browser)
└── README.md
```

## Build do frontend (CSS / Tailwind)

O CSS é híbrido: o `style.css` escrito à mão é a base (tokens chess.com,
componentes, layout, responsivo) e o **Tailwind v4** entra como camada de
utilitários pra UI nova/alterada. O Tailwind é buildado pela CLI, **purgado** e
servido self-hosted — sem CDN, sem Preflight (não reseta o design existente).

```bash
npm install          # uma vez (instala a CLI do Tailwind como devDependency)
npm run build:css    # gera frontend/tw.css (purgado + minificado)
npm run watch:css    # rebuild automático enquanto desenvolve
```

O `frontend/tw.css` é **commitado** — assim o `Dockerfile` continua só-Python
(não precisa de Node na imagem). Mudou classe de utilitário? Rode `build:css`
antes de commitar. Os tokens do tema vivem em `frontend/styles/tw.input.css` e
**espelham** o `:root` do `style.css` (mude nos dois se mexer numa cor).

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

A lógica replica o **Expected Points Model** do chess.com (Classification V2, e a implementação de referência open-source [WintrCat/freechess](https://github.com/WintrCat/freechess)). Cada lance é classificado pela **queda de probabilidade de vitória** entre a melhor jogada da posição e a jogada efetivamente feita, ambas do ponto de vista de quem moveu. A conversão de centipawns para winrate usa uma sigmoide **dependente do rating do jogador** — como no chess.com oficial ("winning chances based on their rating and the engine evaluation"):

```
winrate = 1 / (1 + exp(-k(rating) × cp))
```

`k(rating)` interpola âncoras públicas: ~0.0028 em Elo baixo (um peão a menos ainda é jogo lá), 0.00368208 no default (coeficiente clássico do Lichess, PR lila#11148) e ~0.006+ para 2300+ na escala **normalizada** do SF 15.1+ (em que +1.00 = 50% de vitória em self-play; o fit de 2022 do Lichess foi feito na escala antiga). Sem rating nos headers, a curva default reproduz o comportamento clássico.

Depois da passada inicial, os lances marcados como blunder/mistake/miss/great/brilliant passam por uma **fase de confirmação em profundidade maior** (posições re-analisadas com +3 de depth) — elimina a maior parte dos falsos blunders de análise rasa, como o Game Review do chess.com também revisa rótulos.

Os limiares (em pontos de win-prob, 0–1) são exatamente os publicados pelo chess.com:

| Categoria   | Queda de win-prob | Notas |
|-------------|-------------------|-------|
| Best        | 0%                | Exatamente o lance nº 1 do engine |
| Excellent   | até 2%            | Praticamente igual ao melhor |
| Good        | até 5%            | Pequena imprecisão tolerável |
| Inaccuracy  | até 10%           | Imprecisão visível |
| Mistake     | até 20%           | Erro |
| Blunder     | acima de 20%      | Capivarada |

Por cima dos limiares vêm as classificações **especiais**, que não dependem só da win-prob:

| Categoria   | Critério |
|-------------|----------|
| Brilliant   | É o melhor lance **e** deixa de propósito uma peça de valor *pendurada* que o oponente pode realmente capturar (sacrifício real, detectado por análise de atacantes/defensores). Não vale se você já ganhava à toa, se ficou pior depois, se estava em xeque ou se é promoção. |
| Great       | Momento crítico em que havia **uma só** jogada à altura (folga grande pro 2º melhor lance), seja punindo um deslize do oponente, seja achando a única continuação que segura/ganha. |
| Book        | Lance ainda dentro da base de aberturas do Lichess. |
| Forced      | Era o **único lance legal** na posição. |
| Miss        | Você tinha um ganho claro (ou mate forçado) e o lance deixou a vitória escapar para igualdade/pior. |

**Transições de mate** são tratadas à parte: largar um mate forçado é punido de acordo com o que sobra no placar (não é "excelente" só porque ainda mostra ~100%), e permitir mate é mais grave quanto mais próximo ele estiver. Há ainda guardas de leniência do chess.com: não é capivarada se você seguia completamente ganho após o lance, nem se já estava completamente perdido antes.

Os **comentários** de cada lance não apenas rotulam — explicam a consequência concreta (perde tal peça, permite mate em N, deixou passar o ganho de material, é o único lance que segura), traduzindo a linha do engine em linguagem humana.

**Acurácia**: `103.1668 × exp(-0.04354 × loss%) - 3.1669` por lance (fórmula aberta do Lichess, na curva fixa — números comparáveis com lichess/chess.com), combinada por média harmônica + média ponderada por volatilidade (o mesmo desenho do CAPS2).

**Estimativa de Elo**: posterior bayesiano sobre a performance da partida — verossimilhança gaussiana da acurácia sobre as curvas **acurácia↔rating por ritmo** (dados GM Larry Kaufman/hissha, chess.com 2023: bullet/blitz/rapid/classical), prior no rating do jogador nos headers do PGN, e conversão de escala lichess↔chess.com (medianas ChessGoals) quando a partida vem do lichess. O resultado sai com **intervalo de credibilidade de 80%** — uma partida só carrega ±300 Elo de incerteza (Regan, *Intrinsic Chess Ratings*, precisa de ~1500 lances para ±100), e esconder isso seria marketing, não medição.

**WDL**: o engine roda com `UCI_ShowWDL` e cada posição carrega probabilidades Win/Draw/Loss do modelo interno do Stockfish (dependente de eval + material); há um port JS exato do `win_rate_model` do SF 18 como fallback.

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
- [cm-chessboard](https://github.com/shaack/cm-chessboard) + [chess.js](https://github.com/jhlywa/chess.js) + [Highcharts Stock](https://www.highcharts.com/) — UI (self-hosted em `frontend/vendor/`)
- [Tailwind CSS](https://tailwindcss.com/) — utilitários do frontend (build self-hosted)
