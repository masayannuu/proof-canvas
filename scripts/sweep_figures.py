"""Headless Chromium layout sweep and screenshots for proof-canvas boards (helper, not needed to use the boards).

  uv run --with playwright==1.65.2 python scripts/sweep_figures.py sweep out/board.html [more.html ...]
      [--viewport 1440x900] [--viewport 900x700] [--shots DIR]
  uv run --with playwright==1.65.2 python scripts/sweep_figures.py shot out/board.html out.png
      [--viewport 1440x900] [--state '{"ruleId": "...", "focusByRule": {...}, "evOpen": true}'] [--full]

`sweep` opens each board at each viewport, shows every rule in every state in focus view, and fails
(exit 1) on any console or page error, external request, SVG text outside its box / pill / chip /
viewBox, label pill touching another pill or a box, connector label over a card, clipped text,
horizontal page overflow, a figure with no measured elements, or a figure without exactly one
connector anchor. `--shots DIR` also saves the board of every view as a 2x PNG.
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
  for (const el of root.querySelectorAll('.pv-bar-lbl, .pv-bar-val, .lk-label, .fx button, .pv-v, .pv-k')) {
    if (el.scrollWidth > el.clientWidth + 1) out.clipped += 1;
  }
  out.connector = root.querySelectorAll('.link-layer .lk-path').length;
  out.svgOverflow = Math.round(out.svgOverflow * 10) / 10;
  return out;
}"""

FAIL_IF_POSITIVE = ["svgOverflow", "pillHits", "lkOverlap", "clipped", "overflowX"]


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
    if not args or args[0] not in ("sweep", "shot"):
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
