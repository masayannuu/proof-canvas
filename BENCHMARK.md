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
| tier1_3rules | 3 / 0 | compact | standalone | sample | 73.4 KB (128 KB) | JSON | 3293 | 2.21 | 29.54 | yes | PASS |
| tier1b_escrow | 12 / 3 | index | standalone | failed | 117.1 KB (200 KB) | JSON | 3027 | 4.84 | 2.54 | yes | PASS |
| tier2_20rules | 20 / 4 | index | standalone | sample | 143.2 KB (200 KB) | JSON | 3101 | 4.86 | 15.84 | yes | PASS |
| tier3_50rules | 50 / 10 | index | standalone | sample | 250.2 KB (350 KB) | JSON | 3370 | 7.97 | 10.89 | yes | PASS |
| tier4_100rules | 100 / 20 | index | standalone | sample | 123.5 KB (512 KB) | gzip+base64 | 3380 | 31.4 | 20.84 | yes | PASS |
| embed_20rules | 20 / 4 | index | embed | sample | 143.1 KB (200 KB) | JSON | 3101 | 3.75 | 7.75 | yes | PASS |

`bytes/rule` is the raw JSON size of the rules divided by their count. Every tier passes the
validator with zero warnings.

## Results: browser

| Tier | Viewport | DOMContentLoaded ms | App ready ms | DOM nodes | JS heap MB | Views swept | Min SVG text units (px) | SVG text overflow | Connector overlap px | Clipped labels | Page overflow px | Toolbar rows | Index open at load | Errors (console / page) | External requests | CJK chars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tier1_3rules | 1280x800 | 189.3 | 189.1 | 200 | 2.01 | 9 | 13.9 (13.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1_3rules | 1440x900 | 26.8 | 26.7 | 200 | 2.01 | 9 | 13.9 (13.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1b_escrow | 1280x800 | 65.5 | 53.8 | 313 | 2.06 | 36 | 13.1 (9.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1b_escrow | 1440x900 | 46.1 | 45.8 | 313 | 2.06 | 36 | 13.1 (11.4) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier2_20rules | 1280x800 | 46.6 | 46.4 | 365 | 2.19 | 60 | 13.2 (10) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier2_20rules | 1440x900 | 36.2 | 36.1 | 365 | 2.19 | 60 | 13.2 (11.5) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier3_50rules | 1280x800 | 47.1 | 46.8 | 549 | 2.33 | 150 | 13 (9.8) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier3_50rules | 1440x900 | 36.4 | 35.9 | 549 | 2.33 | 150 | 13 (11.3) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier4_100rules | 1280x800 | 11 | 43 | 858 | 2.4 | 300 | 13 (9.8) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier4_100rules | 1440x900 | 9.6 | 36.8 | 858 | 2.42 | 300 | 13 (11.3) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| embed_20rules | 900x700 | 34.3 | 33.8 | 358 | 2.18 | 60 | 13.2 (13.2) | 0 | 0 | 0 | 0 | 1 | false | 0 / 0 | 0 | 0 |

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
| tier1_3rules | 1280x800 | 3 (frame 16) | 2.2 (frame 10.2) | 1.8 (frame 10.3) | 2.7 (frame 18.3) | n/a | n/a | n/a |
| tier1_3rules | 1440x900 | 1.6 (frame 6.6) | 1.6 (frame 12.6) | 1.6 (frame 13.3) | 2.6 (frame 16.4) | n/a | n/a | n/a |
| tier1b_escrow | 1280x800 | 2 (frame 12.7) | 2.1 (frame 14.2) | 2.4 (frame 10.7) | 2 (frame 12.6) | 2.3 (frame 8.3) | 1.9 (frame 13.7) | 1.9 (frame 10.1) |
| tier1b_escrow | 1440x900 | 2.4 (frame 12.7) | 2.8 (frame 11.3) | 2.2 (frame 13) | 1.7 (frame 11.4) | 3 (frame 11) | 1.9 (frame 12.3) | 2 (frame 12.8) |
| tier2_20rules | 1280x800 | 3 (frame 11.6) | 4.8 (frame 10.6) | 2.6 (frame 12.2) | 3.1 (frame 12.8) | 4.1 (frame 13.5) | 3.3 (frame 10.8) | 2 (frame 12.4) |
| tier2_20rules | 1440x900 | 2.2 (frame 11.1) | 2.5 (frame 12.1) | 2.7 (frame 11) | 2.3 (frame 10.3) | 2.2 (frame 11.2) | 2 (frame 10.6) | 2.4 (frame 8.5) |
| tier3_50rules | 1280x800 | 4.3 (frame 14.2) | 3.7 (frame 8.9) | 2.8 (frame 8.5) | 7.3 (frame 11.5) | 4 (frame 11.8) | 3.6 (frame 11.8) | 2.9 (frame 11.3) |
| tier3_50rules | 1440x900 | 4.6 (frame 11.8) | 4 (frame 11.4) | 5 (frame 10.9) | 3.1 (frame 14.4) | 2.3 (frame 11.6) | 2 (frame 11.4) | 2.8 (frame 10.2) |
| tier4_100rules | 1280x800 | 4 (frame 13.6) | 4.9 (frame 9.5) | 4.3 (frame 9.1) | 8.2 (frame 14) | 2.1 (frame 12.5) | 4.7 (frame 11.3) | 2.6 (frame 15.1) |
| tier4_100rules | 1440x900 | 4.2 (frame 12.4) | 4.9 (frame 12.4) | 3.5 (frame 11.6) | 6 (frame 14) | 2.7 (frame 9.7) | 2.6 (frame 11.7) | 2.5 (frame 11.3) |
| embed_20rules | 900x700 | 2 (frame 12.2) | 2.1 (frame 11.4) | 2.2 (frame 12.6) | 1.7 (frame 12.7) | 2.5 (frame 12.7) | 2.3 (frame 12.8) | 3.2 (frame 13.4) |

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

- **Load.** Every page is interactive in under 55 ms, except the very first page this browser
  process opened (tier1 at 1280x800: 189 ms in this run, 253 ms in an earlier one), which
  looks like a cold start. Plain-JSON boards are ready when DOMContentLoaded fires; the gzip
  board adds about 27-32 ms for `DecompressionStream` and `JSON.parse` (tier4: DOMContentLoaded
  9.6-11 ms, App ready 36.8-43 ms).
- **DOM and memory.** Nodes grow roughly linearly with rules (200 -> 858) and the heap stays at
  2.0-2.4 MB.
- **Layout.** Across 1,170 swept views (every rule in every state, every viewport) no figure
  text leaves its box, no connector pill touches a card, no label is clipped, the page never
  scrolls sideways and the toolbar stays on one row, including at 900x700 in embed mode.
- **Latency.** The worst sync median is 8.2 ms (Overview at 100 rules, 1280x800). "frame"
  values (about 7-18 ms) are dominated by waiting for the next animation frame, not by work.

### Bottlenecks

1. **Payload dominates file size beyond about 15 rules.** At tier4 the HTML is 37.1 KB payload
   (gzip + base64), 39.9 KB JS, 34.0 KB CSS and 6.5 KB `<noscript>` text; the compact layout
   ships 32.2 KB JS and 24.7 KB CSS. The same 100-rule board as plain JSON is 420.8 KB, under
   the 512 KB limit; 200 rules are 754.9 KB as plain JSON and 182.8 KB with gzip, which is why
   `auto` switches to gzip above 192 KB (covered by a self-test).
2. **Full re-render of the index.** The index is rebuilt with `innerHTML` on every state
   change, so its cost is linear in rule count: switch rule and Overview go from about 2-3 ms at
   20 rules to 4-8 ms at 100. That is fine up to a few hundred rules; above about 1,000 rules
   the index would need virtualization or keyed updates. This is an extrapolation: 1,000+ rules
   were not measured.
3. **Node render time is gzip.** tier4 renders in 31.4 ms (22-38 ms in earlier runs) against
   2.2-8.0 ms for the JSON tiers; most of the difference is `gzipSync` at level 9.
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
about 74 KB base64, plus about 86 KB of shell (JS, CSS, `<noscript>` and markup) = about
**160 KB**, well below 512 KB. This is a projection, not a measurement.

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
