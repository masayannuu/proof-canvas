---
name: proof-canvas
description: Turn formal-verification or property-testing results (TLA+ / TLC, Apalache, Quint, Alloy, Lean 4, Dafny, Hypothesis, fast-check, or any other checker) into one offline, single-file HTML board that people who do not read spec code can review. Each rule is drawn as a 6-box flow with normal / bug / fixed states, a linked screen preview and an evidence panel. Scales from 1 rule to 100+ rules across modules. Use when you need to show what a checked rule protects, what breaks without it, and how much of the claim was actually checked.
---

# proof-canvas

Visualize formal-verification results for people who do not read TLA+, Quint, Alloy or Lean.

You (or your agent) describe the checked rules in one JSON file. `proof-canvas` renders it into a
deterministic, zero-dependency, offline HTML file (< 512 KB), and a validator proves the file is
safe to share: no network access, safe to embed, and a status badge that always agrees with the
rule statuses in the file.

proof-canvas only draws what you give it. It does not run a checker, read a spec or decide
whether a rule holds: every status, counterexample and number on the board comes from your JSON.

`SKILL_DIR` below is the directory that contains this `SKILL.md`. Requires Node 22 or later and
nothing else (no `npm install`).

## 1. Write the board JSON

Start from an example:

| Example | Rules | Modules | Shows |
|---|---|---|---|
| `examples/00_minimal.board.json` | 1 | none | The smallest valid board (reproduced below) |
| `examples/01_room_booking.board.json` | 3 | none | Compact layout: pill bar and overview |
| `examples/02_escrow_payout.board.json` | 12 | 3 | Index layout, TLA+ / TLC style: 9 verified, 1 failed with a counterexample, 2 not checked |
| `examples/03_multi_module_20rules.board.json` | 20 | 4 | Index layout with search, filters and the module overview |

All four examples are illustrative and declare `"provenance": "sample"`: their statuses and
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
| `provenance` | optional `verified \| mixed \| sample \| unverified` | Declared trust level; see section 5. Synthetic or hand-written data must use `sample`. |
| `provenanceNote` | optional string | Replaces the computed footer note. |
| `run` | object | The checker run (below). |
| `modules` | optional array | `{ id, title, summary? }`. When present, every rule needs a `moduleId`. |
| `rules` | array, 1..N | One entry per checked rule (below). |

**`run`**

| Field | Type | Notes |
|---|---|---|
| `tool` | string | Checker name, for example `"TLA+ TLC"`, `"Alloy"`, `"fast-check"`. |
| `toolVersion` | optional string | Shown after the tool; a repeated tool name is removed (`"TLA+ TLC"` + `"TLC 2.19"` shows `TLA+ TLC 2.19`). |
| `specHash` | optional string | Fingerprint of the checked spec: optional `sha1:` / `sha256:` / `sha512:` prefix, then 7-128 hex digits, not all zeros. Anything else warns and blocks Verified. |
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
| `figure.boxes` | object | `src1`, `src2` (inputs), `gate` (the check), `pass`, `hold`, `bad` (outcomes). Labels wrap to two lines; text that still cannot fit warns. |
| `figure.arrows` | object | `a1` src1 to gate, `a2` src2 to gate, `a3` gate to pass, `a4` gate to hold, `a5` gate to bad. Keep labels to about 12 characters. |
| `states.normal`, `states.bug`, `states.fixed` | object | The three switchable states (below). |
| `defaultFocus` | `normal \| bug \| fixed` | State shown first. |
| `status` | optional `verified \| failed \| pending` | Checker result for this rule. Missing means `pending` (shown as "Not checked yet"). |
| `stepsChecked` | optional integer >= 0 | States or steps the checker explored, shown as "N steps checked". |
| `evidence` | object | What was checked and how (below). |

**`states.<normal | bug | fixed>`**

| Field | Type | Notes |
|---|---|---|
| `label` | string | Button text. |
| `tone` | `normal \| bug \| safe` | Color of the route, connector and preview. |
| `route` | array of arrow ids | Arrows drawn as active. |
| `here` | `pass \| hold \| bad` | Outcome box the state ends in. |
| `edgeShort` | string | Connector pill between the figure and the preview; warns above 12 characters. |
| `chips` | array | `{ box, text, tone }` with `tone` `neutral \| good \| bad`: a value shown inside a box. |
| `takeaway` | string | One sentence under the figure. |
| `preview.statusBadge`, `preview.alert`, `preview.buttonLabel` | string | Screen preview text. |
| `preview.buttonKind` | `ok \| danger \| locked` | Button style. |
| `preview.rows` | array, 1..N | `{ k, v, tone? }` with `tone` `normal \| ok \| bad \| warn \| mute`. |
| `preview.bars` | optional array | `{ label, value, limit, max, unit?, ok }`: a meter with a limit marker. |
| `preview.logLines` | optional array of strings | Short trace lines. |

**`evidence`**

| Field | Type | Notes |
|---|---|---|
| `ruleSummary` | string | The rule in plain words. |
| `ifEnforced`, `ifNotEnforced` | string | What the rule protects; what breaks without it. |
| `checkerSummary` | string | One-line checker result, for example `"No violation in 41,280 states"`. |
| `scope` | string | Bounds of the check (model size, ranges, number of runs). |
| `method` | string | How it was checked (exhaustive model checking, bounded simulation, property-based testing with N runs, and so on). |
| `sourceQuote` | optional string | Verbatim text of the source the rule comes from. |
| `counterexample` | optional string | Checker trace for a failed rule. |

## 2. Render

```bash
node "$SKILL_DIR/scripts/render_board.mjs" --in board.json --out board.html
#   [--mode standalone|embed] [--title "..."] [--payload auto|json|gzip]
```

- **Layout is automatic.** Up to 6 rules without modules (or with one module) get the *compact*
  layout: a floating pill bar (`1. ... | 2. ... | Overview`). Anything larger gets the *index*
  layout: module selector, rule index, search (`/`), a status filter (All / Failed / Verified /
  Not checked, with counts) and a module overview with numbered rule chips colored by status.
- **Payload.** `auto` embeds readable JSON up to 192 KB and gzip + base64 above that, decoded
  by the browser's built-in `DecompressionStream`. The decoded board may not exceed 4 MiB.
- **Embedding.** `--mode embed` drops page-level CSS (`html`, `body`) so the board can sit inside
  an `<iframe>` or a host page; keyboard shortcuts then only apply while focus is inside the
  board, and the rule index starts closed. For an iframe, set its height yourself (the board
  never uses `100vh`). All CSS is scoped to `.pc-root`.
- **Warnings.** The renderer prints validator warnings (long labels, text that cannot fit, unknown
  keys) to stderr and still renders; errors stop it with a non-zero exit code.
- **Keys.** `o` overview, `e` evidence; compact: `1`-`9` jump to a rule; index: `/` search,
  `j` / `k` next / previous rule, `Esc` clears the search.

## 3. Validate (required)

```bash
node "$SKILL_DIR/scripts/validate_board.mjs" --in board.json board.html   # exit 0 = pass
```

Six gates, each failing with its own prefix, plus a sync check:

1. `size:` strictly < 512 KB; warns above the per-scale budget (up to 6 rules 100 KB, 20 rules
   200 KB, 50 rules 350 KB, more 512 KB).
2. `html:` / `data:` / `board.` structure and schema: exactly one root and one payload element,
   strict base64, decoded size limits, the full board schema above.
3. `offline:` no external script, stylesheet, `@import`, `url()`, media, `srcset`, `xlink:href`,
   `<base>`, meta refresh, or network API (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
   `sendBeacon`, `import()`, workers). Board text is data and is never scanned as markup.
4. `svg-markers:` static SVG arrow markers present and ids unique.
5. `embed-safety:` no `100vh`-style heights, no `:root` override of host design tokens, no
   `html` / `body` styling in embed mode.
6. `provenance:` exactly one badge, and the badge, the footer and the cached value all equal the
   provenance computed from the embedded statuses.
7. `sync:` with `--in`, the HTML must embed exactly that JSON (a `--title` override is stored
   separately and does not count as a difference).

`node "$SKILL_DIR/scripts/test_validator.mjs"` runs the self-tests.

## 4. Look at it

Open the HTML in a browser and check: no console errors, no horizontal scroll, the state buttons
move the route, the connector and the preview together, and Failed filters down to the broken
rules in one click.

## 5. Honesty rules

**Consistent by construction.** The badge is computed from the statuses in your JSON, and the
validator rejects any HTML whose badge, footer or cached value disagrees with them. proof-canvas
cannot check that those statuses came from a real checker run: that part is your responsibility.

- Put `verified`, `failed`, counterexamples and step counts in only if a checker produced them.
  Everything else is `pending`, or the whole board is `sample`.
- State what the check covered: `method` and `scope` name the technique and its bounds.
- Keep `sourceQuote` verbatim; put interpretation in `ruleSummary`.
- Hand-written, generated or synthetic data must declare `"provenance": "sample"`.

The badge is the first row that applies, top to bottom:

| # | Badge | When |
|---|---|---|
| 1 | Sample data | `provenance` is declared `sample` |
| 2 | `N failed · v/t verified` (red) | any rule is `failed`, or `run.status` is `failed` (even without a spec hash) |
| 3 | Sample data | `run.specHash` is present but malformed, and no rule is verified |
| 4 | Verified (green) | `run.status` is `verified`, `run.specHash` is real, every rule is `verified`, and `provenance` is not declared `mixed` or `unverified` |
| 5 | Partially verified (`v/t`) | at least one rule is verified (this includes a board that meets row 4 but declares `mixed`) |
| 6 | Not checked yet (`0/t`), or Unverified (`v/t`) | no rule is verified, or `provenance` is declared `unverified` |

A declared `mixed` or `unverified` only ever lowers the badge; it never raises it. The footer
note under the board says which condition applied.

Declaring `"provenance": "verified"` on a board that does not meet the Verified row is a schema
error that lists the reasons.

## 6. Scale benchmark

```bash
node "$SKILL_DIR/scripts/bench_scale.mjs"              # Node + headless Chromium (needs uv)
node "$SKILL_DIR/scripts/bench_scale.mjs" --no-browser # Node-only metrics
```

Renders 3 / 12 / 20 / 50 / 100-rule boards and an embed-mode board, validates them, checks
byte-identical re-renders, then measures load, DOM size, heap, layout (every rule in every
state) and interaction latency in headless Chromium, and writes `out/bench/`. Results:
`BENCHMARK.md`. Make stress boards with
`node scripts/synth_board.mjs --rules 100 --modules 20 --failed 5 --unverified 20 --out x.json`
(`--unverified` sets how many rules are `pending`).
