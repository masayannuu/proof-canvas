// Syntax highlighting for the bound spec excerpts and mutant trace steps under "Proof & log".
// The browser runs `hl` on the same binding text the validator re-checks, so what a reviewer reads
// is always the verified text: every slice is escaped and only the colour comes from the tokenizer.
// The page ships `hl`, the regexes of the languages its excerpts use and only the keywords they
// contain; a board without excerpts or traces ships none of it.

import { LANGUAGES } from './evidence.mjs';
import { esc } from './figure.mjs';

// `re` has exactly one capture group, so String#split puts every token at an odd index. The class
// comes from the token's shape; a word is looked up in `w` (excerpts) or is a variable name (traces).
export function hl(s, re, w) {
  return s.split(re).map((t, i) => {
    const c = i % 2 === 0 ? '' : /^(?:\/[/*-]|--(?!>)|\\\*|\(\*|… |no change$)/.test(t) ? 'c'
      : /^["\d]|^(?:true|false|TRUE|FALSE)$/.test(t) ? 'l' : t.startsWith('State ') ? 't'
        : /^\w/.test(t) ? (w ? w.get(t) : 'k') : 'o';
    return c ? '<span class="h' + c + '">' + esc(t) + '</span>' : esc(t);
  }).join('');
}

// The language of an excerpt comes from its file extension, as in evidence.mjs.
export function hlRef(r) {
  const x = HL[r.file.slice(r.file.lastIndexOf('.')).toLowerCase()];
  return x ? hl(r.snippet, new RegExp('(' + x[0].source + '|' + HLS + ')'), new Map(x[1])) : esc(r.snippet);
}

// Everything but comments, shared by all spec languages: strings, numbers, words, TLA+ backslash
// operators, then operators longest first. An unterminated string, like a line comment, stops before
// "\r" or "\n" (a CRLF break never lands inside a span); an unterminated block comment runs to the end
// of the excerpt (excerpts are cut at 10 lines with "…"). No alternative nests an ambiguous
// quantifier, so tokenizing is linear in the excerpt length.
const SPEC_TOKENS = /"(?:[^"\\\r\n]|\\.)*"?|\d+(?:\.\d+)?|[A-Za-z_]\w*|\\[A-Za-z]+|\/\\|\\\/|<=>|\|->|=>|->|==|!=|\/=|<=|>=|[#'~^*\\]/;

// A trace step: "State N[ · label]:" prefix, the "… N more states …" elision, "no change", strings
// (stopping at a "…" clip so a cut value cannot pair quotes across the rest of the step; "…/" is a
// removed path prefix inside the string), booleans, "key =" variable names (dotted ones whole), numbers
// and arrows.
export const TRACE_RE = /(^State \d+[^:]*:|^… \d+ more states …$|no change|"(?:[^"\\…]|\\.|…(?=\/))*"?|\b(?:TRUE|FALSE|true|false)\b|\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?= = )|\b\d+\b|\|->|-->|->|=>)/;

// Keywords (k) and built-in types (t) per spec language; true/false/TRUE/FALSE are literals by shape.
const WORDS = {
  '.qnt': ['module import export val pure def action temporal run var const type assume all any if else and or implies iff forall exists in not match nondet oneOf', 'int bool str Set Map List'],
  '.tla': ['MODULE EXTENDS CONSTANTS CONSTANT VARIABLES VARIABLE LOCAL INSTANCE ASSUME THEOREM LET IN IF THEN ELSE CASE OTHER CHOOSE UNCHANGED ENABLED SUBSET UNION DOMAIN EXCEPT SPECIFICATION INIT NEXT INVARIANT INVARIANTS PROPERTY PROPERTIES CHECK_DEADLOCK', 'BOOLEAN Nat Int Seq'],
  '.als': ['module open sig abstract extends one lone some no set seq fact pred fun assert check run for but exactly expect all disj in not and or implies iff else let var always eventually after until since historically once none univ iden', 'Int'],
  '.lean': ['theorem lemma def abbrev axiom structure inductive instance where by have show fun let in if then else match with forall exists', 'Nat Int Prop Type Bool'],
  '.dfy': ['module import datatype method function predicate lemma ghost var const requires ensures invariant decreases modifies reads assert assume if then else while forall exists returns', 'int nat bool string seq set map'],
};
for (const ext of LANGUAGES.keys()) if (!WORDS[ext]) throw new Error(`highlight.mjs has no keywords for ${ext}`);

const reEsc = (s) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
// The comment syntax of one language, from the same table evidence.mjs masks comments with.
const commentRe = ({ line, block }) => [...line.map((m) => reEsc(m) + '[^\\r\\n]*'), reEsc(block[0]) + '[\\s\\S]*?(?:' + reEsc(block[1]) + '|$)'].join('|');

// Browser source for a binding, or '' when it has neither excerpts nor traces.
export function hlSource(binding) {
  const refs = Object.values(binding.refs);
  if (!refs.length && !binding.counterexamples) return '';
  const out = [hl.toString()];
  if (refs.length) {
    const used = new Map();
    for (const r of refs) {
      const ext = r.file.slice(r.file.lastIndexOf('.')).toLowerCase();
      if (!LANGUAGES.has(ext)) throw new Error(`no highlighter for spec excerpt "${r.file}"`);
      const seen = used.get(ext) ?? new Set();
      for (const w of r.snippet.match(/[A-Za-z_]\w*/g) ?? []) seen.add(w);
      used.set(ext, seen);
    }
    const langs = [...used].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ext, seen]) => {
      const words = WORDS[ext].flatMap((list, i) => list.split(' ').filter((w) => w && seen.has(w)).map((w) => [w, 'kt'[i]]));
      return JSON.stringify(ext) + ':[/' + commentRe(LANGUAGES.get(ext)) + '/,' + JSON.stringify(words) + ']';
    });
    out.push('const HLS = /' + SPEC_TOKENS.source + '/.source;', 'const HL = {' + langs.join(',') + '};', hlRef.toString());
  }
  if (binding.counterexamples) out.push('const HLT = ' + TRACE_RE + ';');
  return out.join('\n');
}
