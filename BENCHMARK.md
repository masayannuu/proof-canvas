# proof-canvas scale benchmark

Measurements of one renderer across 3 / 12 / 20 / 50 / 100-rule boards plus an embed-mode board.
Reproduce with `node scripts/bench_scale.mjs` (writes `out/bench/results.md`, `results.json`,
`browser.json` and screenshots). The tables below are copied from that output.

## Environment

| Item | Value |
|---|---|
| Machine | Apple M3, macOS (darwin-arm64) |
| Node | v24.22.1 |
| Browser | Headless Chromium 159.0.8154.6 via Playwright 1.65.2 (`uv run --with playwright==1.65.2`) |
| Viewports | 1280x800 and 1440x900; the embed tier at 900x700 |
| Node timings | median of 7 runs per tier |
| Interaction timings | median of 5 runs per interaction and viewport |

## Tiers

| Tier | Board | What it represents |
|---|---|---|
| tier1_3rules | `examples/01_room_booking.board.json` | Small board, compact layout |
| tier1b_escrow | `examples/02_escrow_payout.board.json` with `provenance` and `provenanceNote` removed | 3 modules x 12 rules; exercises the failed badge (`1 failed · 9/12 verified`) |
| tier2_20rules | `examples/03_multi_module_20rules.board.json` | 4 modules x 20 rules, hand-written |
| tier3_50rules | `synth_board.mjs --rules 50 --modules 10 --failed 2 --unverified 8 --seed 50` | Synthetic stress board |
| tier4_100rules | `synth_board.mjs --rules 100 --modules 20 --failed 5 --unverified 20 --seed 100` | Synthetic stress board |
| embed_20rules | example 03 rendered with `--mode embed` | Embedded in a 900x700 frame |

Every board is illustrative: the examples declare `provenance: "sample"` and the synthetic boards
are generated from a seeded PRNG (same bytes on every run). No checker output is involved; the
benchmark measures the renderer, not a verification.

## Method

- **Node:** render with `renderBoardHtml` (payload `auto`), validate with every gate, render
  again and compare bytes (determinism).
- **Browser load:** open the file over `file://`, wait for `window.__proofCanvas.readyAt`, read
  navigation timing and CDP `Performance.getMetrics`, count DOM nodes, console errors, page
  errors and network requests.
- **Layout sweep:** for every rule in every state (normal, bug, fixed) the page is switched to
  that view and probed. The table reports the worst value of:
  - *Min SVG text*: the smallest `font-size` in the figure, in SVG units (the figure is 740 units
    wide), with the on-screen pixel size in parentheses. The renderer never fits text below
    13 units; the benchmark fails if it does.
  - *SVG text overflow*: how far any box label, chip or arrow label leaves its box or pill
    (`getBBox`, SVG units).
  - *Connector overlap*: how far the connector pill between the figure and the preview overlaps
    either card (px).
  - *Clipped labels*: bar labels and values, connector pills and state buttons whose content is
    wider than the element.
  - *Page overflow*: horizontal scroll of the document or the floating toolbar (px).
- **Interactions:** each runs in the page: `t0` -> click / change / input -> forced layout
  (`document.body.offsetHeight`) = **sync**; then the next `requestAnimationFrame` + task =
  **frame**. After each run the inverse action restores the state, so every repetition measures
  the same transition.

## Results: size and Node

| Tier | Rules / modules | Layout | Mode | Badge | HTML (budget) | Payload | bytes/rule | Render ms | Validate ms | Deterministic | Validator |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tier1_3rules | 3 / 0 | compact | standalone | sample | 66.8 KB (100 KB) | JSON | 3293 | 1.52 | 2.94 | yes | PASS |
| tier1b_escrow | 12 / 3 | index | standalone | failed | 111.4 KB (200 KB) | JSON | 3027 | 1.99 | 3.17 | yes | PASS |
| tier2_20rules | 20 / 4 | index | standalone | sample | 137.5 KB (200 KB) | JSON | 3101 | 1.88 | 2.74 | yes | PASS |
| tier3_50rules | 50 / 10 | index | standalone | sample | 244.5 KB (350 KB) | JSON | 3370 | 4.36 | 12.55 | yes | PASS |
| tier4_100rules | 100 / 20 | index | standalone | sample | 117.8 KB (512 KB) | gzip+base64 | 3380 | 37.96 | 22.91 | yes | PASS |
| embed_20rules | 20 / 4 | index | embed | sample | 137.4 KB (200 KB) | JSON | 3101 | 2.92 | 2.68 | yes | PASS |

`bytes/rule` is the raw JSON size of the rules divided by their count. Every tier passes the
validator with zero warnings.

## Results: browser

| Tier | Viewport | DOMContentLoaded ms | App ready ms | DOM nodes | JS heap MB | Views swept | Min SVG text units (px) | SVG text overflow | Connector overlap px | Clipped labels | Page overflow px | Toolbar rows | Index open at load | Errors (console / page) | External requests | CJK chars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tier1_3rules | 1280x800 | 253.3 | 252.9 | 170 | 2 | 9 | 13.9 (13.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1_3rules | 1440x900 | 24.5 | 24.3 | 170 | 2 | 9 | 13.9 (13.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1b_escrow | 1280x800 | 44.3 | 44 | 288 | 2.05 | 36 | 13.1 (9.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1b_escrow | 1440x900 | 35.3 | 35.1 | 288 | 2.05 | 36 | 13.1 (11.4) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier2_20rules | 1280x800 | 34.4 | 34.3 | 339 | 2.18 | 60 | 13.2 (10) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier2_20rules | 1440x900 | 32.7 | 32.5 | 339 | 2.18 | 60 | 13.2 (11.5) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier3_50rules | 1280x800 | 31.7 | 31.6 | 530 | 2.32 | 150 | 13 (9.8) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier3_50rules | 1440x900 | 29.1 | 28.9 | 530 | 2.32 | 150 | 13 (11.3) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier4_100rules | 1280x800 | 7.8 | 35.2 | 852 | 2.43 | 300 | 13 (9.8) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier4_100rules | 1440x900 | 7.3 | 32.9 | 852 | 2.44 | 300 | 13 (11.3) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| embed_20rules | 900x700 | 40.8 | 40.6 | 332 | 2.17 | 60 | 13.2 (13.2) | 0 | 0 | 0 | 0 | 1 | false | 0 / 0 | 0 | 0 |

"Index open at load" is `true` for the compact tier because the flag is simply unused there.

## Results: behavior checks

Pages built only for these checks (`out/bench/check_*.html`).

| Behavior check | Viewport | Result | Detail |
|---|---|---|---|
| corrupted payload shows the error box | 1280x800 | PASS | This board could not be displayed: the board payload is not standard base64. |
| module id "all" vs the all-modules filter | 1440x900 | PASS | module 'all' -> 5 rows, all modules '*' -> 20 rows |
| standalone below 1100 px starts with the index closed | 1024x768 | PASS | indexOpen at load = False |

## Results: interaction latency (ms, sync median; frame in parentheses)

| Tier | Viewport | switch rule | toggle normal/bug/fixed | toggle Evidence | toggle Overview | switch module | filter failed only | search keyword |
|---|---|---|---|---|---|---|---|---|
| tier1_3rules | 1280x800 | 1.4 (frame 14.5) | 1.4 (frame 14.1) | 1.6 (frame 13.8) | 2.3 (frame 16) | n/a | n/a | n/a |
| tier1_3rules | 1440x900 | 1.5 (frame 13.7) | 1.5 (frame 11.7) | 1.6 (frame 15.3) | 2.7 (frame 13.6) | n/a | n/a | n/a |
| tier1b_escrow | 1280x800 | 1.9 (frame 14.7) | 1.7 (frame 14.7) | 2.1 (frame 12.4) | 1.6 (frame 14.7) | 1.7 (frame 12.9) | 1.6 (frame 14.8) | 1.8 (frame 13.2) |
| tier1b_escrow | 1440x900 | 2 (frame 13.1) | 1.8 (frame 13.1) | 2.1 (frame 12.1) | 1.5 (frame 11.8) | 1.9 (frame 11.5) | 1.7 (frame 13.2) | 1.7 (frame 13.1) |
| tier2_20rules | 1280x800 | 2.1 (frame 13.8) | 2.1 (frame 10.7) | 2.3 (frame 10.4) | 2 (frame 10) | 3.7 (frame 14.5) | 1.6 (frame 13.1) | 1.8 (frame 14.7) |
| tier2_20rules | 1440x900 | 2.1 (frame 13.1) | 2.2 (frame 13.5) | 2.2 (frame 13.9) | 1.9 (frame 11.4) | 2 (frame 13.1) | 1.7 (frame 13.8) | 1.8 (frame 12.8) |
| tier3_50rules | 1280x800 | 2.6 (frame 14.1) | 2.5 (frame 13) | 2.7 (frame 14.1) | 3 (frame 13.3) | 1.8 (frame 11.6) | 1.8 (frame 14.9) | 1.9 (frame 13.5) |
| tier3_50rules | 1440x900 | 2.4 (frame 13.3) | 2.8 (frame 13.3) | 3.3 (frame 12.8) | 4.5 (frame 10.7) | 1.9 (frame 12.7) | 1.8 (frame 13.6) | 1.9 (frame 12) |
| tier4_100rules | 1280x800 | 3.8 (frame 12.6) | 3.5 (frame 11.4) | 3.5 (frame 8.5) | 5.3 (frame 12.2) | 1.9 (frame 12.6) | 2.1 (frame 12.4) | 2.3 (frame 10.2) |
| tier4_100rules | 1440x900 | 3.7 (frame 12.1) | 3.5 (frame 12.4) | 4 (frame 10.9) | 5.2 (frame 12.4) | 2 (frame 12.7) | 1.9 (frame 10.2) | 2.2 (frame 11.9) |
| embed_20rules | 900x700 | 1.4 (frame 11.2) | 1.6 (frame 11.9) | 3.2 (frame 10.6) | 2.1 (frame 11.3) | 1.8 (frame 12.6) | 3 (frame 10.1) | 1.7 (frame 9.4) |

## Screenshots

| File | Viewport | Shows |
|---|---|---|
| `out/bench/tier1_3rules.png` | 1440x900 | Compact layout, floating pill bar |
| `out/bench/tier1b_escrow_failed_rule.png` | 1440x900 | Failed badge; the failed rule in its bug state with the evidence panel open |
| `out/bench/tier2_20rules_overview.png` | 1440x900 | Module overview |
| `out/bench/tier2_20rules_detail.png` | 1440x900 | One rule in focus; a two-line box label ("Return HTTP 409 Conflict") |
| `out/bench/tier2_20rules_detail_evidence.png` | 1440x900 | A failed rule with the evidence panel open |
| `out/bench/tier3_50rules_filtered.png` | 1440x900 | Status filter = Failed |
| `out/bench/tier3_50rules_empty_search.png` | 1440x900 | Empty state in the index and the detail pane |
| `out/bench/tier4_100rules_overview.png` | 1440x900 | 20-module overview |
| `out/bench/tier4_100rules_failed_overview.png` | 1440x900 | Overview filtered to failed rules |
| `out/bench/embed_20rules_900.png` | 900x700 | Embed mode: one-row toolbar, index closed, stacked cards |

## Analysis

### What scales well

- **Load.** Every page is interactive in under 45 ms, except the very first page this browser
  process opened (tier1 at 1280x800: 253 ms in this run, 35.7 ms in the previous one), which
  looks like a cold start. Plain-JSON boards are ready when DOMContentLoaded fires; the gzip
  board adds about 26-27 ms for `DecompressionStream` and `JSON.parse` (tier4: DOMContentLoaded
  7.3-7.8 ms, App ready 32.9-35.2 ms).
- **DOM and memory.** Nodes grow roughly linearly with rules (170 -> 852) and the heap stays at
  2.0-2.4 MB.
- **Layout.** Across 1,170 swept views (every rule in every state, every viewport) no figure
  text leaves its box, no connector pill touches a card, no label is clipped, the page never
  scrolls sideways and the toolbar stays on one row, including at 900x700 in embed mode.
- **Latency.** The worst sync median is 5.3 ms (Overview at 100 rules). "frame" values (about
  8-16 ms) are dominated by waiting for the next animation frame, not by work.

### Bottlenecks

1. **Payload dominates file size beyond about 15 rules.** At tier4 the HTML is 37.0 KB payload
   (gzip + base64), 36.1 KB JS, 32.3 KB CSS and 6.5 KB `<noscript>` text; the compact layout
   ships 28.5 KB JS and 22.0 KB CSS. The same 100-rule board as plain JSON is 415.1 KB, under
   the 512 KB limit; 200 rules are 749.2 KB as plain JSON and 177.2 KB with gzip, which is why
   `auto` switches to gzip above 192 KB (covered by a self-test).
2. **Full re-render of the index.** The index is rebuilt with `innerHTML` on every state
   change, so its cost is linear in rule count: switch rule and Overview go from about 2 ms at
   20 rules to 3.7-5.3 ms at 100. That is fine up to a few hundred rules; above about 1,000 rules
   the index would need virtualization or keyed updates. This is an extrapolation: 1,000+ rules
   were not measured.
3. **Node render time is gzip.** tier4 renders in 22-38 ms (two runs) against 1.5-4.4 ms for
   the JSON tiers; most of the difference is `gzipSync` at level 9.
4. **Small text at 1280 wide.** With the rule index open at 1280x800, the focus figure is drawn
   at about 75% scale, so its smallest text (13 units) is 9.8-10 px on screen. At 1440x900 it
   is 11.3 px or more. A layout that keeps the figure larger at 1280 was not attempted.

### Hand-written vs synthetic density

Synthetic rules are about the same size as hand-written ones but repeat much more, so they
compress far better:

| | bytes/rule | gzip ratio (compressed / raw) |
|---|---|---|
| Hand-written (example 03, 20 rules) | 3101 | 0.178 |
| Synthetic (tier4, 100 rules) | 3380 | 0.083 |

Projection for 100 rules at hand-written density: about 310 KB raw JSON -> about 55 KB gzip ->
about 74 KB base64, plus about 81 KB of shell (JS, CSS, `<noscript>` and markup) = about
**154 KB**, well below 512 KB. This is a projection, not a measurement.

## Caveats

- One machine, one browser build. Timings at this scale are noisy between runs (see the tier1
  cold start and the tier4 render time above); read them as orders of magnitude. Sizes, DOM counts, layout numbers, errors and determinism are stable.
- The self-tests and the renderer also pass on Node 22.23.4, and the HTML it renders is
  byte-identical to Node 24's; the tables above are from Node 24.
- Interaction timings come from synthetic events dispatched in the page, not from real input
  devices; they measure handler + layout, not paint or input latency.
- Text widths in the figure come from a per-character estimate shared by the renderer and the
  validator, not from the browser's font. In this Chromium on macOS the real width was at most
  1.05x the estimate (median 0.91-0.93x) across all labels of tiers 1b, 2 and 3; other fonts can differ,
  which is why the sweep measures real `getBBox` boxes.
