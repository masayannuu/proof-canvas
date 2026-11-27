"""Headless Chromium layout sweep and screenshots for proof-canvas boards (helper, not needed to use the boards).

  uv run --with playwright==1.65.2 python scripts/sweep_figures.py sweep out/board.html [more.html ...]
      [--viewport 1440x900] [--viewport 900x700] [--shots DIR]
  uv run --with playwright==1.65.2 python scripts/sweep_figures.py flow out/board.html [more.html ...]
      [--viewport 1440x900] [--viewport 900x700] [--shots DIR]
  uv run --with playwright==1.65.2 python scripts/sweep_figures.py shot out/board.html out.png
      [--viewport 1440x900] [--state '{"ruleId": "...", "focusByRule": {...}, "evOpen": true}'] [--full]

`sweep` opens each board at each viewport, shows every rule in every state in focus view, and fails
(exit 1) on any console or page error, external request, SVG text outside its box / pill / chip /
viewBox, label pill touching another pill or a box, connector label over a card, clipped text,
horizontal page overflow, a figure with no measured elements, or a figure without exactly one
connector anchor. `--shots DIR` also saves the board of every view as a 2x PNG.
`flow` real-clicks the flow map of each board at each viewport: every journey pill (dimming, summary,
checkpoint CTA), the CTA (lands on the exact checkpoint rule and focus), every stage rule chip, the way
back to the map, and, on index layouts, a chip clicked while filters hide its rule. It fails on stage
or label overlap, text outside or clipped in a stage, horizontal overflow, or any console error. A
board without a flow must show no flow controls and its overview button must still toggle.
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
  const out = { svgOverflow: 0, pillHits: 0, measured: 0, anchors: 0, lkOverlap: 0, clipped: 0, overflowX: de.scrollWidth - de.clientWidth, connector: 0 };
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

FAIL_IF_POSITIVE = ["svgOverflow", "pillHits", "lkOverlap", "clipped", "overflowX"]

# Geometry of the flow map: stage cards, edge-label pills and the text inside each, in CSS pixels.
FLOW_PROBE_JS = """() => {
  const de = document.documentElement;
  const fl = document.querySelector('#proof-canvas-root [data-flow]');
  const out = { overflowX: de.scrollWidth - de.clientWidth, stageHits: 0, pillHits: 0, outside: 0, clipped: 0, offCard: 0 };
  if (!fl) return null;
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
  const pills = [...fl.querySelectorAll('.fl-edge')].map((g) => {
    const p = R(g.querySelector('.fl-pill'));
    out.outside = Math.max(out.outside, outside(R(g.querySelector('.fl-elabel')), p), outside(p, canvas));
    return p;
  });
  pills.forEach((p, i) => {
    for (const q of pills.slice(i + 1)) if (meets(p, q)) out.pillHits += 1;
    for (const s of sr) if (meets(p, s)) out.pillHits += 1;
  });
  const card = R(fl);
  for (const el of fl.querySelectorAll('.fl-canvas, .fl-jbar button, .fl-foot > *, .fl-cap, .fl-head > *')) out.offCard = Math.max(out.offCard, outside(R(el), card));
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
  const q = root.querySelector('#pc-q');
  return {
    view: S.view, ruleId: S.ruleId, journey: S.journey, status: S.status, module: S.module, q: S.q, focus: S.focusByRule[S.ruleId] || null,
    flow: fl ? fl.dataset.journey : null,
    stages: cls('.fl-stage', 'data-step'), edges: cls('.fl-edge', 'data-edge'),
    sum: fl && fl.querySelector('.fl-sum') ? fl.querySelector('.fl-sum').textContent : null,
    cta: fl && fl.querySelector('.fl-cta') ? fl.querySelector('.fl-cta').dataset.v : null,
    cp: fl && fl.querySelector('.fl-chip.is-cp') ? fl.querySelector('.fl-chip.is-cp').dataset.v : null,
    board: root.querySelector('.board[data-board^="focus-"]') ? root.querySelector('.board[data-board^="focus-"]').dataset.board : null,
    pressedFocus: pressed ? pressed.dataset.v : null,
    navOn: navOn ? navOn.dataset.v : null,
    qValue: q ? q.value : null,
  };
}"""


class MissingControl(Exception):
    """A control the sweep must click is not on screen."""


def checkpoint_focus(j):
    """Mirror of flow.mjs checkpointFocus: the explicit focus, else the one the journey tone implies."""
    return j.get("checkpointFocus") or {"bug": "bug", "safe": "fixed"}.get(j["tone"], "normal")


def flow_sweep(browser, html, viewports, shots):
    """Real-click every flow control of one board at each viewport. Returns (clicks, failures)."""
    name = Path(html).name
    failures, clicks = [], 0

    def fail(where, msg):
        failures.append(f"{name} {where}: {msg}")

    for w, h in viewports:
        at = f"{w}x{h}"
        page, log = open_board(browser, html, w, h)
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

        try:
            flow = board.get("flow")
            if not flow:
                # A board without a flow must not grow one; its overview button still toggles.
                if page.locator('[data-flow], [data-v="flow"]').count():
                    fail(at, "flow markup on a board without flow")
                s = click('.pc-float-bar [data-act="view"][data-v="overview"]', "overview")
                if s["view"] != "overview":
                    fail(at, f"overview button opened view={s['view']}")
                s = click('.pc-float-bar [data-act="view"][data-v="overview"]', "overview-back")
                if s["view"] != "focus":
                    fail(at, f"second overview click left view={s['view']}")
            else:
                steps = {st["id"]: st for st in flow["steps"]}
                s = page.evaluate(FLOW_SEEN_JS)
                want_view = "flow" if board.get("defaultView") == "flow" else "focus"
                if s["view"] != want_view:
                    fail(at, f"initial view={s['view']}, defaultView wants {want_view}")
                if s["view"] != "flow":
                    s = click(hub_sel, "hub")
                probe("all")
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
                    s = click(hub_sel, f"chip-{rid}-back")
                    if s["view"] != "flow":
                        fail(f"{at} chip {rid} back", f"view={s['view']}")
                if layout == "index":
                    # Narrow the index until the target rule is filtered out, then open it from the map.
                    rid = chips[-1]
                    other = page.eval_on_selector_all('[data-act="status"]:not([disabled])', "(els) => els.map((e) => e.dataset.v)")
                    pick = next((v for v in other if v != "all"), None)
                    if pick:
                        click(f'[data-act="status"][data-v="{pick}"]', "status")
                    if page.locator("#pc-module").count():
                        mods = page.eval_on_selector_all("#pc-module option", "(els) => els.map((e) => e.value)")
                        page.locator("#pc-module").select_option(mods[1])
                        clicks += 1
                    page.locator("#pc-q").fill("zz-no-match")
                    settle(page)
                    if page.evaluate("window.__proofCanvas.getState().view") != "flow":
                        click(hub_sel, "hub-filtered")
                    s = click(f'[data-flow] .fl-chip[data-v="{rid}"]', "chip-filtered")
                    got = (s["view"], s["ruleId"], s["status"], s["module"], s["q"], s["qValue"], s["navOn"])
                    want = ("focus", rid, "all", "*", "", "", rid)
                    if got != want:
                        fail(f"{at} filtered chip {rid}", f"landed on {got}, want {want}")
        except MissingControl as e:
            fail(at, f"no clickable control {e} (the previous step left the wrong screen)")
        for kind in ["console", "pageErrors", "external"]:
            if log[kind]:
                fail(at, f"{kind}: {log[kind][:3]}")
        page.close()
    return clicks, failures


def parse_viewports(args, default):
    vps = [tuple(int(x) for x in a.split("x")) for a in args] or [default]
    return vps


def open_board(browser, html, w, h):
    page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=2)
    log = {"console": [], "pageErrors": [], "external": []}
    page.on("console", lambda m: log["console"].append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: log["pageErrors"].append(str(e)))
    page.on("request", lambda r: log["external"].append(r.url) if not r.url.startswith(("file:", "data:", "blob:", "about:")) else None)
    page.goto(Path(html).resolve().as_uri(), wait_until="load")
    page.wait_for_function("window.__proofCanvas && window.__proofCanvas.readyAt")
    return page, log


def settle(page):
    page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def sweep(browser, html, viewports, shots):
    failures = []
    views = 0
    for w, h in viewports:
        page, log = open_board(browser, html, w, h)
        rules = page.evaluate("window.__proofCanvas.getBoard().rules.map((r) => r.id)")
        for rid in rules:
            for k in ["normal", "bug", "fixed"]:
                page.evaluate("(s) => window.__proofCanvas.setState(s)",
                              {"view": "focus", "ruleId": rid, "module": "*", "status": "all", "q": "", "focusByRule": {rid: k}})
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
        for kind in ["console", "pageErrors", "external"]:
            if log[kind]:
                failures.append(f"{Path(html).name} {w}x{h} {kind}: {log[kind][:3]}")
        page.close()
    return views, failures


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ("sweep", "flow", "shot"):
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
