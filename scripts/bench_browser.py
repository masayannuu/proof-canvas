"""Headless Chromium metrics for proof-canvas boards (benchmark helper, not needed to use the boards).

Run through scripts/bench_scale.mjs, or directly:
  uv run --with playwright==1.65.2 python scripts/bench_browser.py out/bench/manifest.json
Reads the manifest written by bench_scale.mjs and writes out/bench/browser.json + screenshots.
"""

import json
import statistics
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

REPEAT = 5

# One interaction inside the page: synchronous handler + forced style/layout ("sync"), and
# until the next animation frame has run ("frame").
MEASURE_JS = """async (spec) => {
  const root = document.getElementById('proof-canvas-root');
  const el = spec.sel ? root.querySelector(spec.sel) : null;
  if (spec.sel && !el) return { missing: spec.sel };
  const t0 = performance.now();
  if (spec.kind === 'click') el.click();
  void document.body.offsetHeight;
  const t1 = performance.now();
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const t2 = performance.now();
  return { sync: t1 - t0, frame: t2 - t0 };
}"""

# Layout probe. Every number is a failure signal when it is above zero (except counts/sizes).
PROBE_JS = """() => {
  const de = document.documentElement;
  const root = document.getElementById('proof-canvas-root');
  const focus = root.dataset.view === 'focus';
  // Readability is measured on the interactive focus figure; overview thumbnails are scaled on purpose.
  const svg = focus ? root.querySelector('.fg-svg') : null;
  let minFont = null;
  let minUnits = null;
  if (svg) {
    const k = svg.getBoundingClientRect().width / 740;
    for (const t of svg.querySelectorAll('text')) {
      const fs = parseFloat(t.getAttribute('font-size'));
      if (minUnits === null || fs < minUnits) minUnits = fs;
      if (minFont === null || fs * k < minFont) minFont = fs * k;
    }
  }
  // SVG text that leaves its box or its arrow pill (SVG user units, measured with getBBox).
  let svgOverflow = 0;
  const outside = (t, r) => Math.max(0, r.x - t.x, t.x + t.width - (r.x + r.width), r.y - t.y, t.y + t.height - (r.y + r.height));
  for (const g of root.querySelectorAll('.fg-svg .fg-box')) {
    const r = g.querySelector(':scope > rect').getBBox();
    for (const t of g.querySelectorAll('text')) svgOverflow = Math.max(svgOverflow, outside(t.getBBox(), r));
  }
  for (const g of root.querySelectorAll('.fg-svg .fg-arrow')) {
    const r = g.querySelector('rect.fg-apill').getBBox();
    svgOverflow = Math.max(svgOverflow, outside(g.querySelector('text.fg-alabel').getBBox(), r));
  }
  // Connector pills that overlap a card (px of the smaller intersection side).
  let lkOverlap = 0;
  const cards = [...root.querySelectorAll('.board > .card')].map((c) => c.getBoundingClientRect());
  for (const l of root.querySelectorAll('.lk-label')) {
    const a = l.getBoundingClientRect();
    for (const c of cards) {
      const w = Math.min(a.right, c.right) - Math.max(a.left, c.left);
      const h = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      if (w > 0 && h > 0) lkOverlap = Math.max(lkOverlap, Math.min(w, h));
    }
  }
  // Text clipped inside its own element (bar labels / values, connector pills, focus pills).
  let clipped = 0;
  for (const el of root.querySelectorAll('.pv-bar-lbl, .pv-bar-val, .lk-label, .fx button')) {
    if (el.scrollWidth > el.clientWidth + 1) clipped += 1;
  }
  const bar = root.querySelector('.pc-float-bar');
  const barRect = bar ? bar.getBoundingClientRect() : null;
  const cjk = (de.outerHTML.match(/[\\u3000-\\u303f\\u3040-\\u30ff\\u4e00-\\u9fff\\uff00-\\uffef]/g) || []).length;
  return {
    overflowX: de.scrollWidth - de.clientWidth,
    barOverflow: bar ? Math.max(0, bar.scrollWidth - bar.clientWidth, barRect.right - de.clientWidth, -barRect.left) : 0,
    barRows: bar && bar.firstElementChild ? Math.round(barRect.height / bar.firstElementChild.getBoundingClientRect().height) : 0,
    svgOverflow: Math.round(svgOverflow * 10) / 10,
    lkOverlap: Math.round(lkOverlap * 10) / 10,
    clipped,
    cjk,
    lang: de.lang,
    error: !!root.querySelector('.pc-error'),
    domNodes: document.getElementsByTagName('*').length,
    figureSvgs: root.querySelectorAll('.fg-svg').length,
    minSvgFontPx: minFont === null ? null : Math.round(minFont * 10) / 10,
    minSvgFontUnits: minUnits,
  };
}"""

# Every rule in every state, in focus view: the worst layout numbers across the whole board.
SWEEP_JS = """async (probeSrc) => {
  const probe = eval(probeSrc);
  const pc = window.__proofCanvas;
  const saved = pc.getState();
  const worst = { svgOverflow: 0, lkOverlap: 0, clipped: 0, overflowX: 0, minSvgFontPx: null, minSvgFontUnits: null, views: 0 };
  for (const r of pc.getBoard().rules) {
    for (const k of ['normal', 'bug', 'fixed']) {
      pc.setState({ view: 'focus', ruleId: r.id, status: 'all', focusByRule: { [r.id]: k } });
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const p = probe();
      worst.views += 1;
      for (const f of ['svgOverflow', 'lkOverlap', 'clipped', 'overflowX']) worst[f] = Math.max(worst[f], p[f]);
      for (const f of ['minSvgFontPx', 'minSvgFontUnits']) {
        if (p[f] !== null) worst[f] = worst[f] === null ? p[f] : Math.min(worst[f], p[f]);
      }
    }
  }
  pc.setState(saved);
  return worst;
}"""


def median(xs):
    return round(statistics.median(xs), 2) if xs else None


def interactions(tier):
    """(name, do, undo): undo restores the state so each repetition measures the same transition."""
    rule = lambda i: {"kind": "click", "sel": '[data-act="rule"][data-v="%s"]' % tier["ids"][i]}
    common = [
        ("toggle normal/bug/fixed", {"kind": "click", "sel": '.fx [data-v="normal"]'}, {"kind": "click", "sel": '.fx [data-v="bug"]'}),
        ("toggle Evidence", {"kind": "click", "sel": '[data-act="ev"]'}, {"kind": "click", "sel": '[data-act="ev"]'}),
        ("toggle Overview", {"kind": "click", "sel": '[data-act="view"]'}, {"kind": "click", "sel": '[data-act="view"]'}),
    ]
    if tier["layout"] == "compact":
        return [("switch rule", rule(1), rule(0))] + common
    filt = tier["filterStatus"]
    return [
        ("switch rule", rule(1), rule(0)),
        ("filter %s only" % filt, {"kind": "click", "sel": '[data-act="status"][data-v="%s"]' % filt},
         {"kind": "click", "sel": '[data-act="status"][data-v="all"]'}),
    ] + common


def open_board(browser, url, w, h):
    page = browser.new_page(viewport={"width": w, "height": h})
    log = {"console": [], "pageErrors": [], "external": []}
    page.on("console", lambda m: log["console"].append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: log["pageErrors"].append(str(e)))
    page.on("request", lambda r: log["external"].append(r.url) if not r.url.startswith(("file:", "data:", "blob:", "about:")) else None)
    page.goto(url, wait_until="load")
    page.wait_for_function("window.__proofCanvas && window.__proofCanvas.readyAt")
    return page, log


def run_tier(browser, tier):
    url = Path(tier["html"]).resolve().as_uri()
    rows = []
    for w, h in tier["viewports"]:
        page, log = open_board(browser, url, w, h)
        nav = page.evaluate("""() => { const n = performance.getEntriesByType('navigation')[0];
          return { domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd, ready: window.__proofCanvas.readyAt }; }""")
        cdp = page.context.new_cdp_session(page)
        cdp.send("Performance.enable")
        metrics = {m["name"]: m["value"] for m in cdp.send("Performance.getMetrics")["metrics"]}
        page.wait_for_timeout(100)
        probe0 = page.evaluate(PROBE_JS)
        worst = {"overflow": max(probe0["overflowX"], probe0["barOverflow"]), "barRows": probe0["barRows"]}
        inter = {}
        for name, do, undo in interactions(tier):
            if page.evaluate("(s) => { const e = document.querySelector(s); return !e || e.disabled; }", do["sel"]):
                inter[name] = {"skipped": "control missing or disabled"}
                continue
            syncs, frames = [], []
            for _ in range(REPEAT):
                r = page.evaluate(MEASURE_JS, do)
                if "missing" in r:
                    raise SystemExit("bench_browser: selector not found for %s: %s" % (name, r["missing"]))
                syncs.append(r["sync"])
                frames.append(r["frame"])
                p = page.evaluate(PROBE_JS)
                worst["overflow"] = max(worst["overflow"], p["overflowX"], p["barOverflow"])
                worst["barRows"] = max(worst["barRows"], p["barRows"])
                page.evaluate(MEASURE_JS, undo)
            inter[name] = {"syncMedianMs": median(syncs), "syncMaxMs": round(max(syncs), 2), "frameMedianMs": median(frames)}
        sweep = page.evaluate(SWEEP_JS, PROBE_JS)
        rows.append({
            "viewport": "%dx%d" % (w, h),
            "mode": page.evaluate("window.__proofCanvas.mode"),
            "lang": probe0["lang"],
            "domContentLoadedMs": round(nav["domContentLoaded"], 1),
            "loadMs": round(nav["load"], 1),
            "appReadyMs": round(nav["ready"], 1),
            "domNodesInitial": probe0["domNodes"],
            "cdpNodes": int(metrics.get("Nodes", 0)),
            "jsHeapUsedMB": round(metrics.get("JSHeapUsedSize", 0) / 1048576, 2),
            "indexOpenAtLoad": page.evaluate("window.__proofCanvas.getState().indexOpen"),
            "maxHorizontalOverflowPx": max(worst["overflow"], sweep["overflowX"]),
            "maxToolbarRows": worst["barRows"],
            "sweepViews": sweep["views"],
            "minSvgFontPx": sweep["minSvgFontPx"],
            "minSvgFontUnits": sweep["minSvgFontUnits"],
            "maxSvgTextOverflow": sweep["svgOverflow"],
            "maxConnectorOverlapPx": sweep["lkOverlap"],
            "maxClippedLabels": sweep["clipped"],
            "cjkChars": probe0["cjk"],
            "errorBox": probe0["error"],
            "interactions": inter,
            "consoleErrors": log["console"],
            "pageErrors": log["pageErrors"],
            "externalRequests": log["external"],
        })
        page.close()
    return rows


def run_check(browser, check):
    """Behavior checks that need their own page: returns {name, ok, detail}."""
    page = browser.new_page(viewport={"width": check["w"], "height": check["h"]})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(Path(check["html"]).resolve().as_uri(), wait_until="load")
    kind = check["kind"]
    if kind == "error-box":
        page.wait_for_timeout(500)
        text = page.evaluate("() => { const e = document.querySelector('#proof-canvas-root .pc-error'); return e ? e.textContent : null; }")
        ok = bool(text) and not errors
        detail = text or "no error box"
    else:
        page.wait_for_function("window.__proofCanvas && window.__proofCanvas.readyAt")
        if kind == "index-closed":
            open_ = page.evaluate("window.__proofCanvas.getState().indexOpen")
            ok = open_ is False and not errors
            detail = "indexOpen at load = %s" % open_
        else:
            raise SystemExit("bench_browser: unknown check %s" % kind)
    page.close()
    return {"name": check["name"], "viewport": "%dx%d" % (check["w"], check["h"]), "ok": ok, "detail": detail, "pageErrors": errors}


def screenshot(browser, shot, out_png):
    page, log = open_board(browser, Path(shot["html"]).resolve().as_uri(), shot["w"], shot["h"])
    if shot.get("state"):
        page.evaluate("(p) => window.__proofCanvas.setState(p)", shot["state"])
    page.wait_for_timeout(400)
    page.screenshot(path=out_png)
    errs = log["console"] + log["pageErrors"]
    page.close()
    if errs:
        raise SystemExit("bench_browser: errors while capturing %s: %s" % (out_png, errs))


def main():
    manifest_path = Path(sys.argv[1])
    manifest = json.loads(manifest_path.read_text("utf-8"))
    out_dir = manifest_path.parent
    result = {"chromium": None, "repeat": REPEAT, "tiers": [], "checks": []}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        result["chromium"] = browser.version
        for tier in manifest["tiers"]:
            result["tiers"].append({"name": tier["name"], "rows": run_tier(browser, tier)})
        for check in manifest.get("checks", []):
            result["checks"].append(run_check(browser, check))
        for shot in manifest["screenshots"]:
            screenshot(browser, shot, str(out_dir / shot["file"]))
        browser.close()
    (out_dir / "browser.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print("bench_browser: wrote browser.json and %d screenshots" % len(manifest["screenshots"]))


if __name__ == "__main__":
    main()
