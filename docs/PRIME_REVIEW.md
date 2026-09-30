# Revisão do prime — 30/09/2026

Foram revisados os 83 commits disponíveis até `f6e3eaf`, incluindo os reverts,
comparando histórico, código, testes e comportamento no navegador. A melhor
base é uma composição dos ganhos de cada fase; um rollback completo perderia
correções úteis e voltaria a problemas já resolvidos.

| Fase | Marcos | Decisão |
| --- | --- | --- |
| Fundação e revisão | `bd4d4cd` → `5604dc3` | Preservar importação, tabuleiro, acurácia e apresentação familiar. |
| Aberturas e primeira carga | `3bff21e`, `c68986e` | Preservar aberturas por posição/transposição e índice pré-carregado. |
| Feedback e navegação | `01371ec` → `4ad771b` | Preservar gráfico, badges, xeque, jogadores e comentários. Sons foram removidos pelo próprio histórico; não recuperá-los automaticamente. |
| Precisão e velocidade | `107d308`, `c83ba5e`, `40d5308`, `3aafbd2`, `4abf959` | Manter Stockfish 18 e revisão padrão em depth 15. A busca por nós havia sido revertida para recuperar velocidade. |
| Distribuição e robustez | `ae72a4d` → `371d367` | Preservar Cloud Run, bibliotecas locais, CSS buildado, testes, recuperação de Workers, IndexedDB e orientação automática. Não restaurar a política de headers que foi revertida após problemas com dependências. |
| Modelo de análise | `7646306` → `97577af` | Preservar classificação por rating, WDL, Elo com incerteza e confirmação dos lances críticos. |
| Recursos de produto | `0e127d6` | Recuperar estilos perdidos de promoção, toasts e seleção multi-PGN; manter exportação e compartilhamento. |
| Experimentos de layout | `b7e86e6` → `c027618` | Avaliar as tentativas de abas, shell fixo, sticky e bottom sheet junto de seus reverts e correções de trepidação. Manter o fluxo sequencial que encerrou esse ciclo. |
| Layout final | `b281e65` → `f6e3eaf` | Manter três colunas no desktop, duas no tablet e uma no celular, importação no topo esquerdo, identidade original e exploração com chess.js restaurado. |

## Melhorias desta versão

- Classificação com cache temporário de movimentos legais, evitando cálculos
  repetidos e preservando as regras. Comparação de 40 posições em três partidas:
  40 rótulos idênticos; 6.428 ms antes e 393 ms depois, aproximadamente 94% menos
  tempo **na classificação JavaScript**. Isso não mede a busca do Stockfish,
  nem representa promessa de igual aceleração da revisão completa.
- Pool de revisão limitado conforme CPU, memória e viewport: um Worker em
  aparelhos com pouca memória ou dois núcleos, até dois no celular e até quatro
  no desktop. Hash reduzido em aparelhos com até 2 GB reportados. Engine ao vivo
  pausada quando a aba está oculta; navegação rápida reaproveita o debounce.
- Workers com recuperação de boot/crash, fila serial, stop com limite e
  descarte de respostas antigas. Busca infinita continua até ser interrompida.
  Após falhas repetidas, a revisão informa erro sem inventar avaliação zero.
- Corridas corrigidas entre cache, parsing, revisão e troca de partida.
  Profundidade e partida compartilhada são capturadas antes das esperas.
  Botão de interrupção mantém lances disponíveis sem salvar resultado parcial.
- Lista incremental sem reatribuir eventos em todos os lances a cada atualização.
  Controles e itens são acessíveis por teclado; atalhos preservam campos de
  edição, seletores, combinações do navegador e modal de promoção.
- Posição inicial, lado a jogar e numeração respeitam PGN com FEN. Exportação
  mantém o prefixo de pretas e links preservam o índice de arquivos multi-PGN.
- Backend tira parsing e downloads do event loop, reutiliza conexões HTTP e
  agrupa consultas de importação iguais. Cache e limitador têm memória limitada.
  Escritas de assets e índice de aberturas são atômicas.
- PGN inválido, variantes incompatíveis e limites excedidos retornam erro.
  Aberturas não são atribuídas falsamente a posições montadas. Arquivos aceitam
  até 2 milhões de caracteres, 501 partidas e 2.000 meios-lances por partida.
- Bibliotecas sem hash na URL revalidam por ETag, permitindo novas versões.
  Stockfish mantém cache longo com seus nomes versionados. CI verifica também
  se o CSS buildado corresponde ao que está commitado.

## Validação

- 86 testes Node de análise, engine e estado da interface aprovados.
- 42 testes Python da API, importações, aberturas, rate-limit e assets aprovados.
- Build Tailwind, sintaxe JavaScript e `git diff --check`.
- Revisão completa com Stockfish real no navegador, resultado incremental,
  resumo, histórico, navegação, retorno da engine ao vivo e posição personalizada
  iniciada no lance 42 pelas pretas. Promoção para cavalo e retorno à partida.
- Interrupção de análise, recuperação do histórico e troca durante a revisão
  em arquivo com dois PGNs. Link da segunda partida reaberto no índice correto.
- Inspeção responsiva em 390, 768, 1100 e 1500 px: tabuleiro quadrado, controles
  acessíveis e ausência de overflow horizontal.

Cache e rate-limit continuam por processo/container. Esta revisão não substitui
uma medição de tráfego real em produção; não foi realizado teste de carga contra
o serviço público.
