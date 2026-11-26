import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { ruleStatus } from './schema.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = (message) => { throw new Error('binding: ' + message); };
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeFile = (value) => typeof value === 'string' && value.length > 0 && !/[/\\\x00-\x1f]/.test(value) && !/^(?:\.{1,2}$|[a-z]:)/i.test(value);
const absolutePath = /(?:^|[\s"'=(,:])(?:\/(?:[\w.@+~-]+\/)+[\w.@+~-]+|[a-z]:[\\/][\w.@+~-]|\\{2,}[\w.-]+\\)|\bfile:\/\//im;
const safeChecker = (value) => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9 +_.()-]{0,79}$/.test(value);
const PROPERTY = '[A-Za-z_][\\w.!\x27]*';
const propertyName = new RegExp('^' + PROPERTY + '(?![\\s\\S])');
const hasSteps = (value) => Number.isSafeInteger(value) && value >= 0;

function readFiles(paths, flag) {
  const files = paths.map((path) => {
    const file = basename(path);
    if (!safeFile(file)) fail(`invalid --${flag} filename "${file}"`);
    let bytes;
    try { bytes = readFileSync(path); }
    catch (error) { fail(`cannot read --${flag} file "${file}" (${error.code ?? 'read error'})`); }
    if (flag === 'spec' && !isUtf8(bytes)) fail(`--spec file "${file}" must be UTF-8`);
    return { file, hash: sha256(bytes), text: bytes.toString('utf8') };
  }).sort((a, b) => compare(a.file, b.file));
  if (files.some((f, i) => i > 0 && f.file === files[i - 1].file)) fail(`duplicate --${flag} basename`);
  return files;
}

// Receives basename/SHA-256 records. A manifest hash is independent of argument order.
function manifestHash(files) {
  if (files.length === 1) return files[0].hash;
  return sha256([...files].sort((a, b) => compare(a.file, b.file))
    .map(({ file, hash }) => file + '\n' + hash.slice('sha256:'.length)).join('\n'));
}

export function computeSpecHash(files) {
  return manifestHash(files);
}

const LANGUAGES = new Map([
  ['.qnt', { line: ['//'], block: ['/*', '*/'], declaration: /^(?:pure[ \t]+)?(?:val|def|temporal|action|assume)[ \t]+(\w+)\b/ }],
  ['.tla', { line: ['\\*'], block: ['(*', '*)'], nested: true, declaration: /^([A-Za-z_]\w*)[ \t]*(?:\([^=]*\)[ \t]*)?==/ }],
  ['.als', { line: ['//', '--'], block: ['/*', '*/'], declaration: /^(?:assert|pred|fact|fun|check)[ \t]+(\w+)\b/ }],
  ['.lean', { chars: true, line: ['--'], block: ['/-', '-/'], nested: true, declaration: /^(?:(?:private|protected|noncomputable|unsafe|partial)[ \t]+)*(?:theorem|lemma|def|abbrev|axiom|structure)[ \t]+([\w.']+)/ }],
  ['.dfy', { chars: true, line: ['//'], block: ['/*', '*/'], nested: true, declaration: /^(?:(?:ghost|opaque|static)[ \t]+)*(?:lemma|predicate|function|method)[ \t]+(\w+)\b/ }],
]);

// Mask comments and strings without changing offsets. Delimiters inside either
// cannot start declarations or close a definition block.
function maskSource(source, language) {
  const [open, close] = language.block;
  const out = source.split('');
  const hide = (at, length = 1) => {
    for (let i = at; i < at + length && i < out.length; i++) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    }
  };
  let depth = 0;
  let quote = '';
  const charLiteral = /'(?:\\[^\r\n]|[^'\\\r\n])'/y;
  for (let i = 0; i < source.length;) {
    if (depth > 0) {
      if (source.startsWith(close, i)) {
        hide(i, close.length);
        i += close.length;
        depth--;
      } else if (language.nested && source.startsWith(open, i)) {
        hide(i, open.length);
        i += open.length;
        depth++;
      } else hide(i++);
    } else if (quote) {
      if (quote === '@"' && source.startsWith('""', i)) {
        hide(i, 2);
        i += 2;
      } else if (quote !== '@"' && source[i] === '\\') {
        hide(i, 2);
        i += 2;
      } else {
        if (source[i] === '"') quote = '';
        hide(i++);
      }
    } else if (language.line.some((marker) => source.startsWith(marker, i))) {
      while (i < source.length && source[i] !== '\r' && source[i] !== '\n') hide(i++);
    } else if (source.startsWith(open, i)) {
      hide(i, open.length);
      i += open.length;
      depth = 1;
    } else if (source[i] === '"' || source.startsWith('@"', i)) {
      quote = source[i] === '"' ? '"' : '@"';
      hide(i, quote.length);
      i += quote.length;
    } else {
      charLiteral.lastIndex = i;
      const literal = language.chars && source[i] === "'" && !/[\w']/.test(source[i - 1] ?? '') && charLiteral.exec(source);
      if (literal) {
        hide(i, literal[0].length);
        i += literal[0].length;
      } else i++;
    }
  }
  return out.join('');
}

function definitionRef(file, originals, lines, start, next) {
  let end = next - 1;
  let braces = 0;
  for (let i = start; i < next; i++) {
    if (/^\s*={4,}\s*$/.test(lines[i])) {
      end = i - 1;
      break;
    }
    for (const char of lines[i]) {
      if (char === '{') braces++;
      if (char === '}') {
        braces--;
        if (braces <= 0) {
          end = braces < 0 && i > start ? i - 1 : i;
          break;
        }
      }
    }
    if (end <= i) break;
  }
  while (end > start && !lines[end].trim()) end--;
  const last = Math.min(end, start + 9);
  const excerpt = originals.slice(start, last + 1).join('').replace(/(?:\r\n|\r|\n)$/, '');
  const chars = [...excerpt];
  const truncated = last < end || chars.length > 600;
  const snippet = truncated ? chars.slice(0, 599).join('').replace(/[\r\n]+$/, '') + '…' : excerpt;
  const endLine = start + snippet.split(/\r\n|\r|\n/).length;
  return { file, line: start + 1, endLine, snippet };
}

export function extractSpecDefinitions({ file, text }) {
  const extension = extname(file).toLowerCase();
  const language = LANGUAGES.get(extension);
  if (!language) fail(`unsupported --spec file "${file}"`);
  const lines = maskSource(text, language).split(/\r\n|\r|\n/);
  const originals = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const declarations = [];
  let localDepth = 0;
  lines.forEach((line, index) => {
    const match = line.trimStart().match(language.declaration);
    if (match && localDepth === 0) declarations.push({ name: match[1], index });
    if (extension === '.tla') {
      for (const token of line.matchAll(/\b(?:LET|IN)\b/g)) {
        localDepth = Math.max(0, localDepth + (token[0] === 'LET' ? 1 : -1));
      }
    }
  });
  return declarations.map(({ name, index }, i) => [name,
    definitionRef(file, originals, lines, index, declarations[i + 1]?.index ?? originals.length),
  ]);
}

function specRefs(board, files) {
  const definitions = new Map();
  for (const file of files) {
    for (const [name, ref] of extractSpecDefinitions(file)) {
      definitions.set(name, definitions.has(name) ? null : ref);
    }
  }
  return Object.fromEntries(board.rules.map(({ id, property }) => {
    if (!definitions.has(property)) fail(`rule "${id}" property "${property}" not found in supplied --spec file(s)`);
    const ref = definitions.get(property);
    if (!ref) fail(`rule "${id}" property "${property}" is ambiguous in supplied --spec file(s)`);
    if (absolutePath.test(ref.snippet)) fail(`rule "${id}" spec excerpt contains an absolute file path`);
    return [id, ref];
  }));
}

function validResult(result) {
  if (!isObject(result)) return false;
  const keys = ['status', ...(result.property === undefined ? [] : ['property']), ...(result.stepsChecked === undefined ? [] : ['stepsChecked'])];
  return exactKeys(result, keys)
    && ['verified', 'failed'].includes(result.status)
    && (result.property === undefined || (typeof result.property === 'string' && propertyName.test(result.property)))
    && (result.stepsChecked === undefined || hasSteps(result.stepsChecked));
}

function structuredLog(text, file) {
  let log;
  try { log = JSON.parse(text); }
  catch { fail(`invalid structured checker log "${file}"`); }
  const keys = ['checker', 'results', ...(log?.schemaVersion === undefined ? [] : ['schemaVersion'])];
  if (!exactKeys(log, keys) || (log.schemaVersion !== undefined && log.schemaVersion !== 'proof-canvas-log-1')
    || !safeChecker(log.checker) || !Array.isArray(log.results) || log.results.length === 0
    || log.results.some((r) => !validResult(r) || r.property === undefined)
    || new Set(log.results.map((r) => r.property)).size !== log.results.length) {
    fail(`invalid structured checker log "${file}"`);
  }
  return {
    checker: log.checker,
    results: log.results.map(({ property, status, stepsChecked }) => ({
      property, status, ...(stepsChecked === undefined ? {} : { stepsChecked }),
    })),
  };
}

const QUINT_COMMAND = /^\s*(?:\$\s+)?(?:\S*\/)?quint\s+(?:verify|run)\b([^\r\n]*)$/im;
const QUINT_PROPERTIES = /--(?:invariant|temporal)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
const QUINT_CHECKING = new RegExp('^\\s*Checking invariant [\x27"`]?(' + PROPERTY + '?)(?=[\x27"`:\\s]|$)', 'gim');
const NAMED_VIOLATION = new RegExp('(?:invariant|property)\\s+[\x27"`]?(' + PROPERTY + '?)[\x27"`]?\\s+(?:is |was )?(?:violated|falsified)\\b', 'gi');
const QUINT_CROSS = new RegExp('^\\s*\u274c\\s+(' + PROPERTY + ')[ \t]*$', 'gm');
const CHECKER_ERROR = /\[(?:error|failure)\]|^\s*(?:(?:fatal\s+)?error\s*(?::|\[\w+\])|fatal error\b|(?:syntax|type) error\b)/im;
const resultFor = (status, property) => property ? { property, status } : { status };

function quintResults(text, isQuint) {
  const command = text.match(QUINT_COMMAND)?.[1] ?? '';
  const flags = [...command.matchAll(QUINT_PROPERTIES)].flatMap((m) => (m[1] ?? m[2] ?? m[3]).split(',').map((name) => name.trim()));
  const list = command.match(/--invariants[ \t]+(.+?)(?=[ \t]+--|$)/)?.[1].trim().split(/[ \t]+/) ?? [];
  const checking = [...text.matchAll(QUINT_CHECKING)].map((m) => m[1]);
  const scope = [...new Set([...flags, ...list, ...checking].filter((name) => propertyName.test(name)))];
  const bad = [...new Set([...text.matchAll(NAMED_VIOLATION), ...text.matchAll(QUINT_CROSS)].map((m) => m[1]))];
  const pass = /^\s*\[ok\]\s+No violation found\b/im.test(text);
  const violation = /\[violation\]/i.test(text);
  const error = CHECKER_ERROR.test(text);
  if (!pass && !violation && !(error && isQuint)) return [];
  const results = pass && !violation && !error
    ? (scope.length ? scope : [undefined]).map((name) => resultFor('verified', name)) : [];
  if (violation || error) {
    results.push(...(bad.length ? bad : [scope.length === 1 && !error ? scope[0] : undefined]).map((name) => resultFor('failed', name)));
  }
  return results;
}

function textLog(text) {
  const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const chunks = plain.split(/\r?\n(?=\s*(?:\$\s+)?(?:\S*\/)?quint\s+(?:verify|run)\b)/i);
  const isQuint = QUINT_COMMAND.test(plain) || /\[(?:ok|violation|error|failure)\]/i.test(plain);
  const quint = chunks.flatMap((chunk) => quintResults(chunk, isQuint));
  if (quint.length) return { checker: 'Quint', results: quint };

  const tlc = [];
  if (/^\s*Model checking completed\. No error has been found\./im.test(plain)) tlc.push(resultFor('verified'));
  for (const match of plain.matchAll(/^\s*Error: (?:Invariant|Action property) ([\w.!']+) is violated\./gim)) {
    tlc.push(resultFor('failed', match[1]));
  }
  if (/^\s*Error: (?:Temporal properties were violated|Deadlock reached)\./im.test(plain)) tlc.push(resultFor('failed'));
  if (tlc.length) {
    if (!tlc.some((result) => result.status === 'failed') && CHECKER_ERROR.test(plain)) tlc.push(resultFor('failed'));
    const states = [...plain.matchAll(/^\s*([\d,]+) states generated\b/gim)].at(-1)?.[1];
    const statesGenerated = states === undefined ? undefined : Number(states.replaceAll(',', ''));
    return { checker: 'TLC', results: tlc, ...(hasSteps(statesGenerated) ? { statesGenerated } : {}) };
  }

  const apalache = [];
  if (/\b(?:The outcome is:\s*NoError|Checker reports no error)\b/i.test(plain)) apalache.push(resultFor('verified'));
  const trace = /^\s*State 0:[ \t]*(?![ \t]|Checking\b|state invariant\b)/im.test(plain);
  if (/\b(?:The outcome is:\s*Error|Found an error)\b/im.test(plain) || trace) {
    const names = [...plain.matchAll(NAMED_VIOLATION)].map((m) => m[1]);
    apalache.push(...(names.length ? names : [undefined]).map((name) => resultFor('failed', name)));
  }
  if (apalache.length) {
    if (!apalache.some((result) => result.status === 'failed') && CHECKER_ERROR.test(plain)) apalache.push(resultFor('failed'));
    return { checker: 'Apalache', results: apalache };
  }

  if (CHECKER_ERROR.test(plain)) {
    return { checker: 'Checker', results: [resultFor('failed')] };
  }
  return { checker: null, results: [] };
}

function checkLogVerdicts(board, files) {
  const results = files.flatMap((file) => file.results);
  if (results.length === 0) fail('unrecognized checker log format');

  const properties = new Set(board.rules.map((r) => r.property));
  const failures = results.filter((result) => result.status === 'failed');
  const failedProperties = new Set(board.rules.filter((r) => ruleStatus(r) === 'failed').map((r) => r.property));
  const unnamedFailure = failures.some((r) => r.property === undefined);
  const byProperty = Map.groupBy(results, (result) => result.property);
  const unnamedPass = properties.size === 1 && (byProperty.get(undefined) ?? []).some((r) => r.status === 'verified');
  for (const rule of board.rules) {
    const status = ruleStatus(rule);
    const matching = byProperty.get(rule.property) ?? [];
    const passed = matching.some((r) => r.status === 'verified') || unnamedPass;
    const namedFailure = matching.some((r) => r.status === 'failed');
    const failed = namedFailure || (failedProperties.size === 1 && unnamedFailure);
    if (status === 'verified' && (namedFailure || (unnamedFailure && properties.size === 1))) {
      fail(`checker log contradicts verified rule "${rule.id}" property "${rule.property}"`);
    }
    if (status === 'verified' && !passed) fail(`no passing checker verdict for rule "${rule.id}" property "${rule.property}"`);
    if (status === 'failed' && matching.some((r) => r.status === 'verified')) {
      fail(`checker log contradicts failed rule "${rule.id}" property "${rule.property}"`);
    }
    if (status === 'failed' && !failed) fail(`no failing checker verdict for rule "${rule.id}" property "${rule.property}"`);
    if (rule.stepsChecked !== undefined && matching.some((r) => r.stepsChecked !== undefined && r.stepsChecked !== rule.stepsChecked)) {
      fail(`checker log stepsChecked mismatch for rule "${rule.id}" property "${rule.property}"`);
    }
  }
  if (failures.length && board.run.status !== 'failed') fail('a checker violation or error requires run.status "failed"');
  if (unnamedFailure && failedProperties.size === 0) fail('an unnamed checker violation or error requires at least one failed rule');
  if (failures.length && board.rules.every((r) => ruleStatus(r) === 'verified')) fail('a checker violation or error contradicts an all-verified board');
  if (!failures.length && board.run.status === 'failed') fail('no failing checker verdict for run.status "failed"');
  if (board.run.status === 'verified' && !results.some((r) => r.status === 'verified')) {
    fail('no passing checker verdict for run.status "verified"');
  }
}

export function verifyCheckerLogs(board, files) {
  const logs = files.map(({ file, hash, text }) => ({
    file, hash, ...(text.trimStart().startsWith('{')
      ? structuredLog(text.trim(), file) : textLog(text)),
  }));
  if (logs.length) checkLogVerdicts(board, logs);
  return logs;
}

const bindingLevel = (specFiles, logFiles) => specFiles.length
  ? (logFiles.length ? 'spec-and-log' : 'spec-only')
  : (logFiles.length ? 'log-only' : 'self-reported');

const normalizedSpecHash = (hash) => typeof hash === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/i.test(hash)
  ? 'sha256:' + hash.toLowerCase().replace(/^sha256:/, '') : undefined;

export function bindEvidence(board, { specPaths = [], logPaths = [] } = {}) {
  const specs = readFiles(specPaths, 'spec');
  const specFiles = specs.map(({ file, hash }) => ({ file, hash }));
  const specHash = specs.length ? computeSpecHash(specFiles) : null;
  if (specHash && board.run.specHash !== undefined && normalizedSpecHash(board.run.specHash) !== specHash) {
    fail(`spec hash mismatch (computed ${specHash})`);
  }
  const refs = specs.length ? specRefs(board, specs) : {};
  const logFiles = verifyCheckerLogs(board, readFiles(logPaths, 'log'));
  return {
    level: bindingLevel(specFiles, logFiles),
    specHash,
    logHash: logFiles.length ? manifestHash(logFiles) : null,
    specFiles, logFiles, refs,
  };
}

function validFiles(files, log) {
  return Array.isArray(files) && files.every((f, i) => {
    const keys = log ? ['file', 'hash', 'checker', 'results'] : ['file', 'hash'];
    if (log && f?.statesGenerated !== undefined) {
      if (f.checker !== 'TLC' || !hasSteps(f.statesGenerated)) return false;
      keys.push('statesGenerated');
    }
    return exactKeys(f, keys) && safeFile(f.file) && typeof f.hash === 'string' && SHA256.test(f.hash)
      && (i === 0 || compare(files[i - 1].file, f.file) < 0)
      && (log
        ? Array.isArray(f.results) && (f.results.length ? safeChecker(f.checker) && f.results.every(validResult) : f.checker === null)
        : LANGUAGES.has(extname(f.file).toLowerCase()));
  });
}

export function validateBinding(board, binding) {
  if (!exactKeys(binding, ['level', 'specHash', 'logHash', 'specFiles', 'logFiles', 'refs'])
    || !validFiles(binding.specFiles, false) || !validFiles(binding.logFiles, true) || !isObject(binding.refs)) {
    fail('invalid embedded evidence metadata');
  }
  const { level, specHash, logHash, specFiles, logFiles, refs } = binding;
  if (level !== bindingLevel(specFiles, logFiles)
    || specHash !== (specFiles.length ? computeSpecHash(specFiles) : null)
    || logHash !== (logFiles.length ? manifestHash(logFiles) : null)
    || (specHash && board.run.specHash !== undefined && normalizedSpecHash(board.run.specHash) !== specHash)) {
    fail('embedded evidence level or hashes do not match the file records');
  }
  if (!exactKeys(refs, specFiles.length ? board.rules.map((r) => r.id) : [])) fail('embedded spec references do not match the board rules');
  const files = new Set(specFiles.map((f) => f.file));
  for (const rule of specFiles.length ? board.rules : []) {
    const ref = refs[rule.id];
    if (!exactKeys(ref, ['file', 'line', 'endLine', 'snippet']) || !files.has(ref.file)
      || !Number.isSafeInteger(ref.line) || ref.line < 1 || !Number.isSafeInteger(ref.endLine)
      || typeof ref.snippet !== 'string' || [...ref.snippet].length > 600 || absolutePath.test(ref.snippet)
      || ref.endLine !== ref.line + ref.snippet.split(/\r\n|\r|\n/).length - 1 || ref.endLine - ref.line > 9
      || !excerptDeclares(ref, rule.property)) {
      fail(`invalid embedded spec reference for rule "${rule.id}"`);
    }
  }
  if (logFiles.length) checkLogVerdicts(board, logFiles);
}

function excerptDeclares(ref, property) {
  const language = LANGUAGES.get(extname(ref.file).toLowerCase());
  const firstLine = (text) => maskSource(text, language).split(/\r\n|\r|\n/, 1)[0].trimStart();
  return [ref.snippet, language.block[0] + ref.snippet]
    .some((text) => firstLine(text).match(language.declaration)?.[1] === property);
}
