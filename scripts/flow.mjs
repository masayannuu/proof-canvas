// The flow view: a deterministic map of how a board's stages connect, with each stage's rules as
// clickable chips. The server render, the browser runtime and the validator's fit warnings share
// these functions; render_board.mjs injects their source only into boards that have a flow (see
// flowRuntime), so each function may reference only FLOW, the other functions here, and esc / textW /
// splitTwo from figure.mjs and ruleStatus from schema.mjs (always injected under the same names).
//
// Geometry is in one fixed coordinate space (W x H units). The SVG (edges, labels) uses it as its
// viewBox; the stage cards are HTML placed in percent of the same box, and their type is sized in
// --u = 1/W of the container width, so the whole map scales as one picture and never reflows.
//
// The arrows are a map of the workflow for orientation. They are not a proof that the stages
// compose; only each rule's own verifier result is a proof, and the view says so.

import { esc, splitTwo, textW } from './figure.mjs';
import { ruleStatus } from './schema.mjs';

export const FLOW = {
  CW: 236, G: 124, M: 12, RG: 96, PAD: 12,
  TITLE: 19, SUM: 37, BADGE: 28, CHIPS_TOP: 8, CHIP: 26, CHIP_GAP: 4,
  ARC: 30, ARC_STEP: 30, TIP: 3,
  LFS: 12.5, LSHRINK: 11.5, LMIN: 11,
  TITLE_FS: 14.5, SUM_FS: 12, CHIP_FS: 12.5, CHIP_ROOM: 154, MAX_CHIPS: 8,
};

// Each step's rules: its ruleIds in order, or else every rule of its module in board order.
export function flowSteps(board) {
  const byId = Object.create(null);
  for (const r of board.rules) byId[r.id] = r;
  return board.flow.steps.map((s) => ({
    step: s,
    rules: Array.isArray(s.ruleIds) ? s.ruleIds.map((id) => byId[id]).filter(Boolean) : board.rules.filter((r) => s.moduleId !== undefined && r.moduleId === s.moduleId),
  }));
}

// An edge label at the base size on one line, a little smaller on one line, or on two lines.
export function flowLabel(text, room) {
  const s = String(text);
  const w1 = textW(s, 1);
  const pill = (lines, fs) => ({ lines, fs, pw: Math.max(...lines.map((l) => textW(l, fs))) + 14, ph: lines.length * fs * 1.25 + 7 });
  if (w1 * FLOW.LFS <= room) return { ...pill([s], FLOW.LFS), over: false };
  const one = Math.floor((room / w1) * 10) / 10;
  if (one >= FLOW.LSHRINK) return { ...pill([s], one), over: false };
  const two = splitTwo(s);
  if (two) {
    const wl = Math.max(textW(two[0], 1), textW(two[1], 1));
    const fs = Math.min(FLOW.LFS, Math.floor((room / wl) * 10) / 10);
    return { ...pill(two, Math.max(FLOW.LMIN, fs)), over: fs < FLOW.LMIN };
  }
  return { ...pill([s], Math.max(FLOW.LMIN, one)), over: one < FLOW.LMIN };
}

// Stage cells (2-3 stages in one row; 4-6 in two rows, the second running right to left so a
// linear chain turns the corner), then every edge routed by how its ends sit:
//   h    same row, next column       straight, in the gap between the cards
//   v    same column, other row      straight, in the gap between the rows
//   arc  same row, two or more apart arched above the first row (below the second)
//   x    other row and column        S-curve through the gap between the rows
export function flowLayout(board) {
  const F = FLOW;
  const steps = flowSteps(board);
  const n = steps.length;
  const cols = n <= 3 ? n : Math.ceil(n / 2);
  const rows = n <= 3 ? 1 : 2;
  const hasSum = steps.some((x) => x.step.summary);
  const k = Math.max(1, ...steps.map((x) => x.rules.length));
  const CH = 2 * F.PAD + F.TITLE + (hasSum ? F.SUM : 0) + F.BADGE + F.CHIPS_TOP + k * F.CHIP + (k - 1) * F.CHIP_GAP;
  const W = cols * F.CW + (cols - 1) * F.G + 2 * F.M;
  const cell = Object.create(null);
  steps.forEach((x, i) => {
    const r = i < cols ? 0 : 1;
    cell[x.step.id] = { r, c: r === 0 ? i : cols - 1 - (i - cols) };
  });
  const dirs = new Set(board.flow.edges.map((e) => e.from + '>' + e.to));
  const edges = board.flow.edges.map((e) => {
    const a = cell[e.from];
    const b = cell[e.to];
    const type = a.r === b.r ? (Math.abs(a.c - b.c) === 1 ? 'h' : 'arc') : a.c === b.c ? 'v' : 'x';
    return { e, a, b, type, twoWay: dirs.has(e.to + '>' + e.from), level: 0 };
  });
  // Arc lanes: the shortest spans hug the row, wider ones stack outward.
  const arcs = edges.filter((x) => x.type === 'arc').sort((p, q) => Math.abs(p.a.c - p.b.c) - Math.abs(q.a.c - q.b.c));
  arcs.forEach((x, i) => {
    const lo = Math.min(x.a.c, x.b.c);
    const hi = Math.max(x.a.c, x.b.c);
    const busy = arcs.slice(0, i).filter((y) => y.a.r === x.a.r && Math.min(y.a.c, y.b.c) <= hi && Math.max(y.a.c, y.b.c) >= lo).map((y) => y.level);
    while (busy.includes(x.level)) x.level += 1;
    x.span = (hi - lo) * (F.CW + F.G) - 74;
    x.fit = flowLabel(x.e.label, x.span);
  });
  const reserve = (row) => Math.max(F.M, ...arcs.filter((x) => x.a.r === row).map((x) => F.ARC + x.level * F.ARC_STEP + x.fit.ph / 2 + 6));
  const top = reserve(0);
  const H = top + rows * CH + (rows - 1) * F.RG + (rows === 2 ? reserve(1) : F.M);
  const box = (p) => ({ x: F.M + p.c * (F.CW + F.G), y: top + p.r * (CH + F.RG), w: F.CW, h: CH });
  const pt = (v) => v.toFixed(1);
  const out = edges.map((x) => {
    const A = box(x.a);
    const B = box(x.b);
    let d;
    let cx;
    let cy;
    let fit;
    if (x.type === 'h') {
      const fwd = x.a.c < x.b.c;
      const off = x.twoWay ? (fwd ? -9 : 9) : 0;
      const y = A.y + CH / 2 + off;
      const x1 = fwd ? A.x + F.CW + F.TIP : A.x - F.TIP;
      const x2 = fwd ? B.x - F.TIP : B.x + F.CW + F.TIP;
      d = 'M' + pt(x1) + ' ' + pt(y) + ' L' + pt(x2) + ' ' + pt(y);
      fit = flowLabel(x.e.label, F.G - 26);
      cx = (x1 + x2) / 2;
      cy = off > 0 ? y + 5 + fit.ph / 2 : y - 5 - fit.ph / 2;
    } else if (x.type === 'arc') {
      const dir = x.b.c > x.a.c ? 1 : -1;
      const up = x.a.r === 0;
      const sx = A.x + F.CW / 2 + dir * (14 + 10 * x.level);
      const tx = B.x + F.CW / 2 - dir * (14 + 10 * x.level);
      const y0 = up ? A.y - F.TIP : A.y + CH + F.TIP;
      const h = (up ? -1 : 1) * (F.ARC + x.level * F.ARC_STEP);
      d = 'M' + pt(sx) + ' ' + pt(y0) + ' C' + pt(sx) + ' ' + pt(y0 + h * 4 / 3) + ', ' + pt(tx) + ' ' + pt(y0 + h * 4 / 3) + ', ' + pt(tx) + ' ' + pt(y0);
      fit = x.fit;
      cx = (sx + tx) / 2;
      cy = y0 + h;
    } else {
      // Between the rows: straight down a column (v), or an S-curve to another column (x).
      const down = x.a.r < x.b.r;
      const off = x.twoWay ? (down ? -12 : 12) : 0;
      const sx = A.x + F.CW / 2 + off;
      const tx = B.x + F.CW / 2 + off;
      const y1 = down ? A.y + CH + F.TIP : A.y - F.TIP;
      const y2 = down ? B.y - F.TIP : B.y + CH + F.TIP;
      cy = (y1 + y2) / 2;
      d = 'M' + pt(sx) + ' ' + pt(y1) + ' C' + pt(sx) + ' ' + pt(cy) + ', ' + pt(tx) + ' ' + pt(cy) + ', ' + pt(tx) + ' ' + pt(y2);
      fit = flowLabel(x.e.label, x.type === 'v' ? F.CW / 2 + F.G / 2 - 30 : Math.max(106, Math.abs(tx - sx) - 38));
      cx = x.type === 'v' ? sx + (off < 0 ? -1 : 1) * (8 + fit.pw / 2) : (sx + tx) / 2;
    }
    return { e: x.e, type: x.type, d, cx, cy, fit, pill: { x: cx - fit.pw / 2, y: cy - fit.ph / 2, w: fit.pw, h: fit.ph } };
  });
  return { W, H, CH, hasSum, steps: steps.map((x) => ({ ...x, box: box(cell[x.step.id]) })), edges: out };
}

// Fit and collision report: [{ where, msg }] with paths relative to $.flow.
export function flowOverflows(board) {
  const F = FLOW;
  const g = flowLayout(board);
  const out = [];
  const meets = (p, q) => p.x < q.x + q.w - 0.5 && q.x < p.x + p.w - 0.5 && p.y < q.y + q.h - 0.5 && q.y < p.y + p.h - 0.5;
  const room = F.CW - 2 * F.PAD;
  g.steps.forEach((x, i) => {
    if (textW(x.step.label, F.TITLE_FS) > room) out.push({ where: 'steps[' + i + '].label', msg: '"' + x.step.label + '" is wider than the stage card; shorten it' });
    if (x.step.summary && textW(x.step.summary, F.SUM_FS) > 2 * room * 0.92) out.push({ where: 'steps[' + i + '].summary', msg: 'longer than two lines of the stage card; shorten it' });
    if (x.rules.length > F.MAX_CHIPS) out.push({ where: 'steps[' + i + ']', msg: x.rules.length + ' rules make a tall stage card; split the stage (at most ' + F.MAX_CHIPS + ' reads well)' });
    for (const r of x.rules) {
      if (textW(r.short, F.CHIP_FS) > F.CHIP_ROOM) out.push({ where: 'steps[' + i + ']', msg: 'rule "' + r.id + '" short title "' + r.short + '" is wider than its chip; shorten it' });
    }
  });
  g.edges.forEach((x, i) => {
    if (x.fit.over) out.push({ where: 'edges[' + i + '].label', msg: '"' + x.e.label + '" does not fit beside its arrow; shorten it' });
    if (x.pill.x < 0 || x.pill.y < 0 || x.pill.x + x.pill.w > g.W || x.pill.y + x.pill.h > g.H) out.push({ where: 'edges[' + i + '].label', msg: 'the label leaves the flow map; shorten it' });
    for (const s of g.steps) if (meets(x.pill, s.box)) out.push({ where: 'edges[' + i + '].label', msg: 'the label covers stage "' + s.step.id + '"; shorten it or reorder the stages' });
    g.edges.slice(i + 1).forEach((y, j) => {
      if (meets(x.pill, y.pill)) out.push({ where: 'edges[' + i + '].label', msg: 'the label overlaps the label of edges[' + (i + 1 + j) + ']; shorten one or reorder the stages' });
    });
  });
  return out;
}

// The whole flow view for one journey ('*' = all stages).
export function flowView(board, L, jid) {
  const f = board.flow;
  const g = flowLayout(board);
  const J = (f.journeys || []).find((j) => j.id === jid) || null;
  const onStep = new Set(J ? J.stepIds : []);
  const onEdge = new Set(J ? J.edgeIds || [] : []);
  const cp = J && J.checkpointRuleId;
  const tn = J ? ' tn-' + J.tone : '';
  const pct = (v, t) => (v / t * 100).toFixed(3) + '%';
  const mk = (id, cls, size) => '<marker id="' + id + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="' + size + '" markerHeight="' + size + '" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="' + cls + '"/></marker>';
  let svg = '<svg class="fl-svg" viewBox="0 0 ' + g.W + ' ' + g.H + '" aria-hidden="true"><defs>' + mk('fl-h', 'fl-tip', 9) + mk('fl-hh', 'fl-tip-on', 11) + '</defs>';
  for (const x of g.edges) {
    const on = !!J && onEdge.has(x.e.id);
    const lh = x.fit.fs * 1.25;
    const y0 = x.cy - (x.fit.lines.length - 1) * lh / 2 + x.fit.fs * 0.35;
    svg += '<g class="fl-edge k-' + (x.e.kind || 'normal') + (J ? (on ? ' is-on' : ' is-dim') : '') + '" data-edge="' + esc(x.e.id) + '">' +
      '<path class="fl-line" d="' + x.d + '" marker-end="url(#fl-h' + (on ? 'h' : '') + ')"/>' + (on ? '<path class="fl-run" d="' + x.d + '"/>' : '') +
      '<rect class="fl-pill" x="' + x.pill.x.toFixed(1) + '" y="' + x.pill.y.toFixed(1) + '" width="' + x.pill.w.toFixed(1) + '" height="' + x.pill.h.toFixed(1) + '" rx="' + Math.min(10, x.pill.h / 2).toFixed(1) + '"/>' +
      '<text class="fl-elabel" text-anchor="middle" font-size="' + x.fit.fs + '">' + x.fit.lines.map((ln, i) => '<tspan x="' + x.cx.toFixed(1) + '" y="' + (y0 + i * lh).toFixed(1) + '">' + esc(ln) + '</tspan>').join('') + '</text></g>';
  }
  svg += '</svg>';
  const stages = g.steps.map((x) => {
    const st = x.rules.map(ruleStatus);
    const v = st.filter((s) => s === 'verified').length;
    const bad = st.filter((s) => s === 'failed').length;
    const agg = bad ? 'failed' : v < st.length ? 'pending' : 'verified';
    const b = x.box;
    const cls = J ? (onStep.has(x.step.id) ? ' is-on' : ' is-dim') : '';
    return '<section class="fl-stage' + cls + (bad ? ' has-fail' : '') + '" data-step="' + esc(x.step.id) + '" style="left:' + pct(b.x, g.W) + ';top:' + pct(b.y, g.H) + ';width:' + pct(b.w, g.W) + ';height:' + pct(b.h, g.H) + '">' +
      '<h3 class="fl-st-t" title="' + esc(x.step.label) + '">' + esc(x.step.label) + '</h3>' +
      (x.step.summary ? '<p class="fl-st-s">' + esc(x.step.summary) + '</p>' : g.hasSum ? '<p class="fl-st-s"></p>' : '') +
      '<span class="st-pill st-' + agg + ' fl-st-b">' + esc(L.stageBadge(v, st.length, bad)) + '</span><ul class="fl-chips">' +
      x.rules.map((r, i) => '<li><button type="button" class="fl-chip st-' + st[i] + (r.id === cp ? ' is-cp' : '') + '" data-act="flow-rule" data-v="' + esc(r.id) + '" title="' + esc(r.no + '. ' + r.title) + '">' +
        '<span class="fl-chip-no">' + esc(r.no) + '</span><span class="fl-chip-t">' + esc(r.short) + '</span><span class="st-dot st-' + st[i] + '" role="img" aria-label="' + esc(L.status[st[i]]) + '"></span></button></li>').join('') +
      '</ul></section>';
  }).join('');
  const kinds = [...new Set(f.edges.map((e) => e.kind).filter((k) => k === 'bypass' || k === 'handoff'))];
  const legend = kinds.length ? '<span class="fl-legend">' + kinds.map((k) => '<span class="k-' + k + '"><svg viewBox="0 0 24 8" aria-hidden="true"><path class="fl-line" d="M1 4 L23 4"/></svg>' + esc(L.edgeKind[k]) + '</span>').join('') + '</span>' : '';
  const bar = f.journeys ? '<div class="fl-jbar" role="group" aria-label="' + esc(L.journeys) + '"><button type="button" data-act="journey" data-v="*" aria-pressed="' + !J + '">' + esc(L.flowAll) + '</button>' +
    f.journeys.map((j) => '<button type="button" data-act="journey" data-v="' + esc(j.id) + '" aria-pressed="' + (J === j) + '"><span class="fl-jdot tn-' + j.tone + '" aria-hidden="true"></span>' + esc(j.label) + '</button>').join('') + '</div>' : '';
  const foot = J ? '<p class="fl-sum">' + esc(J.summary) + '</p>' + (cp ? '<button type="button" class="fl-cta" data-act="checkpoint" data-v="' + esc(J.id) + '">' + esc(L.inspect) + '</button>' : '')
    : '<p class="fl-hint">' + esc(L.flowHint) + '</p>';
  return '<section class="card fl' + tn + '" data-flow data-journey="' + (J ? esc(J.id) : '*') + '"><div class="fl-head"><h2 class="fl-title">' + esc(f.title || L.flowTitle) + '</h2>' + legend + '</div>' +
    '<p class="fl-cap">' + esc(L.flowCaption) + (f.note ? L.sep + esc(f.note) : '') + '</p>' + bar +
    '<div class="fl-canvas" style="--fw:' + g.W + ';max-width:' + g.W + 'px;aspect-ratio:' + g.W + ' / ' + g.H.toFixed(1) + '">' + svg + stages + '</div>' +
    '<div class="fl-foot">' + foot + '</div></section>';
}

// The focus a journey's checkpoint opens: checkpointFocus, else the state matching the journey's tone.
export function checkpointFocus(j) {
  return j.checkpointFocus || (j.tone === 'bug' ? 'bug' : j.tone === 'safe' ? 'fixed' : 'normal');
}

export function flowRuntime() {
  return ['const FLOW = ' + JSON.stringify(FLOW) + ';', ...[flowSteps, flowLabel, flowLayout, flowView, checkpointFocus].map((fn) => fn.toString())].join('\n');
}
