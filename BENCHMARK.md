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
- **Interactions:** each runs in the page: `t0` -> click -> forced layout
  (`document.body.offsetHeight`) = **sync**; then the next `requestAnimationFrame` + task =
  **frame**. After each run the inverse action restores the state, so every repetition measures
  the same transition.

## Results: size and Node

| Tier | Rules / modules | Layout | Mode | Badge | HTML (budget) | Payload | bytes/rule | Render ms | Validate ms | Deterministic | Validator |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tier1_3rules | 3 / 0 | compact | standalone | sample | 75.6 KB (128 KB) | JSON | 3293 | 0.98 | 1.57 | yes | PASS |
| tier1b_escrow | 12 / 3 | index | standalone | failed | 114.8 KB (200 KB) | JSON | 3027 | 1.4 | 1.76 | yes | PASS |
| tier2_20rules | 20 / 4 | index | standalone | sample | 140.9 KB (200 KB) | JSON | 3101 | 1.94 | 2.27 | yes | PASS |
| tier3_50rules | 50 / 10 | index | standalone | sample | 247.9 KB (350 KB) | JSON | 3370 | 3.2 | 3.89 | yes | PASS |
| tier4_100rules | 100 / 20 | index | standalone | sample | 121.2 KB (512 KB) | gzip+base64 | 3380 | 9.24 | 5.85 | yes | PASS |
| embed_20rules | 20 / 4 | index | embed | sample | 140.8 KB (200 KB) | JSON | 3101 | 1.69 | 2.18 | yes | PASS |

`bytes/rule` is the raw JSON size of the rules divided by their count. HTML sizes were
re-measured with `--no-browser` after the review fixes (+0.1 KB); the timings are from the full
run just before them. Every tier passes the
validator with zero warnings.

## Results: browser

| Tier | Viewport | DOMContentLoaded ms | App ready ms | DOM nodes | JS heap MB | Views swept | Min SVG text units (px) | SVG text overflow | Connector overlap px | Clipped labels | Page overflow px | Toolbar rows | Index open at load | Errors (console / page) | External requests | CJK chars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tier1_3rules | 1280x800 | 112.1 | 111.9 | 203 | 2.02 | 9 | 13.9 (13.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1_3rules | 1440x900 | 24.6 | 24.4 | 203 | 2.02 | 9 | 13.9 (13.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1b_escrow | 1280x800 | 35.9 | 35.7 | 300 | 2.03 | 36 | 13.1 (9.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1b_escrow | 1440x900 | 28.3 | 28.1 | 300 | 2.03 | 36 | 13.1 (11.4) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier2_20rules | 1280x800 | 30.3 | 30.2 | 351 | 2.15 | 60 | 13.2 (10) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier2_20rules | 1440x900 | 29 | 28.9 | 351 | 2.15 | 60 | 13.2 (11.5) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier3_50rules | 1280x800 | 26.7 | 26.4 | 529 | 2.27 | 150 | 13 (9.8) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier3_50rules | 1440x900 | 22.7 | 22.6 | 529 | 2.27 | 150 | 13 (11.3) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier4_100rules | 1280x800 | 10.2 | 37.6 | 828 | 2.35 | 300 | 13 (9.8) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier4_100rules | 1440x900 | 6.2 | 25.1 | 828 | 2.37 | 300 | 13 (11.3) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| embed_20rules | 900x700 | 20.8 | 20.6 | 344 | 2.14 | 60 | 13.2 (13.2) | 0 | 0 | 0 | 0 | 1 | false | 0 / 0 | 0 | 0 |

"Index open at load" is `true` for the compact tier because the flag is simply unused there.

## Results: behavior checks

Pages built only for these checks (`out/bench/check_*.html`).

| Behavior check | Viewport | Result | Detail |
|---|---|---|---|
| corrupted payload shows the error box | 1280x800 | PASS | This board could not be displayed: the board payload is not standard base64. |
| standalone below 1100 px starts with the index closed | 1024x768 | PASS | indexOpen at load = False |

## Results: interaction latency (ms, sync median; frame in parentheses)

| Tier | Viewport | switch rule | toggle normal/bug/fixed | toggle Evidence | toggle Overview | filter failed only |
|---|---|---|---|---|---|---|
| tier1_3rules | 1280x800 | 3 (frame 11.6) | 2 (frame 14.4) | 1.8 (frame 13.3) | 4.3 (frame 14.8) | n/a |
| tier1_3rules | 1440x900 | 1.5 (frame 12.1) | 1.6 (frame 12.6) | 1.8 (frame 14.1) | 3.5 (frame 14.8) | n/a |
| tier1b_escrow | 1280x800 | 2 (frame 11.5) | 1.7 (frame 15) | 1.9 (frame 14.4) | 1.3 (frame 14.8) | 1.9 (frame 13.9) |
| tier1b_escrow | 1440x900 | 1.7 (frame 13.5) | 1.8 (frame 14.9) | 1.7 (frame 15.3) | 1.2 (frame 12.7) | 1.5 (frame 15.6) |
| tier2_20rules | 1280x800 | 2.2 (frame 14.6) | 2 (frame 15) | 2 (frame 15) | 1.7 (frame 14.4) | 1.6 (frame 14.1) |
| tier2_20rules | 1440x900 | 2.2 (frame 15.2) | 1.8 (frame 13.3) | 1.9 (frame 13.5) | 1.7 (frame 12) | 1.7 (frame 16.2) |
| tier3_50rules | 1280x800 | 2.4 (frame 14.5) | 2.4 (frame 12.8) | 2.5 (frame 15.6) | 2.7 (frame 12.6) | 1.7 (frame 13.1) |
| tier3_50rules | 1440x900 | 2.3 (frame 14.8) | 2.3 (frame 13.5) | 2.5 (frame 17.1) | 2.8 (frame 15) | 1.6 (frame 16.5) |
| tier4_100rules | 1280x800 | 3.6 (frame 14.6) | 3.8 (frame 13.8) | 3.4 (frame 13.4) | 4.6 (frame 15.1) | 2.1 (frame 12.6) |
| tier4_100rules | 1440x900 | 3.2 (frame 11.3) | 3.1 (frame 16.1) | 3.3 (frame 14.7) | 4.4 (frame 12.6) | 1.6 (frame 16.4) |
| embed_20rules | 900x700 | 1.2 (frame 13.9) | 1.9 (frame 15.3) | 1.5 (frame 15) | 1.6 (frame 14.4) | 1.2 (frame 15.8) |

## Screenshots

| File | Viewport | Shows |
|---|---|---|
| `out/bench/tier1_3rules.png` | 1440x900 | Compact layout, floating pill bar |
| `out/bench/tier1b_escrow_failed_rule.png` | 1440x900 | Failed badge; the failed rule in its bug state with the evidence panel open |
| `out/bench/tier2_20rules_overview.png` | 1440x900 | Module overview |
| `out/bench/tier2_20rules_detail.png` | 1440x900 | One rule in focus; a two-line box label ("Return HTTP 409 Conflict") |
| `out/bench/tier2_20rules_detail_evidence.png` | 1440x900 | A failed rule with the evidence panel open |
| `out/bench/tier3_50rules_filtered.png` | 1440x900 | Status filter = Failed |
| `out/bench/tier4_100rules_overview.png` | 1440x900 | 20-module overview |
| `out/bench/tier4_100rules_failed_overview.png` | 1440x900 | Overview filtered to failed rules |
| `out/bench/embed_20rules_900.png` | 900x700 | Embed mode: one-row toolbar, index closed, stacked cards |

## Flow map boards (examples 05 and 06)

The tiers above have no `flow`. Examples 05 and 06 do, and open on their flow map. Measured on
the same machine with the commands in `README.md`, bound to the example 05 specs and logs
(`--spec` / `--log`).

| Board | Standalone | Embed | Budget |
|---|---|---|---|
| 05 multi-verifier (6 rules, 3 stages, 3 journeys, 3 `outOfScope` entries) | 129,494 B (126.5 KB) | 129,406 B (126.4 KB) | 128 KB |
| 06 Japanese (3 rules, 3 stages, 3 journeys, 3 `outOfScope` entries, `"lang": "ja"`) | 111,705 B (109.1 KB) | 111,617 B (109.0 KB) | 128 KB |

- **Cost.** The flow code and CSS are written only into boards that have `flow`, and the
  out-of-scope note only into boards that have `outOfScope`. Against the previous release
  (commit `d65cade`), compact boards without `flow` (00, 01) grow by 422 B (per-language UI
  text) and index boards (02, 03) shrink by 4,097 B, because the rule search and the module
  select were removed; example 05 grows by 18,038 B (17.6 KB) with its flow map and note.
- **Click sweep.** `scripts/sweep_figures.py flow` over examples 00-06, standalone and embed, at
  1440x900 and 900x700: 320 real clicks (every journey, every checkpoint button, every stage
  rule chip, the way back to Flow, each status filter on the map of the index layout followed by
  a matching chip, closing and reopening the out-of-scope note across a re-render, and on 02 and
  03 every module card of the overview, unfiltered and under the Failed filter), 0 failures:
  no stage or label overlap, no text outside a stage, no page overflow, no search box or select,
  the out-of-scope note under the main view with exactly the JSON entries and no overflow, no
  console errors. Because every example 05 rule is verified, a copy with one failed and one
  unchecked rule (not shipped) was swept too: 180 clicks, 0 failures; five deliberately broken
  copies (no dimming of chips, no dimming of stages, filter always cleared, note state lost,
  module card opening the first rule of the whole board) were each caught. The sizes above include this release's trust pill, scope chip and witness row (+2,036 B on 05,
+2,061 B on 06; see the next section).

## Mutant traces, bounds, `state` and `timeline` (example 07)

Example 07 (3 rules, Japanese, `run.bounds`, two `state` figures and one `timeline`) binds three
real mutant logs with `--mutant-log`: two `quint run` outputs and one TLC 2.19 output.

| Board | Standalone | Embed | Budget |
|---|---|---|---|
| 07 state and timeline (3 rules, 3 mutant traces, `outOfScope`, `"lang": "ja"`) | 96,914 B (94.6 KB) | 96,826 B (94.6 KB) | 128 KB |

- **Cost.** Against commit `981bc4c`, every board without traces grows by 1,787 B (00-04) to
  2,061 B (06): the trust pill, the scope chip, the witness row and their per-language text. The
  trace block is written only into boards with `--mutant-log`, the bounds line only into boards
  with `run.bounds`, and the `state` and `timeline` code only into boards that use those kinds,
  so 00-06 carry none of it.
- **Figure sweep.** `scripts/sweep_figures.py sweep` over examples 00-07, standalone and embed,
  at 1440x900 and 900x700: 800 views, 0 failures. Each rule is shown in every state and once more
  in its bug state with **Proof & log** open; the sweep fails when the pill disagrees with the
  binding, when the listed steps differ from the embedded ones, or when the pill or the
  property is clipped. It also checks `timeline` tick labels for overlap and that the `state`
  start dot and forbidden x stay inside their box and pill.
- **Click sweep.** `scripts/sweep_figures.py flow` over the same 16 files: 328 real clicks,
  0 failures.
- **Real logs.** Copies of the 18 logs of an OAuth (RFC 9700) model run were bound one by one:
  the 10 mutant logs bound (6 Quint, 4 TLC, 3 to 11 steps); 7 passing logs were refused as not
  killed and 1 witness log as naming several violated properties.

## Phones and narrow columns

At a main column of 760px or less the flow map reflows its stages in step order at full size (one
column on a phone, two or three on a tablet) and hides the edge drawing; at 640px or less the bar
scrolls with the page in two rows, the rule number sits beside its title, the scenario buttons
share one row, and every figure fits whole in its card.
On a narrow screen, picking a rule from the index closes the index.

| Board | Standalone before (`fe0e51b`) | Standalone after | Budget |
|---|---|---|---|
| 00 minimal | 68,611 B | 68,537 B | 128 KB |
| 05 multi-verifier (index, flow) | 129,494 B | 129,313 B | 128 KB |
| 07 state and timeline | 96,914 B | 96,735 B | 128 KB |

- **Cost.** The phone rules add about 1.7 KB of CSS and JS to a flow board. The CSS minifier now
  also drops spaces after "," ">" "/" and a property's ":", before "!important", the 0 of "0.5"
  and each rule's last ";", which more than pays for it: against `fe0e51b` every example shrinks,
  by 74 B (00, 01, 04, 06) to 217 B (02, 03). Example 05 with one bound mutant log, as the
  mutant-log validation test renders it, is 130,833 B: 239 B under budget.
- **Phone sweep.** `scripts/sweep_figures.py mobile` over the 16 example files and both modes of a
  16-rule, 6-stage Japanese OAuth board, at 390x844 and 375x812 as touch phones: 1,056 views,
  580 flow clicks and 188 taps, 0 failures. Stacked stage titles are 15.1px and chips 13px and
  38px tall (they were 4.7px and 4.0px / 8px at 390px).
- **Desktop and tablet.** `sweep` (800 views) at 1440x900 and 900x700, `flow` (492 clicks) at
  1440x900, 1100x800 and 900x700, and `flow` at 768x1024 (164 clicks): 0 failures. The flow probe
  now also fails when the map is stacked above a 760px main column or drawn in 2D at or below it;
  at 1100x800 the open index leaves the main column 780px wide and the map stays 2D. Full-page
  screenshots of examples 01, 03, 05 and 07, standalone and embed, at 1440x900, 1100x800 and
  900x700, on the first view, a rule in its bug state and the open drawer (72 screens, reduced
  motion), are pixel-identical to `fe0e51b`.
- **Negative control.** The same `mobile` sweep over examples 03 and 06 rendered by `fe0e51b`
  reports 84 failures (sticky bar, buttons outside the bar, a 2D map on a phone, scenario buttons
  on two rows, the rule number above its title, clipped labels, and an index that stays open off
  screen).

## Analysis

### What scales well

- **Load.** Every page after the first is interactive in under 40 ms in this run (slowest:
  tier4 at 1280x800, 37.6 ms). The very first page a browser process opens is slower: 112 ms in
  this run (tier1 at 1280x800); earlier runs measured 189-253 ms for that cold start. Plain-JSON
  boards are ready when DOMContentLoaded fires; the gzip board adds about 19-27 ms for
  `DecompressionStream` and `JSON.parse` (tier4: DOMContentLoaded 6.2-10.2 ms, App ready
  25.1-37.6 ms).
- **DOM and memory.** Nodes grow roughly linearly with rules (203 -> 828) and the heap stays at
  2.0-2.4 MB.
- **Layout.** Across 1,170 swept views (every rule in every state, every viewport) no figure
  text leaves its box, no connector pill touches a card, no label is clipped, the page never
  scrolls sideways and the toolbar stays on one row, including at 900x700 in embed mode.
- **Latency.** The worst sync median is 4.6 ms (Overview at 100 rules, 1280x800). "frame"
  values (about 6-16 ms) are dominated by waiting for the next animation frame, not by work.

### Bottlenecks

1. **Payload dominates file size beyond about 15 rules.** At tier4 the HTML is 37.1 KB payload
   (gzip + base64), 39.2 KB JS, 32.4 KB CSS and 6.5 KB `<noscript>` text; the compact layout
   ships 33.7 KB JS and 25.4 KB CSS. The same 100-rule board as plain JSON is 418.5 KB, under
   the 512 KB limit; 200 rules (`--rules 200 --modules 20 --failed 5 --unverified 20 --seed 200`)
   are 752.6 KB as plain JSON and 180.3 KB with gzip,
   which is why `auto` switches to gzip above 192 KB (covered by a self-test).
2. **Full re-render of the index.** The index is rebuilt with `innerHTML` on every state
   change, so its cost is linear in rule count: switch rule and Overview go from about 2 ms at
   20 rules to 3-5 ms at 100. That is fine up to a few hundred rules; above about 1,000 rules
   the index would need virtualization or keyed updates. This is an extrapolation: 1,000+ rules
   were not measured.
3. **Node render time is gzip.** tier4 renders in 9.2 ms (9-38 ms across runs) against
   1.0-3.2 ms for the JSON tiers; most of the difference is `gzipSync` at level 9.
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
about 74 KB base64, plus about 84 KB of shell (JS, CSS, `<noscript>` and markup) = about
**158 KB**, well below 512 KB. This is a projection, not a measurement.

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
