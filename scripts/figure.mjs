// Shared figure geometry, text metrics and the SVG builder for one rule.
// The server-side render, the browser runtime and the validator's overflow warnings all use
// these same functions: render_board.mjs injects their source into the page with
// Function.prototype.toString, so each function must stay self-contained (it may reference
// only the other functions and the constants below, which are injected under the same names).

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

// Label overflow report for one rule: [{ where, text, room }] for every label that cannot fit.
export function figureOverflows(rule) {
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

export function figSvg(rule, st, uid, flow) {
  const route = new Set(st.route || []);
  const on = new Set();
  for (const id of st.route || []) { if (ARROWS[id]) { on.add(ARROWS[id].from); on.add(ARROWS[id].to); } }
  const chips = Object.fromEntries((st.chips || []).map((c) => [c.box, c]));
  let h = '<svg class="fg-svg" viewBox="0 0 740 328" role="img" aria-label="' + esc(rule.title) + '" style="--hot:' + HOT[st.tone] + '"><defs>' +
    '<marker id="fg-h-' + uid + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="fg-head"/></marker>' +
    '<marker id="fg-hh-' + uid + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="fg-head-hot"/></marker></defs>';
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
    const lh = lay.fs * 1.18;
    const cx = g.x + g.w / 2;
    let y0;
    if (!c) y0 = g.y + g.h / 2 + lay.fs * 0.35 - (two ? lh / 2 : 0);
    else if (isGate) y0 = two ? g.y + 28 : g.y + 39;
    else y0 = two ? g.y + 21 : g.y + 30;
    const text = lay.lines.map((ln, i) => '<tspan x="' + cx + '" y="' + (y0 + i * lh).toFixed(1) + '">' + esc(ln) + '</tspan>').join('');
    let chipSvg = '';
    if (c) {
      const cfs = fitFontSize(c.text, FS.chip, g.w - 26, FS.chipMin);
      const cw = Math.min(g.w - 14, textW(c.text, cfs) + 18);
      const cy = isGate ? (two ? g.y + 58 : g.y + 54) : (two ? g.y + 46 : g.y + 42);
      chipSvg = '<g class="fg-chip chip-' + c.tone + '"><rect x="' + (cx - cw / 2).toFixed(1) + '" y="' + cy + '" width="' + cw.toFixed(1) + '" height="25" rx="12.5"/>' +
        '<text x="' + cx + '" y="' + (cy + 17.2).toFixed(1) + '" text-anchor="middle" font-size="' + cfs + '">' + esc(c.text) + '</text></g>';
    }
    h += '<g data-box="' + id + '" class="fg-box tone-' + TONES[id] + ' ' + cls + '"><rect x="' + g.x + '" y="' + g.y + '" width="' + g.w + '" height="' + g.h + '" rx="10"/>' +
      '<text class="fg-blabel" text-anchor="middle" font-size="' + lay.fs + '">' + text + '</text>' + chipSvg + '</g>';
  }
  return h + '</svg>';
}
