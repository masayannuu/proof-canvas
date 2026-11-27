"""Headless Chromium layout sweep and screenshots for proof-canvas boards (helper, not needed to use the boards).

  uv run --with playwright==1.65.2 python scripts/sweep_figures.py sweep out/board.html [more.html ...]
      [--viewport 1440x900] [--viewport 900x700] [--shots DIR]
  uv run --with playwright==1.65.2 python scripts/sweep_figures.py flow out/board.html [more.html ...]
      [--viewport 1440x900] [--viewport 900x700] [--shots DIR]
  uv run --with playwright==1.65.2 python scripts/sweep_figures.py mobile out/board.html [more.html ...]
      [--viewport 390x844] [--viewport 375x812] [--shots DIR]
  uv run --with playwright==1.65.2 python scripts/sweep_figures.py shot out/board.html out.png
      [--viewport 1440x900] [--state '{"ruleId": "...", "focusByRule": {...}, "evOpen": true}'] [--full]

`sweep` opens each board at each viewport, shows every rule in every state in focus view, and fails
(exit 1) on any console or page error, external request, SVG text outside its box / pill / chip /
viewBox, label pill touching another pill or a box, connector label over a card, clipped text,
horizontal page overflow, a figure with no measured elements, or a figure without exactly one
connector anchor; timeline tick labels touching each other, a pill or a box, and a circled x or start
dot outside its pill or state also fail. Each rule is then opened in its bug focus with the
"Proof & log" drawer open: the trust pill must match __binding (trace-bound only with a bound
--mutant-log), the machine trace must list exactly the bound steps, and nothing may spill out of the
card or the page. `--shots DIR` also saves the board of every view and each drawer as a 2x PNG.
`flow` real-clicks the flow map of each board at each viewport: every journey pill (dimming, summary,
checkpoint CTA), the CTA (lands on the exact checkpoint rule and focus), every stage rule chip, the way
back to the map, and, on index layouts, every status filter on the map (matching chips highlighted, the
rest and empty stages dimmed) followed by a matching and a non-matching chip. It fails on stage or
label overlap, text outside or clipped in a stage, horizontal overflow, or any console error. A board
without a flow must show no flow controls and its overview button must still toggle. No board may
show a search box or a select. With `outOfScope`, the note must sit below the main view in every view
checked, list exactly the JSON entries, fit its box, and keep its open/closed state across re-renders;
without it there must be no note. Above a 760px main column the map must be drawn in 2D; at or below
it the stages must stack, with stage titles of 12px or more and chips 34px or taller. On index layouts
the index, opened from the bottom of the page, must show on screen.
`mobile` opens each board as a touch phone (default 390x844 and 375x812) and runs `flow` and `sweep`
there, then taps through it: the last chip of the stacked map must open its rule with the heading on
screen; every scenario button and the "Proof & log" drawer must respond, the three scenario buttons must share
one row, the rule number must sit beside its title, and every figure must fit whole in its card with
nothing to scroll; on index layouts the index,
opened from the bottom of the page, must show on screen and close when a rule is picked (also the last
rule, after scrolling the index), showing the rule's heading. On every screen the page must not overflow, the bar must scroll with the page and keep its buttons
inside its border, and no header, main-column, scenario or footer element may leave the screen or clip.
A 1440x900 control checks that the sticky index stays open after a pick.
`shot` saves one 2x screenshot of a board after applying a state.
"""

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

PROBE_JS = """() => {
  const de = document.documentElement;
  const root = document.getElementById('proof-canvas-root');
  const svg = root.querySelector('.board .fg-svg');
  const out = { svgOverflow: 0, pillHits: 0, markHits: 0, measured: 0, anchors: 0, lkOverlap: 0, clipped: 0, overflowX: de.scrollWidth - de.clientWidth, connector: 0 };
  if (!svg) return out;
  const bb = (el) => el.getBBox();
  const outside = (t, r) => Math.max(0, r.x - t.x, t.x + t.width - (r.x + r.width), r.y - t.y, t.y + t.height - (r.y + r.height));
  const meets = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
  const view = { x: 0, y: 0, width: 740, height: 328 };
  const boxes = [...svg.querySelectorAll('.fg-box')];
  const arrows = [...svg.querySelectorAll('.fg-arrow')];
  out.measured = boxes.length + arrows.length;
  out.anchors = svg.querySelectorAll('[data-anchor]').length;
  for (const g of boxes) {
    const r = bb(g.querySelector(':scope > rect'));
    for (const t of g.querySelectorAll('text')) out.svgOverflow = Math.max(out.svgOverflow, outside(bb(t), r));
  }
  for (const g of svg.querySelectorAll('.fg-chip')) out.svgOverflow = Math.max(out.svgOverflow, outside(bb(g.querySelector('text')), bb(g.querySelector('rect'))));
  const pills = arrows.map((g) => { const r = bb(g.querySelector('rect.fg-apill')); out.svgOverflow = Math.max(out.svgOverflow, outside(bb(g.querySelector('text.fg-alabel')), r)); return r; });
  for (const t of svg.querySelectorAll('text')) out.svgOverflow = Math.max(out.svgOverflow, outside(bb(t), view));
  const solid = [...boxes.map((g) => bb(g.querySelector(':scope > rect'))), ...[...svg.querySelectorAll('.fg-chip rect')].map(bb)];
  pills.forEach((p, i) => {
    for (const q of pills.slice(i + 1)) if (meets(p, q)) out.pillHits += 1;
    for (const s of solid) if (meets(p, s)) out.pillHits += 1;
  });
  // Marks outside boxes and pills: timeline tick labels must not touch each other, a pill or a box;
  // a forbidden transition's circled x stays inside its pill; a start dot stays inside its state.
  const ticks = [...svg.querySelectorAll('.fg-tick text')].map(bb);
  ticks.forEach((t, i) => {
    for (const u of ticks.slice(i + 1)) if (meets(t, u)) out.markHits += 1;
    for (const s of [...pills, ...solid]) if (meets(t, s)) out.markHits += 1;
  });
  for (const x of svg.querySelectorAll('.fg-x')) if (outside(bb(x), bb(x.parentElement.querySelector('rect.fg-apill'))) > 0) out.markHits += 1;
  for (const d of svg.querySelectorAll('.fg-start')) if (outside(bb(d), bb(d.parentElement.querySelector(':scope > rect'))) > 0) out.markHits += 1;
  const cards = [...root.querySelectorAll('.board > .card')].map((c) => c.getBoundingClientRect());
  for (const l of root.querySelectorAll('.lk-label')) {
    const a = l.getBoundingClientRect();
    for (const c of cards) {
      const w = Math.min(a.right, c.right) - Math.max(a.left, c.left);
      const h = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      if (w > 0 && h > 0) out.lkOverlap = Math.max(out.lkOverlap, Math.min(w, h));
    }
  }
  for (const el of root.querySelectorAll('.pv-bar-lbl, .pv-bar-val, .lk-label, .fx button, .fx-cue, .pv-v, .pv-k, .pv-live')) {
    if (el.scrollWidth > el.clientWidth + 1) out.clipped += 1;
  }
  out.connector = root.querySelectorAll('.link-layer .lk-path').length;
  out.svgOverflow = Math.round(out.svgOverflow * 10) / 10;
  return out;
}"""

FAIL_IF_POSITIVE = ["svgOverflow", "pillHits", "markHits", "lkOverlap", "clipped", "overflowX"]

# The open "Proof & log" drawer and the scenario bar of a rule in its bug focus: the trust pill must
# say what __binding says (trace-bound only with a bound --mutant-log), the machine trace must list
# exactly the bound steps, and nothing may overflow the card or the page.
DRAWER_PROBE_JS = """(rid) => {
  const de = document.documentElement;
  const root = document.getElementById('proof-canvas-root');
  const b = window.__proofCanvas.getBoard().__binding || {};
  const c = b.counterexamples && Object.hasOwn(b.counterexamples, rid) ? b.counterexamples[rid] : null;
  const bar = root.querySelector('.fig .fx-meta');
  const card = root.querySelector('.fig').getBoundingClientRect();
  const ev = root.querySelector('.ev');
  const out = { overflowX: de.scrollWidth - de.clientWidth, wrongPill: 0, wrongTrace: 0, spill: 0, clipped: 0 };
  const pill = bar && bar.querySelector('.tp');
  const want = !c ? 'tp-illus' : c.violatedProperty === null ? 'tp-unnamed' : 'tp-bound';
  if (!pill || !pill.classList.contains(want)) out.wrongPill += 1;
  const steps = [...ev.querySelectorAll('.tr-steps li')].map((li) => li.textContent);
  if (c ? JSON.stringify(steps) !== JSON.stringify(c.steps) : steps.length) out.wrongTrace += 1;
  if (bar && bar.getBoundingClientRect().right > card.right + 0.5) out.spill += 1;
  const er = ev.getBoundingClientRect();
  for (const el of ev.querySelectorAll('.tr-steps li, .kv span, .kv code, .ev-facts li, .term')) {
    const r = el.getBoundingClientRect();
    if (r.right > er.right + 0.5) out.spill += 1;
  }
  for (const el of root.querySelectorAll('.tp, .fx-prop')) if (el.scrollWidth > el.clientWidth + 1) out.clipped += 1;
  return out;
}"""

# Geometry of the flow map: stage cards, edge-label pills and the text inside each, in CSS pixels.
FLOW_PROBE_JS = """() => {
  const de = document.documentElement;
  const fl = document.querySelector('#proof-canvas-root [data-flow]');
  const out = { overflowX: de.scrollWidth - de.clientWidth, stageHits: 0, pillHits: 0, outside: 0, clipped: 0, offCard: 0, wrongLayout: 0, small: 0 };
  if (!fl) return null;
  // The map is drawn in 2D above a 760px main column and reflowed into stacked stages at or below it,
  // where stage titles are at least 12px and chips finger-sized (34px or taller).
  const stacked = getComputedStyle(fl.querySelector('.fl-svg')).display === 'none';
  if (stacked !== (document.querySelector('#proof-canvas-root .pc-main').clientWidth <= 760)) out.wrongLayout = 1;
  if (stacked) {
    for (const t of fl.querySelectorAll('.fl-st-t')) if (parseFloat(getComputedStyle(t).fontSize) < 12) out.small += 1;
    for (const c of fl.querySelectorAll('.fl-chip')) if (c.getBoundingClientRect().height < 34) out.small += 1;
  }
  const R = (el) => el.getBoundingClientRect();
  const meets = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) > 0.5 && Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) > 0.5;
  const outside = (t, r) => Math.max(0, r.left - t.left, t.right - r.right, r.top - t.top, t.bottom - r.bottom);
  const stages = [...fl.querySelectorAll('.fl-stage')];
  const sr = stages.map(R);
  sr.forEach((a, i) => { for (const b of sr.slice(i + 1)) if (meets(a, b)) out.stageHits += 1; });
  stages.forEach((s, i) => {
    for (const c of s.querySelectorAll('.fl-st-t, .fl-st-s, .fl-st-b, .fl-chip')) out.outside = Math.max(out.outside, outside(R(c), sr[i]));
    for (const c of s.querySelectorAll('.fl-st-t, .fl-chip-t')) if (c.scrollWidth > c.clientWidth + 1) out.clipped += 1;
    for (const c of s.querySelectorAll('.fl-st-s')) if (c.scrollHeight > c.clientHeight + 1) out.clipped += 1;
    if (s.scrollHeight > s.clientHeight + 1) out.clipped += 1;
  });
  const canvas = R(fl.querySelector('.fl-canvas'));
  const pills = stacked ? [] : [...fl.querySelectorAll('.fl-edge')].map((g) => {
    const p = R(g.querySelector('.fl-pill'));
    out.outside = Math.max(out.outside, outside(R(g.querySelector('.fl-elabel')), p), outside(p, canvas));
    return p;
  });
  pills.forEach((p, i) => {
    for (const q of pills.slice(i + 1)) if (meets(p, q)) out.pillHits += 1;
    for (const s of sr) if (meets(p, s)) out.pillHits += 1;
  });
  const card = R(fl);
  for (const el of fl.querySelectorAll('.fl-canvas, .fl-jbar button, .fl-foot > *, .fl-cap, .fl-head > *')) if (R(el).width) out.offCard = Math.max(out.offCard, outside(R(el), card));
  out.outside = Math.round(out.outside * 10) / 10;
  out.offCard = Math.round(out.offCard * 10) / 10;
  return out;
}"""

# What the page shows after a click: enough to check navigation against the board JSON.
FLOW_SEEN_JS = """() => {
  const root = document.getElementById('proof-canvas-root');
  const S = window.__proofCanvas.getState();
  const fl = root.querySelector('[data-flow]');
  const cls = (sel, attr) => Object.fromEntries([...root.querySelectorAll(sel)].map((el) => [el.getAttribute(attr), el.classList.contains('is-on') ? 'on' : el.classList.contains('is-dim') ? 'dim' : '']));
  const pressed = root.querySelector('.board [data-act="focus"][aria-pressed="true"]');
  const navOn = root.querySelector('.ix-row[aria-current="true"], .pc-float-bar [data-act="rule"][aria-pressed="true"]');
  const tag = (el) => (el.classList.contains('is-hit') ? 'hit' : el.classList.contains('is-off') ? 'off' : '');
  return {
    view: S.view, ruleId: S.ruleId, journey: S.journey, status: S.status, focus: S.focusByRule[S.ruleId] || null,
    flow: fl ? fl.dataset.journey : null,
    stages: cls('.fl-stage', 'data-step'), edges: cls('.fl-edge', 'data-edge'),
    sum: fl && fl.querySelector('.fl-sum') ? fl.querySelector('.fl-sum').textContent : null,
    cta: fl && fl.querySelector('.fl-cta') ? fl.querySelector('.fl-cta').dataset.v : null,
    cp: fl && fl.querySelector('.fl-chip.is-cp') ? fl.querySelector('.fl-chip.is-cp').dataset.v : null,
    board: root.querySelector('.board[data-board^="focus-"]') ? root.querySelector('.board[data-board^="focus-"]').dataset.board : null,
    pressedFocus: pressed ? pressed.dataset.v : null,
    navOn: navOn ? navOn.dataset.v : null,
    chips: fl ? Object.fromEntries([...fl.querySelectorAll('.fl-chip')].map((el) => [el.dataset.v, [[...el.classList].find((c) => c.startsWith('st-')).slice(3), tag(el)]])) : null,
    stageOff: fl ? Object.fromEntries([...fl.querySelectorAll('.fl-stage')].map((el) => [el.dataset.step, el.classList.contains('is-off')])) : null,
    fields: root.querySelectorAll('input, select, textarea, #pc-q, #pc-module, .pc-search, .pc-select').length,
    ixCount: root.querySelector('.ix-count') ? root.querySelector('.ix-count').textContent : null,
  };
}"""

# The out-of-scope note: where it sits, what it lists and whether anything in it overflows.
OOS_PROBE_JS = """() => {
  const root = document.getElementById('proof-canvas-root');
  const el = root.querySelector('.pc-oos');
  if (!el) return null;
  const R = (e) => e.getBoundingClientRect();
  const box = R(el);
  let outside = 0;
  for (const c of el.querySelectorAll('summary, li, b')) { const r = R(c); outside = Math.max(outside, box.left - r.left, r.right - box.right); }
  const main = [...root.querySelectorAll('.pc-main > :not(.pc-oos)')].map(R);
  return {
    open: el.open, overflow: el.scrollWidth - el.clientWidth, outside: Math.round(outside * 10) / 10,
    above: main.filter((r) => r.bottom > box.top + 0.5).length,
    items: [...el.querySelectorAll('li')].map((li) => { const b = li.querySelector('b').textContent; return [b, li.textContent.slice(b.length)]; }),
  };
}"""


class MissingControl(Exception):
    """A control the sweep must click is not on screen."""


def checkpoint_focus(j):
    """Mirror of flow.mjs checkpointFocus: the explicit focus, else the one the journey tone implies."""
    return j.get("checkpointFocus") or {"bug": "bug", "safe": "fixed"}.get(j["tone"], "normal")


def flow_sweep(browser, html, viewports, shots, phone=False):
    """Real-click every flow control of one board at each viewport. Returns (clicks, failures)."""
    name = Path(html).name
    failures, clicks = [], 0

    def fail(where, msg):
        failures.append(f"{name} {where}: {msg}")

    for w, h in viewports:
        at = f"{w}x{h}"
        page, log = open_board(browser, html, w, h, phone)
        board = page.evaluate("window.__proofCanvas.getBoard()")
        layout = page.evaluate("window.__proofCanvas.layout")
        hub_sel = '.pc-float-bar [data-act="view"][data-v="flow"]'

        def click(sel, label):
            nonlocal clicks
            if not page.locator(sel).count():
                raise MissingControl(f"{sel} for {label}")
            page.locator(sel).first.click()
            clicks += 1
            settle(page)
            return page.evaluate(FLOW_SEEN_JS)

        def probe(label):
            p = page.evaluate(FLOW_PROBE_JS)
            if p is None:
                fail(f"{at} {label}", "no flow map on screen")
                return
            bad = [f"{k}={v}" for k, v in p.items() if v > 0]
            if bad:
                fail(f"{at} {label}", ", ".join(bad))
            if shots:
                Path(shots).mkdir(parents=True, exist_ok=True)
                page.locator("[data-flow]").screenshot(path=str(Path(shots) / f"{Path(html).stem}-{w}-{label}.png"))

        def oos(label):
            o = page.evaluate(OOS_PROBE_JS)
            want = [[x["area"], x["reason"]] for x in board.get("outOfScope", [])]
            if not want:
                if o is not None:
                    fail(f"{at} {label}", "out-of-scope note on a board without outOfScope")
                return
            if o is None:
                fail(f"{at} {label}", "no out-of-scope note")
                return
            bad = [f"{k}={o[k]}" for k in ("overflow", "outside", "above") if o[k] > 0]
            if o["items"] != want:
                bad.append(f"items={o['items']}")
            if bad:
                fail(f"{at} {label} out-of-scope", ", ".join(bad))

        try:
            if page.evaluate(FLOW_SEEN_JS)["fields"]:
                fail(at, "a search box or select is on screen")
            oos("first")
            flow = board.get("flow")
            if not flow:
                # A board without a flow must not grow one; its overview button still toggles.
                if page.locator('[data-flow], [data-v="flow"]').count():
                    fail(at, "flow markup on a board without flow")
                s = click('.pc-float-bar [data-act="view"][data-v="overview"]', "overview")
                if s["view"] != "overview":
                    fail(at, f"overview button opened view={s['view']}")
                oos("overview")
                s = click('.pc-float-bar [data-act="view"][data-v="overview"]', "overview-back")
                if s["view"] != "focus":
                    fail(at, f"second overview click left view={s['view']}")
                if layout == "index":
                    # A module card opens that module's first rule the status filter shows; it never filters.
                    rules = board["rules"]
                    status = lambda r: r.get("status") if r.get("status") in ("verified", "failed") else "pending"
                    for st in ["all"] + page.eval_on_selector_all('[data-act="status"]:not([disabled])', "(els) => els.map((e) => e.dataset.v)")[1:2]:
                        click(f'[data-act="status"][data-v="{st}"]', f"status-{st}")
                        for m in board.get("modules") or []:
                            first = next((r["id"] for r in rules if r["moduleId"] == m["id"] and st in ("all", status(r))), None)
                            if first is None:
                                continue
                            click('.pc-float-bar [data-act="view"][data-v="overview"]', f"overview-{st}-{m['id']}")
                            s = click(f'.hub-head[data-v="{m["id"]}"]', f"module-{st}-{m['id']}")
                            shown = sum(1 for r in rules if st in ("all", status(r)))
                            got = (s["view"], s["ruleId"], s["status"], s["ixCount"])
                            want = ("focus", first, st, f"{shown} / {len(rules)}")
                            if got != want:
                                fail(f"{at} module card {m['id']} ({st})", f"landed on {got}, want {want}")
                    click('[data-act="status"][data-v="all"]', "status-reset")
            else:
                steps = {st["id"]: st for st in flow["steps"]}
                s = page.evaluate(FLOW_SEEN_JS)
                want_view = "flow" if board.get("defaultView") == "flow" else "focus"
                if s["view"] != want_view:
                    fail(at, f"initial view={s['view']}, defaultView wants {want_view}")
                if s["view"] != "flow":
                    s = click(hub_sel, "hub")
                probe("all")
                oos("flow")
                if board.get("outOfScope"):
                    # Closing the note must survive a re-render (a journey click), then reopen it.
                    page.locator(".pc-oos > summary").click()
                    clicks += 1
                    jb = flow.get("journeys", [{"id": "*"}])[0]["id"]
                    click(f'.fl-jbar [data-act="journey"][data-v="{jb}"]', "oos-rerender")
                    if page.evaluate(OOS_PROBE_JS)["open"]:
                        fail(at, "the out-of-scope note reopened after a re-render")
                    page.locator(".pc-oos > summary").click()
                    clicks += 1
                    click('.fl-jbar [data-act="journey"][data-v="*"]', "oos-back")
                    if not page.evaluate(OOS_PROBE_JS)["open"]:
                        fail(at, "the out-of-scope note did not reopen")
                for j in flow.get("journeys", []):
                    s = click(f'.fl-jbar [data-act="journey"][data-v="{j["id"]}"]', j["id"])
                    exp_st = {k: ("on" if k in j["stepIds"] else "dim") for k in steps}
                    exp_ed = {e["id"]: ("on" if e["id"] in j.get("edgeIds", []) else "dim") for e in flow["edges"]}
                    if s["journey"] != j["id"] or s["flow"] != j["id"]:
                        fail(f"{at} {j['id']}", f"journey state={s['journey']} markup={s['flow']}")
                    if s["stages"] != exp_st or s["edges"] != exp_ed:
                        fail(f"{at} {j['id']}", f"dimming stages={s['stages']} edges={s['edges']}")
                    if s["sum"] != j["summary"]:
                        fail(f"{at} {j['id']}", f"summary shows {s['sum']!r}")
                    probe(j["id"])
                    cp = j.get("checkpointRuleId")
                    if not cp:
                        if s["cta"] is not None:
                            fail(f"{at} {j['id']}", "CTA without a checkpoint")
                        continue
                    if s["cta"] != j["id"] or s["cp"] != cp:
                        fail(f"{at} {j['id']}", f"CTA={s['cta']} checkpoint chip={s['cp']}")
                    s = click(".fl-foot .fl-cta", f"{j['id']}-cta")
                    focus = checkpoint_focus(j)
                    got = (s["view"], s["ruleId"], s["focus"], s["board"], s["pressedFocus"], s["navOn"])
                    want = ("focus", cp, focus, f"focus-{cp}", focus, cp)
                    if got != want:
                        fail(f"{at} {j['id']} CTA", f"landed on {got}, want {want}")
                    s = click(hub_sel, f"{j['id']}-back")
                    if s["view"] != "flow" or s["flow"] != j["id"]:
                        fail(f"{at} {j['id']} back", f"view={s['view']} journey={s['flow']}")
                s = click('.fl-jbar [data-act="journey"][data-v="*"]', "all")
                if s["flow"] != "*" or any(v == "dim" for v in s["stages"].values()):
                    fail(f"{at} all", f"journey={s['flow']} stages={s['stages']}")
                chips = page.eval_on_selector_all("[data-flow] .fl-chip", "(els) => els.map((e) => e.dataset.v)")
                for rid in chips:
                    s = click(f'[data-flow] .fl-chip[data-v="{rid}"]', f"chip-{rid}")
                    if (s["view"], s["ruleId"], s["board"], s["navOn"]) != ("focus", rid, f"focus-{rid}", rid):
                        fail(f"{at} chip {rid}", f"view={s['view']} rule={s['ruleId']} board={s['board']} nav={s['navOn']}")
                    oos(f"chip-{rid}")
                    s = click(hub_sel, f"chip-{rid}-back")
                    if s["view"] != "flow":
                        fail(f"{at} chip {rid} back", f"view={s['view']}")
                if layout == "index":
                    # Each status filter on the map: matching chips highlighted, the rest and stages with
                    # no match dimmed; a matching chip keeps the filter, a non-matching one clears it.
                    stat = {rid: v[0] for rid, v in page.evaluate(FLOW_SEEN_JS)["chips"].items()}
                    picks = page.eval_on_selector_all('[data-act="status"]:not([disabled])', "(els) => els.map((e) => e.dataset.v)")
                    for st in [v for v in picks if v != "all"]:
                        s = click(f'[data-act="status"][data-v="{st}"]', f"status-{st}")
                        exp_chips = {rid: [v, "hit" if v == st else "off"] for rid, v in stat.items()}
                        exp_off = {k: not any(stat[r] == st for r in page.eval_on_selector_all(f'[data-flow] .fl-stage[data-step="{k}"] .fl-chip', "(els) => els.map((e) => e.dataset.v)")) for k in steps}
                        if (s["view"], s["status"]) != ("flow", st) or s["chips"] != exp_chips or s["stageOff"] != exp_off:
                            fail(f"{at} status {st}", f"view={s['view']} status={s['status']} chips={s['chips']} stageOff={s['stageOff']}")
                        probe(f"status-{st}")
                        for rid in [next((r for r in chips if stat[r] == st), None), next((r for r in chips if stat[r] != st), None)]:
                            if rid is None:
                                continue
                            s = click(f'[data-flow] .fl-chip[data-v="{rid}"]', f"status-{st}-chip-{rid}")
                            keep = st if stat[rid] == st else "all"
                            got = (s["view"], s["ruleId"], s["status"], s["board"], s["navOn"])
                            want = ("focus", rid, keep, f"focus-{rid}", rid)
                            if got != want:
                                fail(f"{at} status {st} chip {rid}", f"landed on {got}, want {want}")
                            s = click(hub_sel, f"status-{st}-chip-{rid}-back")
                            if s["status"] == st:
                                continue
                            s = click(f'[data-act="status"][data-v="{st}"]', f"status-{st}-again")
                        s = click('[data-act="status"][data-v="all"]', f"status-{st}-clear")
                        if s["status"] != "all" or any(v[1] for v in s["chips"].values()) or any(s["stageOff"].values()):
                            fail(f"{at} status all", f"chips={s['chips']} stageOff={s['stageOff']}")
            if layout == "index":
                # Opened from the bottom of the page, the index shows on screen (sticky beside the main
                # view, or scrolled into sight above it).
                if page.evaluate("window.__proofCanvas.getState().indexOpen"):
                    click('[data-act="index"]', "index-close")
                page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
                click('[data-act="index"]', "index-open")
                r = page.evaluate("() => { const n = document.querySelector('#pc-index'), b = n.getBoundingClientRect(); return [b.top, b.bottom, getComputedStyle(n).position]; }")
                # A sticky index is pushed up by the end of its column, so only overlap is required.
                if not (r[0] < h and r[1] > 0 and (r[2] == "sticky" or r[0] >= 0)):
                    fail(f"{at} index open", f"{r[2]} #pc-index spans {r[0]:.0f}..{r[1]:.0f}px, off screen")
        except MissingControl as e:
            fail(at, f"no clickable control {e} (the previous step left the wrong screen)")
        for kind in ["console", "pageErrors", "external"]:
            if log[kind]:
                fail(at, f"{kind}: {log[kind][:3]}")
        page.close()
    return clicks, failures

# A phone screen: no page overflow, the bar scrolls away with the page and keeps every button inside
# its border, nothing in the header, main column or footer leaves the screen, and no control is clipped.
PHONE_PROBE_JS = """() => {
  const de = document.documentElement;
  const root = document.getElementById('proof-canvas-root');
  const R = (el) => el.getBoundingClientRect();
  const out = { overflowX: de.scrollWidth - de.clientWidth, sticky: 0, spill: 0, offScreen: 0, clipped: 0, segRows: 0, badgeApart: 0, figCut: 0 };
  // Every figure fits whole in its card: the drawing inside its wrapper, and nothing to scroll.
  for (const w of root.querySelectorAll('.fg-wrap')) {
    const a = R(w), s = R(w.querySelector('.fg-svg'));
    if (s.left < a.left - 0.5 || s.right > a.right + 0.5 || w.scrollWidth > w.clientWidth + 1) out.figCut += 1;
  }
  // The three scenario buttons share one row, and the rule number sits beside its title.
  const seg = [...root.querySelectorAll('.fig .fx-seg button')].map((b) => R(b).top);
  if (seg.some((t) => Math.abs(t - seg[0]) > 4)) out.segRows = 1;
  const no = root.querySelector('.fig-head .no');
  if (no && Math.abs(R(no).top - R(root.querySelector('.fig-title')).top) > 6) out.badgeApart = 1;
  if (getComputedStyle(root.querySelector('.pc-float-wrap')).position !== 'static') out.sticky = 1;
  const bar = R(root.querySelector('.pc-float-bar'));
  for (const el of root.querySelectorAll('.pc-float-bar button')) {
    const r = R(el);
    if (r.left < bar.left - 0.5 || r.right > bar.right + 0.5 || r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5) out.spill += 1;
  }
  for (const el of root.querySelectorAll('.pc-head > *, .pc-float-bar, .pc-main > *, .fx > *, .pc-foot > *')) {
    const r = R(el);
    if (r.width && (r.left < -0.5 || r.right > de.clientWidth + 0.5)) out.offScreen += 1;
  }
  for (const el of root.querySelectorAll('.pc-float-bar button, .fx button, .fx-scope, .fl-jbar button, .crumb-pos')) if (el.scrollWidth > el.clientWidth + 1) out.clipped += 1;
  return out;
}"""

# Top of an element relative to the viewport, or null when it is not on the page.
TOP_JS = "(sel) => { const el = document.querySelector('#proof-canvas-root ' + sel); return el ? el.getBoundingClientRect().top : null; }"


def phone_sweep(browser, html, viewports, shots):
    """Real taps on a phone: the flow map's last chip, every scenario button, the evidence drawer, and
    on index layouts the index opened from the bottom of the page and closed by a rule pick. A desktop
    control keeps the index open after a pick. Returns (taps, failures)."""
    name = Path(html).name
    failures, taps = [], 0

    def fail(where, msg):
        failures.append(f"{name} {where}: {msg}")

    for w, h in viewports:
        at = f"{w}x{h}"
        page, log = open_board(browser, html, w, h, phone=True)
        board = page.evaluate("window.__proofCanvas.getBoard()")
        layout = page.evaluate("window.__proofCanvas.layout")
        state = lambda: page.evaluate("window.__proofCanvas.getState()")

        def tap(loc, label):
            nonlocal taps
            if not loc.count():
                raise MissingControl(label)
            loc.tap()
            taps += 1
            settle(page)

        def probe(label):
            p = page.evaluate(PHONE_PROBE_JS)
            bad = [f"{k}={v}" for k, v in p.items() if v > 0]
            if bad:
                fail(f"{at} {label}", ", ".join(bad))
            if shots:
                Path(shots).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(Path(shots) / f"{Path(html).stem}-{w}-{label}.png"))

        def on_screen(sel, label):
            top = page.evaluate(TOP_JS, sel)
            if top is None or not 0 <= top < h:
                fail(f"{at} {label}", f"{sel} top={top} is off screen")

        try:
            if page.evaluate("innerWidth") != w:
                fail(at, f"the page lays out at {page.evaluate('innerWidth')}px, not the {w}px screen")
            probe("start")
            if board.get("flow"):
                if state()["view"] != "flow":
                    tap(page.locator('.pc-float-bar [data-act="view"][data-v="flow"]'), "flow button")
                probe("flow")
                # The last chip sits at the end of the stacked map; its rule must open at its heading.
                last = page.locator("[data-flow] .fl-chip").last
                rid = last.get_attribute("data-v")
                tap(last, "last flow chip")
                if (state()["view"], state()["ruleId"]) != ("focus", rid):
                    fail(f"{at} last chip", f"landed on {state()['view']}/{state()['ruleId']}, want focus/{rid}")
                on_screen(".fig-title", "last chip")
            elif state()["view"] != "focus":
                page.evaluate("(s) => window.__proofCanvas.setState(s)", {"view": "focus"})
            for k in ["normal", "bug", "fixed"]:
                tap(page.locator(f'.fx [data-act="focus"][data-v="{k}"]'), f"scenario {k}")
                if page.locator(f'.fx [data-act="focus"][data-v="{k}"][aria-pressed="true"]').count() != 1:
                    fail(f"{at} scenario {k}", "the tapped scenario is not pressed")
                probe(f"scenario-{k}")
            tap(page.locator('[data-act="ev"]'), "evidence toggle")
            if page.locator('[data-act="ev"][aria-expanded="true"]').count() != 1:
                fail(f"{at} evidence", "the drawer did not open")
            probe("evidence")
            if layout == "index":
                # Opened from the bottom of the page, the index shows on screen; a pick closes it and
                # shows the rule.
                page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
                tap(page.locator('[data-act="index"]'), "index toggle")
                if not state()["indexOpen"]:
                    fail(f"{at} index", "the index did not open")
                on_screen(".pc-index", "index open")
                probe("index")
                row = page.locator(".ix-row").nth(1)
                rid = row.get_attribute("data-v")
                tap(row, "index row")
                s = state()
                if (s["indexOpen"], s["view"], s["ruleId"]) != (False, "focus", rid):
                    fail(f"{at} index pick", f"indexOpen={s['indexOpen']} view={s['view']} rule={s['ruleId']}, want closed on {rid}")
                on_screen(".fig-title", "index pick")
                probe("index-pick")
                # The last rule, reached by scrolling the index and then the page until only the end
                # of the index shows, opens at its heading too (the closing index moves it up).
                if not state()["indexOpen"]:
                    tap(page.locator('[data-act="index"]'), "index toggle again")
                page.evaluate("() => { const n = document.querySelector('#pc-index'); n.scrollTop = n.scrollHeight; window.scrollBy(0, n.getBoundingClientRect().bottom - 120); }")
                row = page.locator(".ix-row").last
                rid = row.get_attribute("data-v")
                tap(row, "last index row")
                s = state()
                if (s["indexOpen"], s["view"], s["ruleId"]) != (False, "focus", rid):
                    fail(f"{at} last index row", f"indexOpen={s['indexOpen']} view={s['view']} rule={s['ruleId']}, want closed on {rid}")
                on_screen(".fig-title", "last index row")
        except MissingControl as e:
            fail(at, f"no tappable {e} (the previous step left the wrong screen)")
        for kind in ["console", "pageErrors", "external"]:
            if log[kind]:
                fail(at, f"{kind}: {log[kind][:3]}")
        page.close()
    if layout == "index":
        # Control: beside a wide main view the index is sticky and stays open after a pick.
        page, log = open_board(browser, html, 1440, 900)
        if not page.evaluate("window.__proofCanvas.getState().indexOpen"):
            page.locator('[data-act="index"]').click()
        page.locator(".ix-row").nth(1).click()
        settle(page)
        if not page.evaluate("window.__proofCanvas.getState().indexOpen"):
            fail("1440x900", "a rule pick closed the sticky index")
        page.close()
    return taps, failures


def parse_viewports(args, default):
    vps = [tuple(int(x) for x in a.split("x")) for a in args] or [default]
    return vps


def open_board(browser, html, w, h, phone=False):
    page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=2, is_mobile=phone, has_touch=phone)
    log = {"console": [], "pageErrors": [], "external": []}
    page.on("console", lambda m: log["console"].append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: log["pageErrors"].append(str(e)))
    page.on("request", lambda r: log["external"].append(r.url) if not r.url.startswith(("file:", "data:", "blob:", "about:")) else None)
    page.goto(Path(html).resolve().as_uri(), wait_until="load")
    page.wait_for_function("window.__proofCanvas && window.__proofCanvas.readyAt")
    return page, log


def settle(page):
    page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def sweep(browser, html, viewports, shots, phone=False):
    failures = []
    views = 0
    for w, h in viewports:
        page, log = open_board(browser, html, w, h, phone)
        rules = page.evaluate("window.__proofCanvas.getBoard().rules.map((r) => r.id)")
        for rid in rules:
            for k in ["normal", "bug", "fixed"]:
                page.evaluate("(s) => window.__proofCanvas.setState(s)",
                              {"view": "focus", "ruleId": rid, "status": "all", "focusByRule": {rid: k}})
                settle(page)
                p = page.evaluate(PROBE_JS)
                views += 1
                bad = [f"{f}={p[f]}" for f in FAIL_IF_POSITIVE if p[f] > 0]
                if p["measured"] == 0:
                    bad.append("measured=0")
                if p["anchors"] != 1:
                    bad.append(f"anchors={p['anchors']}")
                if bad:
                    failures.append(f"{Path(html).name} {w}x{h} {rid}/{k}: {', '.join(bad)}")
                if shots:
                    Path(shots).mkdir(parents=True, exist_ok=True)
                    page.locator(".board").first.screenshot(path=str(Path(shots) / f"{Path(html).stem}-{w}-{rid}-{k}.png"))
            page.evaluate("(s) => window.__proofCanvas.setState(s)",
                          {"view": "focus", "ruleId": rid, "status": "all", "focusByRule": {rid: "bug"}, "evOpen": True})
            settle(page)
            d = page.evaluate(DRAWER_PROBE_JS, rid)
            views += 1
            bad = [f"{f}={d[f]}" for f in d if d[f] > 0]
            if bad:
                failures.append(f"{Path(html).name} {w}x{h} {rid}/drawer: {', '.join(bad)}")
            if shots:
                page.locator(".ev").first.screenshot(path=str(Path(shots) / f"{Path(html).stem}-{w}-{rid}-drawer.png"))
        for kind in ["console", "pageErrors", "external"]:
            if log[kind]:
                failures.append(f"{Path(html).name} {w}x{h} {kind}: {log[kind][:3]}")
        page.close()
    return views, failures


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ("sweep", "flow", "mobile", "shot"):
        raise SystemExit(__doc__)
    cmd, rest = args[0], args[1:]
    files, vps, opts = [], [], {}
    i = 0
    while i < len(rest):
        a = rest[i]
        if a in ("--viewport", "--shots", "--state"):
            if a == "--viewport":
                vps.append(rest[i + 1])
            else:
                opts[a] = rest[i + 1]
            i += 2
        elif a == "--full":
            opts[a] = True
            i += 1
        else:
            files.append(a)
            i += 1
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        if cmd == "sweep":
            total, failures = 0, []
            for html in files:
                n, f = sweep(browser, html, parse_viewports(vps, (1440, 900)), opts.get("--shots"))
                total += n
                failures += f
                print(f"{html}: {n} views, {len(f)} failure(s)")
            browser.close()
            for f in failures:
                print("FAIL " + f)
            print(f"sweep: {total} views, {len(failures)} failure(s)")
            sys.exit(1 if failures else 0)
        if cmd == "mobile":
            phones = parse_viewports(vps, (390, 844)) if vps else [(390, 844), (375, 812)]
            totals, failures = [0, 0, 0], []
            for html in files:
                for i, run in enumerate([phone_sweep, flow_sweep, sweep]):
                    n, f = run(browser, html, phones, opts.get("--shots")) if run is phone_sweep else run(browser, html, phones, opts.get("--shots"), phone=True)
                    totals[i] += n
                    failures += f
                print(f"{html}: {len(failures)} failure(s) so far")
            browser.close()
            for f in failures:
                print("FAIL " + f)
            print(f"mobile: {len(files)} board(s) at {phones}, {totals[0]} taps, {totals[1]} flow clicks, {totals[2]} views, {len(failures)} failure(s)")
            sys.exit(1 if failures else 0)
        if cmd == "flow":
            total, failures = 0, []
            for html in files:
                n, f = flow_sweep(browser, html, parse_viewports(vps, (1440, 900)), opts.get("--shots"))
                total += n
                failures += f
                print(f"{html}: {n} clicks, {len(f)} failure(s)")
            browser.close()
            for f in failures:
                print("FAIL " + f)
            print(f"flow: {len(files)} board(s), {total} real clicks, {len(failures)} failure(s)")
            sys.exit(1 if failures else 0)
        html, out_png = files
        (w, h), = parse_viewports(vps, (1440, 900))
        page, log = open_board(browser, html, w, h)
        if "--state" in opts:
            page.evaluate("(s) => window.__proofCanvas.setState(s)", json.loads(opts["--state"]))
        page.wait_for_timeout(500)
        page.screenshot(path=out_png, full_page=bool(opts.get("--full")))
        errs = log["console"] + log["pageErrors"] + log["external"]
        browser.close()
        if errs:
            raise SystemExit(f"sweep_figures: errors while capturing {out_png}: {errs}")
        print(f"wrote {out_png}")


if __name__ == "__main__":
    main()
