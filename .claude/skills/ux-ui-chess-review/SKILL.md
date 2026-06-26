---
name: ux-ui-chess-review
description: UX/UI design guidance for Chess Review — a chess game-analysis web app whose visual identity intentionally mirrors chess.com's Game Review. Use when building, reviewing, or refining any frontend (HTML/CSS/JS) in this repo: cards, board, eval bar, moves list, classifications, loading states, responsiveness. Reconciles Anthropic's "frontend-design" craft principles with the constraint of designing INSIDE an established brand system rather than inventing a new one.
license: MIT
---

# UX/UI for Chess Review

This project is **not** a blank-canvas brand exercise. It is a faithful, free
clone of **chess.com's Game Review**, in pt-BR, made for the community. The
design goal is the opposite of "make it distinctive" — it is **"make it
indistinguishable, in feel, from chess.com, while executing every detail with
studio-grade craft."** Players should feel at home instantly.

So we keep Anthropic's frontend-design *craft bar* (deliberate type, spacing,
motion, hierarchy; no templated AI-slop) but invert one principle: instead of
inventing a signature identity, **the identity is already given — honor it.**

## The house style (do not drift from this)

Source of truth is `frontend/style.css` `:root`. Reuse these tokens; never
hardcode hexes that duplicate them.

- **Surfaces** (chess.com dark wood): `--bg #312e2b`, `--bg-card #272522`,
  `--bg-elevated #3a3835`, hairline borders `rgba(255,255,255,.04)`.
- **Brand green**: `--accent #81b64c` (chess.com green). Primary buttons,
  active states, accuracy numbers, headings. Use it as a *spotlight*, not a wash.
- **Classification palette** (must match chess.com Game Review exactly):
  brilliant `#26c2a3` teal, great `#5c8bb0` blue, best/excellent green ramp,
  book `#a88865` brown, inaccuracy `#f4bf3f` yellow, mistake `#ef9234` orange,
  blunder `#ca3431` red, miss `#e0688a` pink. These colors *are* the product's
  vocabulary — never recolor them, never invent new ones.
- **Radius** `--radius 10px` on cards, 3–6px on inner controls. **Shadow**
  `--shadow-card` (subtle, two-layer). Chess.com is soft, not flat, not glassy.
- **Type**: system stack (`-apple-system, "Segoe UI", Roboto…`) for UI,
  `ui-monospace` for engine lines / PV / numbers. Do **not** import display
  fonts — system UI fonts are part of looking like chess.com. (This is the one
  place we deliberately ignore the generic "avoid Inter/Roboto" rule, because
  matching the host product matters more than novelty here.)

## Principles, ranked for this project

1. **Fidelity over flair.** Before adding anything, ask "does chess.com's review
   screen have this, and does it look like this?" If you're inventing a visual
   the original doesn't have, you're probably drifting. Match their layout DNA:
   board centered with a vertical eval bar on its left, player bars above/below,
   move controls under the board, a scrollable move list at the right, summary +
   accuracy + coach on the side.

2. **The board is the hero.** Everything else is chrome around an always-square
   board (`aspect-ratio:1/1`). Protect its size on every breakpoint; let side
   panels shrink/stack first. Overlays (last-move highlight, check pulse,
   classification badge, best/played arrows) must survive resize and flip.

3. **Classifications carry the meaning.** The colored badge + icon on the
   destination square, the colored label in the move list, and the dot on the
   eval chart must all use the *same* class color for the *same* move. Consistency
   here is the whole UX — a "Brilliant" must read teal everywhere.

4. **Make the wait legible.** The heaviest cost is client-side: ~10 MB Stockfish
   WASM on first visit, then per-position analysis. Never leave the user staring
   at a silent screen. Always show: engine boot state, an inviting empty/onboard
   state on the board before import, and incremental progress (the moves classify
   as the WASM finishes each position — surface that, don't batch it).

5. **Deliberate, sparse motion.** Match chess.com's restraint: badge pop-in
   (`cr-badge-pop`), check pulse, eval-bar height transition, 200 ms piece
   animation. That's the whole motion budget. No decorative parallax, no
   gratuitous fades. Respect `prefers-reduced-motion`.

6. **Touch & responsive are first-class.** Real users open this on a phone
   mid-game. ≥44px touch targets, `touch-action: manipulation` to kill
   double-tap zoom, 16px inputs to stop iOS focus-zoom, single-column reflow
   ≤1100px that reorders to the natural reading flow (import → board → moves →
   summary). Test at 390px.

## Styling stack: Tailwind v4 (hybrid) + hand-written CSS

The project uses **both**, on purpose:

- **`frontend/style.css`** — the hand-written base: the `:root` tokens, every
  existing component (board, cards, eval bar, moves list, classifications,
  player bars, live engine), layout/grid, responsive breakpoints, keyframes.
  This stays the source of truth for anything the JS toggles by semantic class
  (`.move-cell.active`, `.cls-label.brilliant`, `.engine-status.ready`, …).
- **Tailwind v4 utilities** (`frontend/tw.css`, built, self-hosted) — for **new
  or changed UI**. Build is `npm run build:css` (input `frontend/styles/tw.input.css`,
  output committed `frontend/tw.css`). **No Preflight** is imported, so Tailwind
  does NOT reset the existing design. style.css is unlayered → it wins over
  Tailwind's layered utilities, so existing components are safe.

Rules when using Tailwind here:
- Use the **token utilities**, not raw colors: `text-accent`, `bg-card`,
  `bg-elevated`, `text-muted`, `text-ink`, `text-brilliant`/`-blunder`/…,
  `rounded-card`. These map to the chess.com tokens via `@theme` in
  `tw.input.css`, which **mirrors `style.css :root`** — if you change a color in
  one, change it in the other. Never introduce a raw hex utility (`bg-[#aabbcc]`)
  that duplicates a token.
- After adding/removing utility classes, **rebuild** (`npm run build:css`) so the
  purge picks them up. The Dockerfile stays Python-only — `tw.css` is committed.
- Don't try to drive JS state with utilities; keep stateful styling as semantic
  classes in style.css. Tailwind is for static structure/presentation.

## Working checklist (run before declaring UI "done")

- [ ] New colors come from `:root` tokens, not fresh hexes.
- [ ] Square board preserved at 390px, 768px, 1100px, 1500px.
- [ ] Every interactive element has `:focus-visible` and a ≥44px touch target.
- [ ] Loading/empty/error states exist and are styled (no blank or raw text).
- [ ] Motion ≤ the existing budget; honors `prefers-reduced-motion`.
- [ ] Same move → same classification color across board, list, chart.
- [ ] No layout shift when async content (chart, coach, summary) arrives.
- [ ] pt-BR copy, sentence case, warm but concise — like the rest of the app.
- [ ] Contrast ≥ 4.5:1 for text on `--bg`/`--bg-card`.

## Anti-patterns (these are "AI slop" here)

- Purple/indigo gradients, glassmorphism, neon glow — none of this is chess.com.
- Centering everything; uniform pill-rounding on every element.
- Recoloring classifications or the green to "freshen it up."
- Importing a Google Font to look "designed."
- Heavy entrance animations, skeleton everything, toast spam.
- Blocking first paint on libs only needed later (e.g. the eval chart lib).

## Process (mirror of Anthropic frontend-design, adapted)

1. **Locate the analog.** Find the equivalent surface on chess.com Game Review.
   Note its layout, color, density, and motion.
2. **Plan against tokens.** Decide which existing `:root` tokens and existing
   components you reuse. Only introduce a new token if chess.com clearly has a
   distinct treatment we lack.
3. **Critique for drift.** Before coding, check the plan against the
   anti-patterns and the "fidelity over flair" test.
4. **Build, then verify in a real browser** at multiple widths with the preview
   tools; confirm states (empty/loading/error/success) and that overlays track
   resize/flip. Screenshot as proof.

## Reference

- Anthropic frontend-design skill (craft bar, deliberate type/motion, anti-slop):
  https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md
- chess.com Game Review — the visual target.
- Local source of truth: `frontend/style.css` (`:root`), `frontend/index.html`,
  `frontend/board_init.js`.
