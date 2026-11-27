// Shared figure geometry, text metrics and the SVG builders for one rule.
// The server-side render, the browser runtime and the validator's overflow warnings all use
// these same functions: render_board.mjs injects their source into the page with
// Function.prototype.toString (see figureRuntime), so each function must stay self-contained
// (it may reference only the other functions and the constants below, which are injected under
// the same names).
//
// A rule's figure is one of five kinds, chosen by figure.kind (missing means 'gate'):
//   gate      { boxes, arrows }   two inputs, one check, three outcomes      state: route, here, chips
//   sequence  { lanes, steps }    2-3 actors with lifelines, 2-5 ordered steps  state: activeSteps, focusStep, chips?
//   relation  { nodes, edges }    3-5 entities, 2-7 directed relations         state: activeEdges, focusNodes?, chips?
//   state     { states, transitions }  2-5 states, 1-8 allowed / forbidden / loop transitions
//                                                               state: activeStates, activeTransitions, focusTransition, chips?
//   timeline  { ticks, bars, events }  2-5 time points, 1-3 windows, 1-4 events  state: activeBars, activeEvents, focusEvent, chips?
// Every kind draws into the same 740 x 328 viewBox and marks one element with data-anchor,
// where the connector to the screen preview starts.

export const GEOM = {
  src1: { x: 8, y: 34, w: 168, h: 80 },
  src2: { x: 8, y: 214, w: 168, h: 80 },
  gate: { x: 298, y: 112, w: 148, h: 104 },
  pass: { x: 564, y: 10, w: 168, h: 80 },
  hold: { x: 564, y: 124, w: 168, h: 80 },
  bad: { x: 564, y: 238, w: 168, h: 80 },
};
export const TONES = { src1: 'source', src2: 'source', gate: 'gate', pass: 'pass', hold: 'hold', bad: 'stop' };
export const ARROWS = {
  a1: { from: 'src1', to: 'gate', p: [[176, 74], [298, 146]], at: [238, 95], gap: 122 },
  a2: { from: 'src2', to: 'gate', p: [[176, 254], [298, 182]], at: [238, 243], gap: 122 },
  a3: { from: 'gate', to: 'pass', p: [[446, 134], [564, 50]], at: [504, 78], gap: 118 },
  a4: { from: 'gate', to: 'hold', p: [[446, 164], [564, 164]], at: [505, 149], gap: 118 },
  a5: { from: 'gate', to: 'bad', p: [[446, 194], [564, 278]], at: [504, 263], gap: 118 },
};
// Base and minimum font sizes (SVG user units). Box labels shrink a little, then wrap to two lines.
export const FS = { box: 17.5, boxShrink: 15, boxTwo: 15.5, boxTwoChip: 14, boxMin: 13, label: 15.5, labelMin: 13, chip: 14.5, chipMin: 13 };
export const HOT = { bug: 'var(--pc-bad)', safe: 'var(--pc-good)', normal: 'var(--pc-info)' };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Approximate advance width in em for a sans-serif UI font. Deliberately a little generous,
// so text that "fits" here also fits in the real font.
export function charEm(c) {
  if (c === ' ') return 0.3;
  if ('.,:;!|\'`'.includes(c)) return 0.3;
  if ('ijlI'.includes(c)) return 0.3;
  if ('frt()[]{}/'.includes(c)) return 0.42;
  if ('mw'.includes(c)) return 0.92;
  if ('MW@%#&'.includes(c)) return 1.0;
  if (c >= 'A' && c <= 'Z') return 0.76;
  return c.charCodeAt(0) < 0x80 ? 0.62 : 1.0;
}

export function textW(s, fs) {
  let w = 0;
  for (const c of String(s)) w += charEm(c) * fs;
  return w;
}

export function fitFontSize(s, baseFs, maxW, minFs) {
  const w1 = textW(s, 1);
  if (w1 <= 0 || w1 * baseFs <= maxW) return baseFs;
  return Math.max(minFs, Math.floor((maxW / w1) * 10) / 10);
}

// Best two-line split: at a space when there is one, otherwise between characters.
export function splitTwo(s) {
  const str = String(s);
  const chars = [...str];
  if (chars.length < 2) return null;
  const spaces = [];
  chars.forEach((c, i) => { if (c === ' ' && i > 0 && i < chars.length - 1) spaces.push(i); });
  const cuts = spaces.length ? spaces : chars.map((_, i) => i).filter((i) => i > 0);
  let best = null;
  for (const i of cuts) {
    const a = chars.slice(0, i).join('').trim();
    const b = chars.slice(spaces.length ? i + 1 : i).join('').trim();
    if (!a || !b) continue;
    const w = Math.max(textW(a, 1), textW(b, 1));
    if (!best || w < best.w) best = { w, lines: [a, b] };
  }
  return best ? best.lines : null;
}

// Box label layout: one line at the base size, then one line shrunk to `shrinkFs`, then two lines.
// `overflow` is true when even two lines at the minimum size are wider than the box.
export function layoutBoxLabel(label, maxW, hasChip) {
  const s = String(label);
  const w1 = textW(s, 1);
  if (w1 * FS.box <= maxW) return { fs: FS.box, lines: [s], overflow: false };
  const oneFs = Math.floor((maxW / w1) * 10) / 10;
  if (oneFs >= FS.boxShrink) return { fs: oneFs, lines: [s], overflow: false };
  const two = splitTwo(s);
  if (two) {
    const cap = hasChip ? FS.boxTwoChip : FS.boxTwo;
    const wl = Math.max(textW(two[0], 1), textW(two[1], 1));
    const fs2 = Math.min(cap, Math.floor((maxW / wl) * 10) / 10);
    if (fs2 >= FS.boxMin) return { fs: fs2, lines: two, overflow: false };
    return { fs: FS.boxMin, lines: two, overflow: true };
  }
  return { fs: FS.boxMin, lines: [s], overflow: oneFs < FS.boxMin };
}


// ---- shared SVG pieces ----

export function figKind(rule) {
  return rule.figure.kind ?? 'gate';
}

// Opening <svg> tag and arrowhead markers. Marker ids carry the board uid, so they stay unique.
export function figOpen(rule, st, uid, extraMarkers) {
  return '<svg class="fg-svg" viewBox="0 0 740 328" role="img" aria-label="' + esc(rule.title) + '" style="--hot:' + HOT[st.tone] + '"><defs>' +
    '<marker id="fg-h-' + uid + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="fg-head"/></marker>' +
    '<marker id="fg-hh-' + uid + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="fg-head-hot"/></marker>' + extraMarkers + '</defs>';
}

// Box label lines from layoutBoxLabel, the first baseline at y0.
export function blabel(lay, cx, y0) {
  const lh = lay.fs * 1.18;
  return '<text class="fg-blabel" text-anchor="middle" font-size="' + lay.fs + '">' +
    lay.lines.map((ln, i) => '<tspan x="' + cx + '" y="' + (y0 + i * lh).toFixed(1) + '">' + esc(ln) + '</tspan>').join('') + '</text>';
}

// Baseline of the first line of a label centered vertically in [y, y + h].
export function midY(lay, y, h) {
  return y + h / 2 + lay.fs * 0.35 - (lay.lines.length === 2 ? lay.fs * 0.59 : 0);
}

// Value chip (25 units tall) centered on cx, at most maxW wide.
export function chipSvg(c, cx, y, maxW) {
  const cfs = fitFontSize(c.text, FS.chip, maxW - 12, FS.chipMin);
  const cw = Math.min(maxW, textW(c.text, cfs) + 18);
  return '<g class="fg-chip chip-' + c.tone + '"><rect x="' + (cx - cw / 2).toFixed(1) + '" y="' + y + '" width="' + cw.toFixed(1) + '" height="25" rx="12.5"/>' +
    '<text x="' + cx + '" y="' + (y + 17.2).toFixed(1) + '" text-anchor="middle" font-size="' + cfs + '">' + esc(c.text) + '</text></g>';
}

// Label pill centered on (cx, cy). The renderer draws and the validator checks this same box.
export function pillBox(cx, cy, fit) {
  return { x: cx - fit.pw / 2, y: cy - fit.fs * 0.65 - 2, w: fit.pw, h: fit.fs * 1.2 + 5 };
}

// Font size and pill width for a label given `room` units of pill width.
export function pillFit(lab, room) {
  const r = Math.max(room, 24);
  const fs = fitFontSize(lab, FS.label, r - 12, FS.labelMin);
  return { fs, pw: Math.min(r, textW(lab, fs) + 12) };
}

// One labelled line (a sequence step or a relation edge), structured like a gate arrow.
export function edgeSvg(attr, cls, d, marker, flowOn, lab, cx, cy, fit, extra) {
  const b = pillBox(cx, cy, fit);
  return '<g ' + attr + ' class="fg-arrow ' + cls + '"><path class="fg-line" d="' + d + '" marker-end="url(#' + marker + ')"/>' +
    (flowOn ? '<path class="fg-flow" d="' + d + '"/>' : '') + extra +
    '<rect class="fg-apill" x="' + b.x.toFixed(1) + '" y="' + b.y.toFixed(1) + '" width="' + b.w.toFixed(1) + '" height="' + b.h.toFixed(1) + '" rx="5"/>' +
    '<text class="fg-alabel" x="' + cx.toFixed(1) + '" y="' + (cy + fit.fs * 0.35).toFixed(1) + '" text-anchor="middle" font-size="' + fit.fs + '">' + esc(lab) + '</text></g>';
}

// ---- gate: two inputs, one check, three outcomes ----

export function gateOverflows(rule) {
  const out = [];
  for (const [id, g] of Object.entries(GEOM)) {
    const label = rule.figure.boxes[id];
    for (const withChip of [false, true]) {
      if (layoutBoxLabel(label, g.w - 16, withChip).overflow) { out.push({ where: `figure.boxes.${id}`, text: label, room: 'its box, even on two lines at the minimum font size' }); break; }
    }
  }
  for (const [id, a] of Object.entries(ARROWS)) {
    const lab = rule.figure.arrows[id];
    if (textW(lab, FS.labelMin) > a.gap - 20) out.push({ where: `figure.arrows.${id}`, text: lab, room: 'the gap between its two boxes' });
  }
  for (const [sk, st] of Object.entries(rule.states)) {
    (st.chips || []).forEach((c, ci) => {
      const g = GEOM[c.box];
      if (g && textW(c.text, FS.chipMin) > g.w - 26) out.push({ where: `states.${sk}.chips[${ci}].text`, text: c.text, room: `the ${c.box} box at the minimum chip size` });
    });
  }
  return out;
}

export function gateSvg(rule, st, uid, flow) {
  const route = new Set(st.route);
  const on = new Set();
  for (const id of st.route) { on.add(ARROWS[id].from); on.add(ARROWS[id].to); }
  const chips = Object.fromEntries((st.chips || []).map((c) => [c.box, c]));
  let h = figOpen(rule, st, uid, '');
  for (const [id, a] of Object.entries(ARROWS)) {
    const isOn = route.has(id);
    const d = a.p.map(([x, y], i) => (i ? 'L' : 'M') + x + ' ' + y).join(' ');
    const lab = rule.figure.arrows[id];
    const lfs = fitFontSize(lab, FS.label, a.gap - 20, FS.labelMin);
    const pw = Math.min(a.gap - 12, textW(lab, lfs) + 12);
    h += '<g data-arrow="' + id + '" class="fg-arrow ' + (isOn ? 'is-on' : 'is-dim') + '">' +
      '<path class="fg-line" d="' + d + '" marker-end="url(#' + (isOn ? 'fg-hh' : 'fg-h') + '-' + uid + ')"/>' +
      (isOn && flow ? '<path class="fg-flow" d="' + d + '"/>' : '') +
      '<rect class="fg-apill" x="' + (a.at[0] - pw / 2).toFixed(1) + '" y="' + (a.at[1] - lfs - 2).toFixed(1) + '" width="' + pw.toFixed(1) + '" height="' + (lfs * 1.2 + 5).toFixed(1) + '" rx="5"/>' +
      '<text class="fg-alabel" x="' + a.at[0] + '" y="' + a.at[1] + '" text-anchor="middle" font-size="' + lfs + '">' + esc(lab) + '</text></g>';
  }
  for (const [id, g] of Object.entries(GEOM)) {
    const cls = id === st.here ? 'is-here is-on' : on.has(id) ? 'is-on' : 'is-dim';
    const c = chips[id];
    const isGate = id === 'gate';
    const lay = layoutBoxLabel(rule.figure.boxes[id], g.w - 16, !!c);
    const two = lay.lines.length === 2;
    const cx = g.x + g.w / 2;
    let y0;
    if (!c) y0 = g.y + g.h / 2 + lay.fs * 0.35 - (two ? lay.fs * 1.18 / 2 : 0);
    else if (isGate) y0 = two ? g.y + 28 : g.y + 39;
    else y0 = two ? g.y + 21 : g.y + 30;
    const chip = c ? chipSvg(c, cx, isGate ? (two ? g.y + 58 : g.y + 54) : (two ? g.y + 46 : g.y + 42), g.w - 14) : '';
    h += '<g data-box="' + id + '" class="fg-box tone-' + TONES[id] + ' ' + cls + '"><rect' + (id === st.here ? ' data-anchor="1"' : '') + ' x="' + g.x + '" y="' + g.y + '" width="' + g.w + '" height="' + g.h + '" rx="10"/>' +
      blabel(lay, cx, y0) + chip + '</g>';
  }
  return h + '</svg>';
}

// ---- sequence: actors with lifelines and ordered steps (TLA+ / Quint races, TOCTOU) ----

export const SEQ = {
  laneX: { 2: [185, 555], 3: [130, 370, 610] },
  laneW: { 2: 220, 3: 200 },
  head: { y: 6, h: 50 },
  chipY: 62,
  lifeEnd: 322,
  rowY: { 2: [156, 262], 3: [136, 210, 284], 4: [124, 182, 240, 298], 5: [116, 162, 208, 254, 300] },
  badge: 11,
  loop: 28,
};

// Fixed geometry: lane centers by lane count, row baselines by step count. A step between lanes
// is a horizontal arrow from the numbered badge on its source lifeline; a step on one lane is a
// small loop beside it (to the left on the last lane), with its pill next to the loop.
export function seqLayout(rule) {
  const { lanes, steps } = rule.figure;
  const n = lanes.length;
  const xs = SEQ.laneX[n];
  const lw = SEQ.laneW[n];
  const ys = SEQ.rowY[steps.length];
  const B = SEQ.badge;
  const at = Object.create(null);
  lanes.forEach((l, i) => { at[l.id] = i; });
  return {
    lw,
    lanes: lanes.map((l, i) => ({ id: l.id, label: l.label, x: xs[i], box: { x: xs[i] - lw / 2, y: SEQ.head.y, w: lw, h: SEQ.head.h } })),
    steps: steps.map((s, i) => {
      const a = at[s.from];
      const b = at[s.to];
      const xa = xs[a];
      const y = ys[i];
      if (a === b) {
        const sd = a === n - 1 ? -1 : 1;
        const x1 = xa + sd * (B + 2 + SEQ.loop);
        const room = Math.abs(xs[a + sd] - xa) - (B + SEQ.loop + 10) - 14;
        const fit = pillFit(s.label, room);
        const cx = x1 + sd * (8 + fit.pw / 2);
        return { id: s.id, label: s.label, xa, y, room, fit, cx, right: Math.max(xa + B, cx + fit.pw / 2),
          d: 'M' + (xa + sd * (B + 2)) + ' ' + (y - 10) + ' H' + x1 + ' V' + (y + 10) + ' H' + (xa + sd * (B + 4)) };
      }
      const dir = b > a ? 1 : -1;
      const x1 = xa + dir * (B + 3);
      const x2 = xs[b] - dir * 2;
      const room = Math.abs(x2 - x1) - 28;
      return { id: s.id, label: s.label, xa, y, room, fit: pillFit(s.label, room), cx: (x1 + x2) / 2, right: Math.max(x1, x2, xa + B), d: 'M' + x1 + ' ' + y + ' H' + x2 };
    }),
  };
}

export function seqOverflows(rule) {
  const out = [];
  const g = seqLayout(rule);
  g.lanes.forEach((l, i) => {
    if (layoutBoxLabel(l.label, l.box.w - 16, false).overflow) out.push({ where: `figure.lanes[${i}].label`, text: l.label, room: 'its lane header, even on two lines at the minimum font size' });
  });
  g.steps.forEach((s, i) => {
    if (textW(s.label, FS.labelMin) > s.room - 12) out.push({ where: `figure.steps[${i}].label`, text: s.label, room: 'the space beside its lane' });
  });
  for (const [sk, st] of Object.entries(rule.states)) {
    (st.chips || []).forEach((c, ci) => {
      if (textW(c.text, FS.chipMin) > g.lw - 26) out.push({ where: `states.${sk}.chips[${ci}].text`, text: c.text, room: 'its lane at the minimum chip size' });
    });
  }
  return out;
}

export function seqSvg(rule, st, uid, flow) {
  const g = seqLayout(rule);
  const act = new Set(st.activeSteps);
  const chips = Object.create(null);
  for (const c of st.chips || []) chips[c.lane] = c;
  let h = figOpen(rule, st, uid, '');
  for (const l of g.lanes) h += '<line class="fg-life" x1="' + l.x + '" y1="' + (l.box.y + l.box.h) + '" x2="' + l.x + '" y2="' + SEQ.lifeEnd + '"/>';
  for (const l of g.lanes) {
    const b = l.box;
    const lay = layoutBoxLabel(l.label, b.w - 16, false);
    h += '<g data-lane="' + l.id + '" class="fg-box tone-source is-on"><rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="10"/>' + blabel(lay, l.x, midY(lay, b.y, b.h)) + '</g>';
    if (chips[l.id]) h += chipSvg(chips[l.id], l.x, SEQ.chipY, b.w - 14);
  }
  let k = 0;
  for (const s of g.steps) {
    const isOn = act.has(s.id);
    const badge = isOn
      ? '<g class="fg-badge"><circle cx="' + s.xa + '" cy="' + s.y + '" r="' + SEQ.badge + '"/><text x="' + s.xa + '" y="' + (s.y + 4.6).toFixed(1) + '" text-anchor="middle" font-size="13">' + (++k) + '</text></g>'
      : '<circle class="fg-dot" cx="' + s.xa + '" cy="' + s.y + '" r="4"/>';
    h += edgeSvg('data-step="' + s.id + '"', (isOn ? 'is-on' : 'is-dim') + (s.id === st.focusStep ? ' is-here' : ''), s.d, (isOn ? 'fg-hh-' : 'fg-h-') + uid, isOn && flow, s.label, s.cx, s.y, s.fit, badge);
  }
  const focus = g.steps.find((s) => s.id === st.focusStep);
  if (focus.right + 16 < 728) h += '<path class="fg-lead" d="M' + (focus.right + 8).toFixed(1) + ' ' + focus.y + ' H728"/>';
  return h + '<circle class="fg-port" data-anchor="1" cx="733" cy="' + focus.y + '" r="4.5"/></svg>';
}

// ---- relation: entities and directed relations (Alloy structures, RBAC, ownership) ----

export const REL = {
  w: 168,
  h: 80,
  bend: 22,
  loop: 48,
  slots: {
    3: [[18, 22, 'below'], [554, 22, 'below'], [286, 226, 'right']],
    4: [[18, 22, 'below'], [554, 22, 'below'], [18, 226, 'above'], [554, 226, 'above']],
    5: [[18, 22, 'below'], [554, 22, 'below'], [286, 124, 'right'], [18, 226, 'above'], [554, 226, 'above']],
  },
};

export function bez(p, t) {
  const u = 1 - t;
  return [0, 1].map((i) => u * u * u * p[0][i] + 3 * u * u * t * p[1][i] + 3 * u * t * t * p[2][i] + t * t * t * p[3][i]);
}

// Nodes sit in fixed slots by node count, in array order. An edge runs between box borders; the
// two edges of a bidirectional pair (and a state figure's loop edge) bow apart; a self-loop leaves
// its node on the slot's free side. Every path is a cubic Bezier [p0, c1, c2, p3]; (cx, cy) is the
// center of its label pill. Shared by the relation and state figures, each with its own slot table.
export function graphLayout(nodes, edges, slots) {
  const W = REL.w;
  const H = REL.h;
  const ph = FS.label * 1.2 + 5;
  const N = Object.create(null);
  nodes.forEach((nd, i) => {
    const [x, y, side] = slots[nodes.length][i];
    N[nd.id] = { x, y, w: W, h: H, cx: x + W / 2, cy: y + H / 2, side };
  });
  const pairs = new Set(edges.map((e) => e.from + '>' + e.to));
  return {
    nodes: N,
    edges: edges.map((e) => {
      const a = N[e.from];
      // A forbidden state transition carries a circled x at the start of its pill.
      const extra = e.kind === 'forbidden' ? 18 : 0;
      const pillFor = (room) => { const f = pillFit(e.label, room - extra); return { fs: f.fs, pw: f.pw + extra }; };
      if (e.from === e.to) {
        const U = { below: [0, 1], above: [0, -1], right: [1, 0], left: [-1, 0] }[a.side];
        const T = [Math.abs(U[1]), Math.abs(U[0])];
        const m = [a.cx + U[0] * W / 2, a.cy + U[1] * H / 2];
        const at = (t, u) => [m[0] + T[0] * t + U[0] * u, m[1] + T[1] * t + U[1] * u];
        const reach = REL.loop * 0.75 + 6;
        const room = U[0] > 0 ? 736 - m[0] - reach : U[0] < 0 ? m[0] - reach - 4 : 200;
        const fit = pillFor(room);
        const off = reach + (U[0] ? fit.pw : ph) / 2;
        return { e, p: [at(-12, 0), at(-30, REL.loop), at(30, REL.loop), at(12, 0)], fit, room, extra, cx: m[0] + U[0] * off, cy: m[1] + U[1] * off };
      }
      const b = N[e.to];
      const dx = b.cx - a.cx;
      const dy = b.cy - a.cy;
      const len = Math.hypot(dx, dy);
      const t = Math.min(dx ? (W / 2 + 2) / Math.abs(dx) : 1, dy ? (H / 2 + 2) / Math.abs(dy) : 1);
      const bend = pairs.has(e.to + '>' + e.from) || e.kind === 'loop' ? REL.bend : 0;
      const nx = (dy / len) * bend;
      const ny = (-dx / len) * bend;
      const s = bend ? 8 / bend : 0;
      const k = bend ? (bend - 8) / 0.75 / bend : 0;
      // A bowed pair's endpoints shift sideways by 8; clip that shifted line, not the center line,
      // at 2 outside each border so the arrow tip never sits inside the target box.
      const ox = nx * s;
      const oy = ny * s;
      const exit = (sx, sy) => Math.min(dx ? (W / 2 + 2 - Math.sign(dx) * sx) / Math.abs(dx) : Infinity, dy ? (H / 2 + 2 - Math.sign(dy) * sy) / Math.abs(dy) : Infinity);
      const ta = exit(ox, oy);
      const tb = exit(-ox, -oy);
      const p0 = [a.cx + ox + dx * ta, a.cy + oy + dy * ta];
      const p3 = [b.cx + ox - dx * tb, b.cy + oy - dy * tb];
      const p = [p0, [p0[0] + (p3[0] - p0[0]) / 3 + nx * k, p0[1] + (p3[1] - p0[1]) / 3 + ny * k], [p0[0] + (p3[0] - p0[0]) * 2 / 3 + nx * k, p0[1] + (p3[1] - p0[1]) * 2 / 3 + ny * k], p3];
      const vis = len * (1 - 2 * t);
      const cos = Math.abs(dx) / len;
      const room = cos > 0.05 ? Math.min(200, (vis - 24 - ph * Math.abs(dy) / len) / cos) : vis - 24 >= ph ? 200 : 0;
      const mid = bez(p, 0.5);
      return { e, p, fit: pillFor(room), room, extra, cx: mid[0], cy: mid[1] };
    }),
  };
}

// Text layout inside a node box: optional role caption, the label, an optional chip.
export function nodeLayout(nd, hasChip) {
  const lay = layoutBoxLabel(nd.label, REL.w - 16, hasChip);
  const two = lay.lines.length === 2;
  if (!nd.role) return { lay, y0: hasChip ? (two ? 21 : 30) : midY(lay, 0, REL.h), chipY: two ? 46 : 42, overflow: lay.overflow };
  if (!hasChip) return { lay, roleY: 22, y0: midY(lay, 28, REL.h - 28), overflow: lay.overflow || textW(nd.role, FS.chipMin) > REL.w - 16 };
  return { lay, roleY: 19, y0: 40, chipY: 49, overflow: two || lay.overflow || textW(nd.role, FS.chipMin) > REL.w - 16 };
}

// Label fit and collisions of a laid-out graph: pills leaving the figure, touching nodes or other
// pills, lines crossing foreign nodes or pills. `path` names the edge list (figure.edges).
export function graphCollisions(g, path) {
  const out = [];
  const inside = (pt, r, m) => pt[0] > r.x - m && pt[0] < r.x + r.w + m && pt[1] > r.y - m && pt[1] < r.y + r.h + m;
  const meets = (r, q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h;
  const samples = (p) => Array.from({ length: 33 }, (_, i) => bez(p, i / 32));
  const pills = g.edges.map((x) => pillBox(x.cx, x.cy, x.fit));
  g.edges.forEach((x, i) => {
    const where = `${path}[${i}].label`;
    const say = (msg) => out.push({ where, text: x.e.label, msg: `"${x.e.label}" ${msg}; shorten it or reorder the nodes` });
    const pb = pills[i];
    if (textW(x.e.label, FS.labelMin) > x.room - 12 - x.extra) out.push({ where, text: x.e.label, room: 'the free length of its line' });
    if (pb.x < 2 || pb.y < 2 || pb.x + pb.w > 738 || pb.y + pb.h > 326) say('leaves the figure');
    for (const [id, nb] of Object.entries(g.nodes)) {
      if (meets(pb, nb)) say(`overlaps node "${id}"`);
      if (id !== x.e.from && id !== x.e.to && samples(x.p).some((pt) => inside(pt, nb, -2))) say(`has a line that crosses node "${id}"`);
    }
    g.edges.forEach((y, j) => {
      if (j === i) return;
      if (j < i && meets(pb, pills[j])) say(`overlaps the label of edge "${y.e.id}"`);
      if (samples(y.p).some((pt) => inside(pt, pb, 1))) say(`is crossed by edge "${y.e.id}"`);
    });
  });
  return out;
}

export function relLayout(rule) {
  return graphLayout(rule.figure.nodes, rule.figure.edges, REL.slots);
}

export function relOverflows(rule) {
  const out = [];
  const { nodes } = rule.figure;
  const g = relLayout(rule);
  const chipped = new Set();
  for (const [sk, st] of Object.entries(rule.states)) {
    (st.chips || []).forEach((c, ci) => {
      chipped.add(c.node);
      if (textW(c.text, FS.chipMin) > REL.w - 26) out.push({ where: `states.${sk}.chips[${ci}].text`, text: c.text, room: 'its node at the minimum chip size' });
    });
  }
  nodes.forEach((nd, i) => {
    if (nodeLayout(nd, false).overflow || (chipped.has(nd.id) && nodeLayout(nd, true).overflow)) {
      out.push({ where: `figure.nodes[${i}]`, text: nd.role ? nd.role + ' / ' + nd.label : nd.label, room: 'its node box (with a chip, the label must fit on one line under a role)' });
    }
  });
  return out.concat(graphCollisions(g, 'figure.edges'));
}

// Relations are structure, not flow: no moving dots, so dashed forbidden edges stay distinct.
export function relSvg(rule, st, uid) {
  const g = relLayout(rule);
  const act = new Set(st.activeEdges);
  const foc = new Set(st.focusNodes || []);
  const on = new Set(foc);
  const chips = Object.create(null);
  for (const c of st.chips || []) chips[c.node] = c;
  const mk = (id, cls, d, size) => '<marker id="' + id + '-' + uid + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="' + size + '" markerHeight="' + size + '" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="' + d + '" class="' + cls + '"/></marker>';
  let h = figOpen(rule, st, uid, mk('fg-hb', 'fg-head-bad', 'M0 0 L10 5 L0 10 z', 11) + mk('fg-hs', 'fg-stop', 'M8 0 L8 10', 18));
  for (const x of g.edges) {
    const e = x.e;
    const isOn = act.has(e.id);
    if (isOn) { on.add(e.from); on.add(e.to); }
    const blocked = isOn && e.forbidden === true && st.tone === 'safe';
    const marker = !isOn ? 'fg-h-' : blocked ? 'fg-hs-' : e.forbidden ? 'fg-hb-' : 'fg-hh-';
    const xy = (pt) => pt[0].toFixed(1) + ' ' + pt[1].toFixed(1);
    const d = 'M' + xy(x.p[0]) + ' C' + xy(x.p[1]) + ', ' + xy(x.p[2]) + ', ' + xy(x.p[3]);
    h += edgeSvg('data-rel="' + e.id + '"', (e.forbidden ? 'is-forbid ' : '') + (isOn ? 'is-on' : 'is-dim') + (blocked ? ' is-blocked' : ''), d, marker + uid, false, e.label, x.cx, x.cy, x.fit, '');
  }
  for (const nd of rule.figure.nodes) {
    const b = g.nodes[nd.id];
    const c = chips[nd.id];
    const L = nodeLayout(nd, !!c);
    const cls = foc.has(nd.id) ? 'is-here is-on' : on.has(nd.id) ? 'is-on' : 'is-dim';
    h += '<g data-node="' + nd.id + '" class="fg-box tone-source ' + cls + '"><rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="10"/>' +
      (nd.role ? '<text class="fg-brole" x="' + b.cx + '" y="' + (b.y + L.roleY) + '" text-anchor="middle" font-size="' + FS.chipMin + '">' + esc(nd.role) + '</text>' : '') +
      blabel(L.lay, b.cx, b.y + L.y0) + (c ? chipSvg(c, b.cx, b.y + L.chipY, b.w - 14) : '') + '</g>';
  }
  return h + '<circle class="fg-port" data-anchor="1" cx="733" cy="164" r="4.5"/></svg>';
}

// ---- state: a state machine with allowed, forbidden and loop transitions (lifecycles, liveness) ----

export const STM = {
  slots: {
    2: [[40, 124, 'below'], [532, 124, 'below']],
    3: [[18, 22, 'below'], [554, 22, 'below'], [286, 226, 'right']],
    4: [[18, 22, 'below'], [554, 22, 'below'], [18, 226, 'above'], [554, 226, 'above']],
    5: [[18, 22, 'below'], [554, 22, 'below'], [286, 124, 'right'], [18, 226, 'above'], [554, 226, 'above']],
  },
};

export function stmLayout(rule) {
  return graphLayout(rule.figure.states, rule.figure.transitions, STM.slots);
}

// Label layout inside a state box. An initial state keeps its start dot (top left) clear of the label.
export function stmNodeLayout(sd, hasChip) {
  const lay = layoutBoxLabel(sd.label, REL.w - (sd.role === 'initial' ? 34 : 16), hasChip);
  const two = lay.lines.length === 2;
  return { lay, y0: hasChip ? (two ? 21 : 30) : midY(lay, 0, REL.h), chipY: two ? 46 : 42 };
}

export function stmOverflows(rule) {
  const out = [];
  const chipped = new Set();
  for (const [sk, st] of Object.entries(rule.states)) {
    (st.chips || []).forEach((c, ci) => {
      chipped.add(c.state);
      if (textW(c.text, FS.chipMin) > REL.w - 26) out.push({ where: `states.${sk}.chips[${ci}].text`, text: c.text, room: 'its state at the minimum chip size' });
    });
  }
  rule.figure.states.forEach((sd, i) => {
    if (stmNodeLayout(sd, false).lay.overflow || (chipped.has(sd.id) && stmNodeLayout(sd, true).lay.overflow)) out.push({ where: `figure.states[${i}].label`, text: sd.label, room: 'its state box' });
  });
  return out.concat(graphCollisions(stmLayout(rule), 'figure.transitions'));
}

// Allowed: solid arrow. Forbidden: red dashed arrow with a circled x on its pill, ending in a stop bar
// once the fix blocks it. Loop: a bold bowed arrow (amber, red in the bug state) for lasso traces.
export function stmSvg(rule, st, uid) {
  const g = stmLayout(rule);
  const act = new Set(st.activeTransitions);
  const on = new Set(st.activeStates);
  const chips = Object.create(null);
  for (const c of st.chips || []) chips[c.state] = c;
  const mk = (id, cls, d, size) => '<marker id="' + id + '-' + uid + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="' + size + '" markerHeight="' + size + '" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="' + d + '" class="' + cls + '"/></marker>';
  let h = figOpen(rule, st, uid, mk('fg-hb', 'fg-head-bad', 'M0 0 L10 5 L0 10 z', 11) + mk('fg-hs', 'fg-stop', 'M8 0 L8 10', 18) + mk('fg-hl', 'fg-head-loop', 'M0 0 L10 5 L0 10 z', 12));
  const xy = (pt) => pt[0].toFixed(1) + ' ' + pt[1].toFixed(1);
  let here = null;
  for (const x of g.edges) {
    const e = x.e;
    const kind = e.kind || 'allowed';
    const isOn = act.has(e.id);
    const blocked = isOn && kind === 'forbidden' && st.tone === 'safe';
    const amber = kind === 'loop' && st.tone !== 'bug';
    const marker = !isOn ? 'fg-h-' : blocked ? 'fg-hs-' : kind === 'forbidden' ? 'fg-hb-' : amber ? 'fg-hl-' : 'fg-hh-';
    const b = pillBox(x.cx, x.cy, x.fit);
    const cls = (kind === 'forbidden' ? 'is-forbid ' : kind === 'loop' ? 'is-loop ' + (amber ? 'is-amber ' : '') : '') + (isOn ? 'is-on' : 'is-dim') + (e.id === st.focusTransition ? ' is-here' : '') + (blocked ? ' is-blocked' : '');
    const cross = x.extra ? '<g class="fg-x"><circle cx="' + (b.x + 10).toFixed(1) + '" cy="' + x.cy.toFixed(1) + '" r="6"/><path d="M' + (b.x + 7.2).toFixed(1) + ' ' + (x.cy - 2.8).toFixed(1) + ' l5.6 5.6 M' + (b.x + 12.8).toFixed(1) + ' ' + (x.cy - 2.8).toFixed(1) + ' l-5.6 5.6"/></g>' : '';
    h += '<g data-tr="' + e.id + '" class="fg-arrow ' + cls + '"><path class="fg-line" d="M' + xy(x.p[0]) + ' C' + xy(x.p[1]) + ', ' + xy(x.p[2]) + ', ' + xy(x.p[3]) + '" marker-end="url(#' + marker + uid + ')"/>' +
      '<rect class="fg-apill" x="' + b.x.toFixed(1) + '" y="' + b.y.toFixed(1) + '" width="' + b.w.toFixed(1) + '" height="' + b.h.toFixed(1) + '" rx="5"/>' +
      '<text class="fg-alabel" x="' + (x.cx + x.extra / 2).toFixed(1) + '" y="' + (x.cy + x.fit.fs * 0.35).toFixed(1) + '" text-anchor="middle" font-size="' + x.fit.fs + '">' + esc(e.label) + '</text>' + cross + '</g>';
    if (isOn && e.id === st.focusTransition) here = e.to;
  }
  for (const sd of rule.figure.states) {
    const b = g.nodes[sd.id];
    const c = chips[sd.id];
    const L = stmNodeLayout(sd, !!c);
    const cls = sd.id === here && on.has(sd.id) ? 'is-here is-on' : on.has(sd.id) ? 'is-on' : 'is-dim';
    h += '<g data-state="' + sd.id + '" class="fg-box tone-' + (sd.role === 'bad' && on.has(sd.id) ? 'stop' : 'source') + ' ' + cls + '"><rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="10"/>' +
      (sd.role === 'terminal' ? '<rect class="fg-inner" x="' + (b.x + 4) + '" y="' + (b.y + 4) + '" width="' + (b.w - 8) + '" height="' + (b.h - 8) + '" rx="7"/>' : '') +
      (sd.role === 'initial' ? '<circle class="fg-start" cx="' + (b.x + 12) + '" cy="' + (b.y + 12) + '" r="4.5"/>' : '') +
      blabel(L.lay, b.cx, b.y + L.y0) + (c ? chipSvg(c, b.cx, b.y + L.chipY, b.w - 14) : '') + '</g>';
  }
  return h + '<circle class="fg-port" data-anchor="1" cx="733" cy="164" r="4.5"/></svg>';
}

// ---- timeline: time points, lifetime windows and events (TTLs, leases, == boundaries) ----

export const TL = {
  x0: 80, x1: 660, axisY: 244, labelY: 268, barY: [208, 172, 136], barH: 26, rowY: [92, 58, 24], tickFs: 14.5, gap: 8, evW: 220,
};

// Ticks spread evenly on the axis; each label gets the room between its neighbours (and the edge).
// Bars sit in rows above the axis, in array order. Event pills take the lowest free row above the
// bars, so two events on one tick stack upward; a pin joins each pill to the one below it or to the axis.
export function tlLayout(rule) {
  const { ticks, bars, events } = rule.figure;
  const n = ticks.length;
  const step = (TL.x1 - TL.x0) / (n - 1);
  const at = Object.create(null);
  const T = ticks.map((t, i) => {
    const x = TL.x0 + i * step;
    at[t.id] = i;
    const room = Math.min(step - 10, 2 * (Math.min(x, 740 - x) - 4));
    let lines = [t.label];
    let fs = fitFontSize(t.label, TL.tickFs, room, FS.labelMin);
    if (textW(t.label, fs) > room) {
      const two = splitTwo(t.label);
      if (two) { lines = two; fs = fitFontSize(textW(two[0], 1) > textW(two[1], 1) ? two[0] : two[1], TL.tickFs - 0.5, room, FS.labelMin); }
    }
    return { id: t.id, label: t.label, boundary: t.boundary === true, x, room, fs, lines, overflow: lines.some((ln) => textW(ln, fs) > room) };
  });
  const B = bars.map((b, i) => {
    const x = T[at[b.from]].x;
    const w = T[at[b.to]].x - x;
    const fs = fitFontSize(b.label, FS.label, w - 16, FS.labelMin);
    return { b, x, y: TL.barY[i], w, h: TL.barH, fs, overflow: textW(b.label, fs) > w - 16 };
  });
  const order = events.map((e, i) => ({ e, i, t: at[e.tick] })).sort((p, q) => p.t - q.t || p.i - q.i);
  const placed = [];
  const E = [];
  for (const { e, t } of order) {
    const x = T[t].x;
    const fit = pillFit(e.label, TL.evW);
    const cx = Math.min(Math.max(x, fit.pw / 2 + 4), 736 - fit.pw / 2);
    let row = 0;
    while (row < TL.rowY.length && placed.some((q) => q.row === row && Math.abs(q.cx - cx) < (q.fit.pw + fit.pw) / 2 + TL.gap)) row++;
    const ev = { e, x, row, cx, cy: TL.rowY[Math.min(row, TL.rowY.length - 1)], fit, overflow: row >= TL.rowY.length, wide: textW(e.label, fit.fs) > TL.evW - 12 };
    placed.push(ev);
    E[events.indexOf(e)] = ev;
  }
  for (const ev of E) {
    const below = E.filter((q) => q !== ev && q.x === ev.x && q.row < ev.row).sort((p, q) => q.row - p.row)[0];
    ev.pinTo = below ? below.cy - (below.fit.fs * 0.65 + 2) : TL.axisY;
  }
  return { ticks: T, bars: B, events: E, tickAt: at };
}

export function tlOverflows(rule) {
  const out = [];
  const g = tlLayout(rule);
  g.ticks.forEach((t, i) => { if (t.overflow) out.push({ where: `figure.ticks[${i}].label`, text: t.label, room: 'the space between its neighbouring ticks' }); });
  g.bars.forEach((x, i) => { if (x.overflow) out.push({ where: `figure.bars[${i}].label`, text: x.b.label, room: 'its bar' }); });
  const boxes = g.events.map((ev) => pillBox(ev.cx, ev.cy, ev.fit));
  g.events.forEach((ev, i) => {
    const say = (msg) => out.push({ where: `figure.events[${i}].label`, text: ev.e.label, msg: `"${ev.e.label}" ${msg}; shorten it or move the event` });
    if (ev.wide) say(`does not fit its ${TL.evW}-unit box even at the minimum font size`);
    if (ev.overflow) say('needs a fourth row above its tick');
    boxes.forEach((q, j) => {
      const other = g.events[j];
      if (j !== i && other.x !== ev.x && ev.x > q.x - 1 && ev.x < q.x + q.w + 1 && other.cy > ev.cy) say(`has a pin that crosses the label of event "${other.e.id}"`);
    });
  });
  for (const [sk, st] of Object.entries(rule.states)) {
    (st.chips || []).forEach((c, ci) => {
      const t = g.ticks[g.tickAt[c.tick]];
      if (t && textW(c.text, FS.chipMin) > t.room - 12) out.push({ where: `states.${sk}.chips[${ci}].text`, text: c.text, room: 'the space under its tick at the minimum chip size' });
    });
  }
  return out;
}

export function tlSvg(rule, st, uid) {
  const g = tlLayout(rule);
  const bars = new Set(st.activeBars);
  const evs = new Set(st.activeEvents);
  const chips = Object.create(null);
  for (const c of st.chips || []) chips[c.tick] = c;
  let h = figOpen(rule, st, uid, '');
  for (const t of g.ticks) if (t.boundary) h += '<line class="fg-bound" x1="' + t.x + '" y1="' + (TL.barY[2] - 8) + '" x2="' + t.x + '" y2="' + (TL.axisY + 8) + '"/>';
  for (const ev of g.events) {
    const top = ev.cy + ev.fit.fs * 0.55 + 4;
    h += '<line class="fg-pin' + (evs.has(ev.e.id) ? ' is-on' : '') + '" x1="' + ev.x.toFixed(1) + '" y1="' + top.toFixed(1) + '" x2="' + ev.x.toFixed(1) + '" y2="' + ev.pinTo.toFixed(1) + '"/>';
  }
  for (const x of g.bars) {
    const isOn = bars.has(x.b.id);
    const tone = { good: 'pass', bad: 'stop' }[x.b.tone] || 'source';
    // An opaque backing keeps pins hidden behind a dimmed (translucent) bar.
    h += '<rect class="fg-back" x="' + x.x.toFixed(1) + '" y="' + x.y + '" width="' + x.w.toFixed(1) + '" height="' + x.h + '" rx="6"/>';
    h += '<g data-bar="' + x.b.id + '" class="fg-box tone-' + tone + ' ' + (isOn ? 'is-on' : 'is-dim') + '"><rect x="' + x.x.toFixed(1) + '" y="' + x.y + '" width="' + x.w.toFixed(1) + '" height="' + x.h + '" rx="6"/>' +
      '<text class="fg-blabel" x="' + (x.x + x.w / 2).toFixed(1) + '" y="' + (x.y + x.h / 2 + x.fs * 0.35).toFixed(1) + '" text-anchor="middle" font-size="' + x.fs + '">' + esc(x.b.label) + '</text></g>';
  }
  h += '<path class="fg-axis" d="M24 ' + TL.axisY + ' H716" marker-end="url(#fg-h-' + uid + ')"/>';
  for (const t of g.ticks) {
    const c = chips[t.id];
    const lh = t.fs * 1.18;
    h += '<g data-tick="' + t.id + '" class="fg-tick' + (t.boundary ? ' is-bound' : '') + '"><line x1="' + t.x + '" y1="' + (TL.axisY - 6) + '" x2="' + t.x + '" y2="' + (TL.axisY + 6) + '"/>' +
      '<text text-anchor="middle" font-size="' + t.fs + '">' + t.lines.map((ln, i) => '<tspan x="' + t.x + '" y="' + (TL.labelY + i * lh).toFixed(1) + '">' + esc(ln) + '</tspan>').join('') + '</text></g>' +
      (c ? chipSvg(c, t.x, Math.round(TL.labelY + (t.lines.length - 1) * lh + 10), Math.min(t.room, 200)) : '');
  }
  let focus = null;
  for (const ev of g.events) {
    const isOn = evs.has(ev.e.id);
    const b = pillBox(ev.cx, ev.cy, ev.fit);
    if (ev.e.id === st.focusEvent) focus = { ev, b };
    h += '<g data-ev="' + ev.e.id + '" class="fg-arrow fg-ev t-' + (ev.e.tone || 'normal') + ' ' + (isOn ? 'is-on' : 'is-dim') + (ev.e.id === st.focusEvent ? ' is-here' : '') + '">' +
      '<circle class="fg-pindot" cx="' + ev.x.toFixed(1) + '" cy="' + TL.axisY + '" r="5"/>' +
      '<rect class="fg-apill" x="' + b.x.toFixed(1) + '" y="' + b.y.toFixed(1) + '" width="' + b.w.toFixed(1) + '" height="' + b.h.toFixed(1) + '" rx="' + (b.h / 2).toFixed(1) + '"/>' +
      '<text class="fg-alabel" x="' + ev.cx.toFixed(1) + '" y="' + (ev.cy + ev.fit.fs * 0.35).toFixed(1) + '" text-anchor="middle" font-size="' + ev.fit.fs + '">' + esc(ev.e.label) + '</text></g>';
  }
  const right = focus.b.x + focus.b.w;
  const clear = !g.events.some((ev) => ev !== focus.ev && ev.row === focus.ev.row && ev.cx > focus.ev.cx);
  if (clear && right + 16 < 728) h += '<path class="fg-lead" d="M' + (right + 6).toFixed(1) + ' ' + focus.ev.cy + ' H728"/>';
  return h + '<circle class="fg-port" data-anchor="1" cx="733" cy="' + (clear ? focus.ev.cy : 164) + '" r="4.5"/></svg>';
}

// ---- registry ----

// figSvg and figureOverflows dispatch on figure.kind through FIGURES. figureRuntime injects the
// constants and functions of the kinds a board uses, plus a FIGURES table of their builders.
export const FIGURES = {
  gate: { svg: gateSvg, overflows: gateOverflows, fns: [gateSvg], consts: { GEOM, TONES, ARROWS } },
  sequence: { svg: seqSvg, overflows: seqOverflows, fns: [midY, pillBox, pillFit, edgeSvg, seqLayout, seqSvg], consts: { SEQ } },
  relation: { svg: relSvg, overflows: relOverflows, fns: [midY, pillBox, pillFit, edgeSvg, bez, graphLayout, relLayout, nodeLayout, relSvg], consts: { REL } },
  state: { svg: stmSvg, overflows: stmOverflows, fns: [midY, pillBox, pillFit, bez, graphLayout, stmLayout, stmNodeLayout, stmSvg], consts: { REL, STM } },
  timeline: { svg: tlSvg, overflows: tlOverflows, fns: [pillBox, pillFit, tlLayout, tlSvg], consts: { TL } },
};
export const FIGURE_KINDS = Object.keys(FIGURES);
const COMMON_FNS = [esc, charEm, textW, fitFontSize, splitTwo, layoutBoxLabel, figKind, figOpen, blabel, chipSvg, figSvg];

export function figSvg(rule, st, uid, flow) {
  return FIGURES[figKind(rule)].svg(rule, st, uid, flow);
}

// Label overflow and collision report for one rule: [{ where, text, room } | { where, text, msg }].
export function figureOverflows(rule) {
  return FIGURES[figKind(rule)].overflows(rule);
}

export function figureRuntime(kinds) {
  const used = FIGURE_KINDS.filter((k) => kinds.includes(k));
  const consts = Object.assign({ FS, HOT }, ...used.map((k) => FIGURES[k].consts));
  const fns = [...new Set([...COMMON_FNS, ...used.flatMap((k) => FIGURES[k].fns)])];
  return [
    ...Object.entries(consts).map(([name, v]) => 'const ' + name + ' = ' + JSON.stringify(v) + ';'),
    'const FIGURES = {' + used.map((k) => k + ': { svg: ' + FIGURES[k].svg.name + ' }').join(', ') + '};',
    ...fns.map((f) => f.toString()),
  ].join('\n');
}
