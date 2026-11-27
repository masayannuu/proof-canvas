---
name: proof-canvas
description: Render formal-verification or property-testing results as one offline HTML board. Use for TLA+, Quint, Alloy, Lean, or other checker results that need reviewable rule diagrams, counterexamples, and evidence.
---

# proof-canvas

Visualize formal-verification results for people who do not read TLA+, Quint, Alloy or Lean.

Describe the checked rules in a board JSON file. proof-canvas renders one deterministic offline
HTML file under 512 KB. The validator checks its structure, offline use, embed safety, and
provenance.

Run your checker separately. Supply spec files and checker logs to compare their definitions,
hashes, and verdicts with the board JSON.

Use Node 22 or later. Set `SKILL_DIR` to the absolute directory containing this `SKILL.md`.
The installed plugin keeps its scripts in `../../scripts/` relative to that directory.
Resolve the plugin root before running commands from your project directory.

```bash
SKILL_DIR=/absolute/path/to/skills/proof-canvas
PLUGIN_ROOT="$(cd -P "$SKILL_DIR" && cd ../.. && pwd)"
```

The examples below live in `$PLUGIN_ROOT/examples/`.

## 1. Write the board JSON

Start from an example:

| Example | Rules | Modules | Shows |
|---|---|---|---|
| `examples/00_minimal.board.json` | 1 | none | The smallest valid board (reproduced below) |
| `examples/01_room_booking.board.json` | 3 | none | Compact layout: pill bar and overview |
| `examples/02_escrow_payout.board.json` | 12 | 3 | Index layout, TLA+ / TLC style: 9 verified, 1 failed with a counterexample, 2 not checked |
| `examples/03_multi_module_20rules.board.json` | 20 | 4 | Index layout with search, filters and the module overview |
| `examples/04_refund_guard/` | 2 | none | Spec and real log from Quint 0.32.0 |
| `examples/05_multi_verifier/` | 6 | 3 | Native Quint 0.32.0, Alloy 6.2.0, and TLC 2.19 verdicts on one board; `gate`, `relation` and `sequence` figures; a three-stage flow map that opens first |
| `examples/06_japanese_board/` | 3 | none | The 05 specs and logs with `"lang": "ja"`: Japanese board copy and UI, one rule per figure kind, a flow map built from `ruleIds` |

Examples 00 through 03 are illustrative and declare `"provenance": "sample"`: their statuses and
counterexamples were written by hand, and no checker was run.

The minimal board (`examples/00_minimal.board.json`, verbatim):

```json
{
  "version": 1,
  "runId": "minimal-sample",
  "title": "Minimal board: one rule",
  "subtitle": "The smallest valid board",
  "generatedAt": "2026-11-27T00:00:00Z",
  "provenance": "sample",
  "run": { "tool": "Example checker", "status": "verified" },
  "rules": [
    {
      "id": "stock_never_negative",
      "no": 1,
      "short": "Stock never negative",
      "title": "An order never takes stock below zero",
      "property": "StockNonNegative",
      "source": "Inventory spec 1.1",
      "previewTitle": "Checkout",
      "status": "verified",
      "figure": {
        "boxes": { "src1": "Order", "src2": "Stock level", "gate": "Stock check", "pass": "Place order", "hold": "Show sold out", "bad": "Negative stock" },
        "arrows": { "a1": "quantity", "a2": "in stock", "a3": "enough", "a4": "too few", "a5": "not checked" }
      },
      "states": {
        "normal": {
          "label": "Normal", "tone": "normal", "route": ["a1", "a2", "a3"], "here": "pass", "edgeShort": "Placed",
          "chips": [{ "box": "gate", "text": "2 <= 5", "tone": "good" }],
          "takeaway": "Two items are ordered and five are in stock, so the order is placed.",
          "preview": { "statusBadge": "Placed", "rows": [{ "k": "Ordered", "v": "2" }, { "k": "In stock", "v": "5", "tone": "ok" }], "alert": "Order placed.", "buttonLabel": "Place order", "buttonKind": "ok" }
        },
        "bug": {
          "label": "Bug", "tone": "bug", "route": ["a1", "a5"], "here": "bad", "edgeShort": "Oversold",
          "chips": [{ "box": "bad", "text": "stock -1", "tone": "bad" }],
          "takeaway": "Without the check, six items are sold from a stock of five.",
          "preview": { "statusBadge": "Violation", "rows": [{ "k": "Ordered", "v": "6" }, { "k": "In stock", "v": "-1", "tone": "bad" }], "alert": "One customer is promised an item that does not exist.", "buttonLabel": "Place order", "buttonKind": "danger" }
        },
        "fixed": {
          "label": "Fixed", "tone": "safe", "route": ["a1", "a2", "a4"], "here": "hold", "edgeShort": "Sold out",
          "chips": [{ "box": "gate", "text": "6 > 5", "tone": "good" }],
          "takeaway": "The stock check stops the order and shows how many are left.",
          "preview": { "statusBadge": "Blocked", "rows": [{ "k": "Ordered", "v": "6" }, { "k": "In stock", "v": "5", "tone": "warn" }], "alert": "Only 5 left. Lower the quantity.", "buttonLabel": "Place order", "buttonKind": "locked" }
        }
      },
      "defaultFocus": "fixed",
      "evidence": {
        "ruleSummary": "Stock on hand is never below zero after any order.",
        "ifEnforced": "Orders larger than the stock are refused.",
        "ifNotEnforced": "Customers buy items that do not exist.",
        "checkerSummary": "Sample: no violation",
        "scope": "1 product, stock 0-5, orders of 1-6",
        "method": "Illustrative sample; no checker was run"
      }
    }
  ]
}
```

### Schema (version 1)

Every field not marked optional is required. Strings must be non-empty. Unknown keys produce a
validator warning (typos such as `counterExample` are caught), and top-level keys starting with
`__` are reserved for the renderer.

**Board**

| Field | Type | Notes |
|---|---|---|
| `version` | `1` | Schema version. |
| `runId` | string | Identifier of the run or data set, shown in the footer. |
| `title`, `subtitle` | string | Page header. |
| `generatedAt` | string | ISO 8601 timestamp. |
| `provenance` | optional `verified \| mixed \| sample \| unverified` | Declared provenance. Use `sample` for illustrative data. See section 5. |
| `provenanceNote` | optional string | Adds a board note after the computed footer note. |
| `lang` | optional `en \| ja` | Language of the renderer's UI text and `<html lang>`; default `en`. Only that language ships. |
| `labels` | optional object | `{ moduleSingular?, modulePlural?, overview? }` rename "module(s)" (e.g. `stage` / `stages`) and the hub button (default `Flow` with a flow map, else `Overview`). Warns above 24 characters. |
| `defaultView` | optional `rule \| flow` | The first screen; default `rule`. `flow` requires `flow`. |
| `flow` | optional object | A system flow map across modules (see **`flow`** below). |
| `run` | object | The checker run (below). |
| `modules` | optional array | `{ id, title, summary? }`. When present, every rule needs a `moduleId`. |
| `rules` | array, 1..N | One entry per checked rule (below). |

**`run`**

| Field | Type | Notes |
|---|---|---|
| `tool` | string | Checker name, for example `"TLA+ TLC"`, `"Alloy"`, `"fast-check"`. |
| `toolVersion` | optional string | Shown after the tool; a repeated tool name is removed (`"TLA+ TLC"` + `"TLC 2.19"` shows `TLA+ TLC 2.19`). |
| `specHash` | optional string | Spec fingerprint. With `--spec`, omit it for a derived hash or supply the full SHA-256. Without `--spec`, a hash needs 7–128 hex digits and can use a `sha1:`, `sha256:`, or `sha512:` prefix. |
| `status` | `verified \| failed \| pending` | Outcome of the run as a whole. |

**`rules[]`**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique, `[a-zA-Z0-9_-]` only. |
| `no` | number | Positive display number. |
| `moduleId` | string, only with `modules` | Must reference a module id. |
| `short` | string | Label for the pill bar and overview; warns above 20 characters. |
| `title` | string | One sentence that states the rule. |
| `property` | string | Invariant or property name in the spec. |
| `category` | optional string | For example `safety`, `liveness`, `security`. |
| `source` | string | Where the rule comes from (requirement, policy, section). |
| `previewTitle` | string | Title of the linked screen preview. |
| `figure` | object | The diagram: one of three kinds, below. |
| `states.normal`, `states.bug`, `states.fixed` | object | The three switchable states (below). |
| `defaultFocus` | `normal \| bug \| fixed` | State shown first. |
| `status` | optional `verified \| failed \| pending` | Checker result for this rule. Missing means `pending` (shown as "Not checked yet"). |
| `stepsChecked` | optional integer >= 0 | States or steps the checker explored, shown as "N steps checked". |
| `evidence` | object | What was checked and how (below). |

**`figure`**

Pick the kind that shows what the checker proved. `figure.kind` is optional and defaults to
`gate`. Every kind draws into the same canvas. The validator warns when figure text cannot fit:
a box, lane or node label, a chip, or a line label too long for its free length. `gate` and
`sequence` use fixed slots, so only fit is checked. `relation` also warns when a line label
overlaps another label or a node, when a line crosses a node it does not connect, or when a line
crosses another line's label. Line-on-line crossings are not checked.

| Kind | Use for | Fields |
|---|---|---|
| `gate` (default) | A value or status check: limits, budgets, guards | `boxes`: `src1`, `src2` (inputs), `gate` (the check), `pass`, `hold`, `bad` (outcomes). `arrows`: `a1` src1 to gate, `a2` src2 to gate, `a3` gate to pass, `a4` gate to hold, `a5` gate to bad. Box labels wrap to two lines; keep arrow labels to about 12 characters. |
| `sequence` | Races, check-then-act, ordering between actors (TLA+ / TLC, Quint, Apalache) | `lanes`: 2 or 3 `{ id, label }` actors. `steps`: 2 to 5 `{ id, from, to, label }` in time order, top to bottom; `from` and `to` are lane ids, and `from` equal to `to` draws a step on one lane. |
| `relation` | Structure: delegation, roles, ownership, cycles (Alloy) | `nodes`: 3 to 5 `{ id, label, role? }`, placed in fixed slots in array order (3: triangle, 4: 2 x 2, 5: corners and center); `role` is a caption above the label. `edges`: 2 to 7 `{ id, from, to, label, forbidden? }`; `from` equal to `to` draws a loop, an edge and its reverse bow apart, and `forbidden: true` draws the edge dashed. At most one edge per direction between two nodes. |

Ids in `lanes`, `steps`, `nodes`, and `edges` are unique `[a-zA-Z0-9_-]` strings. If a
relation label collides with another element, shorten it or reorder `nodes`.

**`states.<normal | bug | fixed>`**

One rule is one card. The **Compare** switch on that card moves the diagram and the screen
preview together, so put the whole comparison inside one rule: `normal` is the everyday case,
`bug` is what happens with the rule switched off, and `fixed` is the rule doing its job. Never
split one rule into two rules or modules ("with rule" and "without rule"): the reader then
meets two switches that contradict each other.

Every kind:

| Field | Type | Notes |
|---|---|---|
| `label` | string | Button text. |
| `tone` | `normal \| bug \| safe` | Color of the active route, connector and preview. |
| `edgeShort` | string | Connector pill between the figure and the preview; warns above 12 characters. |
| `takeaway` | string | One sentence under the figure. |
| `preview.statusBadge`, `preview.alert`, `preview.buttonLabel` | string | Screen preview text. |
| `preview.buttonKind` | `ok \| danger \| locked` | Button style. |
| `preview.rows` | array, 1..N | `{ k, v, tone? }` with `tone` `normal \| ok \| bad \| warn \| mute`. |
| `preview.bars` | optional array | `{ label, value, limit, max, unit?, ok }`: a meter with a limit marker. |
| `preview.logLines` | optional array of strings | Short trace lines. |

By figure kind (chip `tone` is `neutral \| good \| bad`):

| Kind | Field | Type | Notes |
|---|---|---|---|
| `gate` | `route` | array of arrow ids | Arrows drawn as active. |
| `gate` | `here` | `pass \| hold \| bad` | Outcome box the state ends in; the connector starts there. |
| `gate` | `chips` | array | `{ box, text, tone }`: a value shown inside a box. |
| `sequence` | `activeSteps` | non-empty array of step ids | Steps drawn as active and numbered 1, 2, ... top to bottom; the rest are dimmed. |
| `sequence` | `focusStep` | step id | One of `activeSteps`: where the outcome happens. It is emphasized, and the connector starts on its row. |
| `sequence` | `chips` | optional array | `{ lane, text, tone }`, at most one per lane, shown under the lane header. |
| `relation` | `activeEdges` | non-empty array of edge ids | Edges drawn as active. An active forbidden edge is red; in a `safe` state it ends in a stop bar instead of an arrowhead. |
| `relation` | `focusNodes` | optional array of node ids | Nodes outlined in the state color. |
| `relation` | `chips` | optional array | `{ node, text, tone }`, at most one per node, shown inside the node. With a chip, a node with a `role` keeps its label on one line. |

**`evidence`**

| Field | Type | Notes |
|---|---|---|
| `ruleSummary` | string | The rule in plain words. |
| `ifEnforced`, `ifNotEnforced` | string | What the rule protects; what breaks without it. |
| `checkerSummary` | string | One-line checker result, for example `"No violation in 41,280 states"`. |
| `scope` | string | Bounds of the check (model size, ranges, number of runs). |
| `method` | string | How it was checked (exhaustive model checking, bounded simulation, property-based testing with N runs, and so on). |
| `sourceQuote` | optional string | Verbatim text of the source the rule comes from. |
| `counterexample` | optional string | Checker trace. On a failed or not-checked rule it shows under **Counterexample** ("No counterexample recorded" when absent). On a verified rule, use it for the trace of the rule switched off (for example a killed mutant); it shows under **Counterexample without this rule**. When a verified rule has none, the section is left out. |

**`flow`** (optional)

Stages are cards listing their rules as clickable chips with verifier status; labeled arrows
join them; a journey highlights one path and links to the rule that decides it. A fixed caption
says arrows show connections and each rule's status comes from its own proof, so the map never
claims the connections were verified. Say in `note` how the checkers ran.

| Field | Type | Notes |
|---|---|---|
| `title`, `note` | optional string | Map heading (default "System flow") and a note after the caption. |
| `steps` | array, 2..6 | `{ id, label, summary?, moduleId?, ruleIds? }`: `ruleIds`, or every rule of `moduleId` (with both, the rules must be in that module); at least one rule. 2-3 stages draw in one row, 4-6 in two. |
| `edges` | array, 1..9 | `{ id, from, to, label, kind? }` between two different steps, one per direction. `kind`: `normal` (solid), `bypass` (dashed), `handoff` (dotted). |
| `journeys` | optional array, 1..5 | `{ id, label, tone, summary, stepIds, edgeIds?, checkpointRuleId?, checkpointFocus? }`. `tone`: `normal`, `bug`, `safe`. Both ends of each `edgeIds` edge must be in `stepIds`. `checkpointRuleId` adds a button that opens that rule in `checkpointFocus` (needs `checkpointRuleId`; default by tone: bug → `bug`, safe → `fixed`, else `normal`). |

Ids are unique `[a-zA-Z0-9_-]` strings. Text that does not fit or labels that collide warn.

## 2. Render

```bash
node "$PLUGIN_ROOT/scripts/render_board.mjs" --in board.json --out board.html
#   [--mode standalone|embed] [--title "..."] [--payload auto|json|gzip]
```

- **Layout is automatic.** Up to 6 rules without modules (or with one module) get the *compact*
  layout: a floating pill bar (`1. ... | 2. ... | Overview`). Anything larger gets the *index*
  layout: module selector, rule index, search (`/`), a status filter (All / Failed / Verified /
  Not checked, with counts) and a module overview with numbered rule chips colored by status.
  A board with `flow` replaces the index toolbar's Overview button with **Flow** and puts a
  **Flow** pill first in the compact bar; the flow code is left out of boards without `flow`.
- **Proof & log.** Repeat `--spec <path>` and `--log <path>` to bind files. See section 5.
- **Payload.** `auto` embeds readable JSON up to 192 KB and gzip + base64 above that, decoded
  by the browser's built-in `DecompressionStream`. The decoded board may not exceed 4 MiB.
- **Embedding.** `--mode embed` drops page-level CSS (`html`, `body`) so the board can sit inside
  an `<iframe>` or a host page; keyboard shortcuts then only apply while focus is inside the
  board, and the rule index starts closed. For an iframe, set its height yourself (the board
  never uses `100vh`). All CSS is scoped to `.pc-root`.
- **Warnings.** The renderer prints validator warnings (long labels, text that cannot fit, unknown
  keys) to stderr and still renders; errors stop it with a non-zero exit code.
- **Keys.** `o` the flow map (index layout with `flow`) or the overview, `e` proof & log; compact: `1`-`9` jump to a rule; index: `/` search,
  `j` / `k` next / previous rule, `Esc` clears the search.

## 3. Validate (required)

```bash
node "$PLUGIN_ROOT/scripts/validate_board.mjs" --in board.json board.html   # exit 0 = pass
```

Each gate reports a distinct error prefix.

1. `size:` strictly < 512 KB; warns above the per-scale budget (up to 6 rules 128 KB, 20 rules
   200 KB, 50 rules 350 KB, more 512 KB).
2. `html:` / `data:` / `board.` structure and schema: exactly one root and one payload element,
   strict base64, decoded size limits, the full board schema above.
3. `offline:` no external script, stylesheet, `@import`, `url()`, media, `srcset`, `xlink:href`,
   `<base>`, meta refresh, or network API (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
   `sendBeacon`, `import()`, workers). Board text is data and is never scanned as markup.
4. `svg-markers:` static SVG arrow markers present and ids unique.
5. `embed-safety:` no `100vh`-style heights, no `:root` override of host design tokens, no
   `html` / `body` styling in embed mode.
6. `provenance:` the badge, footer, and cached value agree with the embedded board and evidence.
7. `sync:` with `--in`, the HTML must embed exactly that JSON (a `--title` override is stored
   separately and does not count as a difference).
8. `binding:` with `--spec` or `--log`, recompute evidence from the files and compare it with
   the embedded binding. Use the same set of files you passed to the renderer. Validating
   a bound HTML file without the source files or logs warns that the evidence was not re-checked.

Regenerate older HTML boards to add the evidence metadata required by this validator.

`node "$PLUGIN_ROOT/scripts/test_validator.mjs"` runs the self-tests.

## 4. Look at it

Open the HTML in a browser and check: no console errors, no horizontal scroll, the state buttons
move the route, the connector and the preview together, and Failed filters down to the broken
rules in one click.

For a development checkout with `uv`, `scripts/sweep_figures.py sweep <board.html>` shows every
rule in every state in headless Chromium and fails on figure text outside its box, colliding
labels, clipped text, page overflow, console errors, or external requests.
`scripts/sweep_figures.py flow <board.html>` real-clicks a flow map: every journey, its
checkpoint button (it must land on the exact `checkpointRuleId` and `checkpointFocus`), every
rule chip, the way back to Flow, and a chip clicked while filters hide its rule. It fails on
overlapping stages or labels, text outside a stage, page overflow, or console errors.

## 5. Honesty rules

Use checker results for rule verdicts, step counts, and counterexamples. Describe the
scope and method in the evidence. Use `pending` for rules that still need a verdict
and `sample` for illustrative boards.

A board declared as `sample` always shows **Sample data**. A failed run or rule shows
a failure badge. A board with verified and pending rules shows **Partially verified**.
A board with no verified rules shows **Not checked yet**. Declaring `mixed` or
`unverified` limits the badge.

A board declared as `verified` needs a verified run, a spec hash, and verified rules.
The badge also depends on which files you supply.

| Files supplied | Badge when every rule is verified |
|---|---|
| Spec and log | **Spec & log verified** in green |
| Spec only | **Spec checked · self-reported log** in amber |
| Log only | **Log checked · self-reported spec** in amber |
| Neither | **Self-reported** in amber |

### Spec files

Repeat `--spec` for Quint (`.qnt`), TLA+ (`.tla`), Alloy (`.als`), Lean (`.lean`),
and Dafny (`.dfy`) files. Include any TLC `.cfg` files used to scope passing logs.
Configs contribute to the spec hash. Each rule's `property` must match exactly one declaration.
Evidence includes the source basename, line range, and up to 10 lines or 600 characters.
Keep absolute paths out of source excerpts before publishing the board.

For one file, the hash is `sha256:` followed by the digest of the raw bytes. For several
files, hash the manifest. Sort by basename, encode each entry as the basename, a
newline, and the lowercase hex digest. Join entries with one newline. Use distinct
basenames. Apply the same convention to log hashes. If `run.specHash` is present, it
must match the full spec digest, with or without the `sha256:` prefix. If omitted, the
derived hash is saved in the evidence and the input board stays in sync.

### Checker logs

Repeat `--log` for native logs or `proof-canvas-log-1` JSON receipts from your actual
checker runs. Every supplied file must contain a recognized verdict.

- **Quint.** Include the `quint verify` command and its named invariant or temporal
  options. A passing `quint run` simulation cannot substantiate a verified rule.
- **Alloy 6.** Include the `exec` output. A `check` row ending in `UNSAT` confirms
  the assertion within its scope. A row ending in `SAT` reports a violation.
- **TLC.** A passing log covers the invariants and properties in its supplied `.cfg`.
  If you supply multiple configs, prefix each passing log with its TLC command
  and `-config` argument. With multiple TLA+ specs, keep the log line that names
  the parsed spec file.
- **Apalache.** A passing log covers the named invariants reported by the checker
  or recorded in the command's `--inv=` argument.

Log names are matched to rule properties. With `--spec`, the checker family must
match the bound source. Quint uses `.qnt`, Alloy uses `.als`, and TLC and Apalache
use `.tla`. Only named passes can substantiate a verified rule.

A JSON receipt uses a checker name and an array with one result per property.

```json
{
  "schemaVersion": "proof-canvas-log-1",
  "checker": "Dafny",
  "results": [{ "property": "RefundCap", "status": "verified", "stepsChecked": 5 }]
}
```

Use `verified` or `failed` in the receipt. The schema version, `specHash`, and
`stepsChecked` are optional. If present, `specHash` must match the full manifest
or the spec file bound to the reported rule. If the board and receipt both include
a step count, the counts must match.

The log producer supplies the record of what the checker ran. In the
[`examples/04_refund_guard/`](../../examples/04_refund_guard/) example,
`refund_guard.quint.log` records the Quint command followed by its verbatim output.
See the [README](../../README.md#check-a-spec-and-checker-log) for the commands and the
combined native-log example.

## 6. Scale benchmark

```bash
node "$PLUGIN_ROOT/scripts/bench_scale.mjs"              # Node + headless Chromium (needs uv)
node "$PLUGIN_ROOT/scripts/bench_scale.mjs" --no-browser # Node-only metrics
```

Renders 3 / 12 / 20 / 50 / 100-rule boards and an embed-mode board, validates them, checks
byte-identical re-renders, then measures load, DOM size, heap, layout (every rule in every
state) and interaction latency in headless Chromium, and writes `out/bench/`. Results:
[`BENCHMARK.md`](../../BENCHMARK.md). Make stress boards with
`node "$PLUGIN_ROOT/scripts/synth_board.mjs" --rules 100 --modules 20 --failed 5 --unverified 20 --out x.json`
(`--unverified` sets how many rules are `pending`).
