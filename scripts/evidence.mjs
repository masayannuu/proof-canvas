import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ruleStatus } from './schema.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = (message) => { throw new Error('binding: ' + message); };
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeFile = (value) => typeof value === 'string' && value.length > 0 && !/[/\\\x00-\x1f]/.test(value) && !/^(?:\.{1,2}$|[a-z]:)/i.test(value);
const absolutePath = /(?:^|[^\w.@+~-])(?:\/(?:Users|home|var|tmp|private|etc|opt|usr|root|Volumes|proc|sys|mnt|srv|Library|Applications|System|nix)\/[\w.@+~-]+|~\/[\w.@+~-]+|[a-z]:[\\/][\w.@+~-]+|\\\\[\w.-]+\\[\w.$ -]+)|\bfile:\/\//i;
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
    const encoding = flag === 'log' && bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : flag === 'log' && bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    return { file, hash: sha256(bytes), text: new TextDecoder(encoding).decode(bytes) };
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
  ['.tla', { line: ['\\*'], block: ['(*', '*)'], nested: true, declaration: /^([A-Za-z_]\w*)[ \t]*(?:(?:\([^=]*\)|\[.*\])[ \t]*)?==/ }],
  ['.als', { line: ['//', '--'], block: ['/*', '*/'], declaration: /^(?:assert|pred|fact|fun)[ \t]+(?:\w+\.)?(\w+)\b/ }],
  ['.lean', { chars: true, line: ['--'], block: ['/-', '-/'], nested: true, declaration: /^(?:@\[[^\]]*\][ \t]*)*(?:(?:private|protected|noncomputable|unsafe|partial)[ \t]+)*(?:theorem|lemma|def|abbrev|axiom|structure)[ \t]+([\w.']+)/ }],
  ['.dfy', { chars: true, line: ['//'], block: ['/*', '*/'], nested: true, declaration: /^(?:\{:[^}]*\}[ \t]*)*(?:(?:ghost|opaque|static)[ \t]+)*(?:lemma|predicate|function|method)[ \t]+(?:\{:[^}]*\}[ \t]*)*(\w+)\b/ }],
]);
const specExtension = (file) => extname(file).toLowerCase();
const isConfig = (file) => specExtension(file) === '.cfg';

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

function definitionRef(file, extension, originals, lines, start, next) {
  let end = next - 1;
  let braces = 0;
  if (extension !== '.tla' && extension !== '.lean') {
    for (let i = start; i < next; i++) {
      if (extension === '.als' && /^\s*(?:\w+\s*:\s*)?(?:check|run)\b/.test(lines[i])) {
        end = i - 1;
        break;
      }
      const before = braces;
      for (const char of lines[i]) {
        if (char === '{') braces++;
        if (char === '}') braces--;
      }
      if (braces < 0 || (before > 0 && braces === 0)) {
        end = braces < 0 && before === 0 ? i - 1 : i;
        break;
      }
    }
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
  const extension = specExtension(file);
  const language = LANGUAGES.get(extension);
  if (!language) fail(`unsupported --spec file "${file}"`);
  const originals = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const declarations = [];
  let start = 0;
  let end = originals.length;
  const hasModuleHeader = (line) => /^[ \t]*-{4,}[ \t]+MODULE[ \t]+\w+[ \t]+-{4,}\s*$/.test(line);
  if (extension === '.tla') start = originals.findIndex(hasModuleHeader) + 1;
  const lines = [...Array(start).fill(''), ...maskSource(originals.slice(start).join(''), language).split(/\r\n|\r|\n/)];
  if (extension === '.tla') {
    const terminator = lines.findIndex((line, index) => index >= start && /^\s*={4,}\s*$/.test(line));
    if (terminator !== -1) end = terminator;
  }
  let localDepth = 0;
  let moduleDepth = 0;
  for (let index = start; index < end; index++) {
    const line = lines[index];
    const match = line.trimStart().match(language.declaration);
    if (match && localDepth === moduleDepth) declarations.push({ name: match[1], index });
    if (extension === '.tla') {
      for (const token of line.matchAll(/\b(?:LET|IN)\b/g)) {
        localDepth = Math.max(0, localDepth + (token[0] === 'LET' ? 1 : -1));
      }
    } else if (extension === '.qnt') {
      for (const char of line) {
        if (char === '{') localDepth++;
        if (char === '}') localDepth--;
      }
      if (/^\s*module\s+\w+\s*\{/.test(line) || localDepth === 0) moduleDepth = localDepth;
    }
  }
  return declarations.map(({ name, index }, i) => [name,
    definitionRef(file, extension, originals, lines, index, declarations[i + 1]?.index ?? end),
  ]);
}

function specRefs(board, files) {
  const definitions = new Map();
  for (const file of files) {
    if (isConfig(file.file)) continue;
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
    && (result.property === undefined ? result.status === 'failed'
      : typeof result.property === 'string' && propertyName.test(result.property))
    && (result.stepsChecked === undefined || hasSteps(result.stepsChecked));
}

function structuredLog(text, file) {
  let log;
  try { log = JSON.parse(text); }
  catch { fail(`invalid structured checker log "${file}"`); }
  const specHash = normalizedSpecHash(log?.specHash);
  const keys = ['checker', 'results', ...(log?.schemaVersion === undefined ? [] : ['schemaVersion']),
    ...(log?.specHash === undefined ? [] : ['specHash'])];
  if (!exactKeys(log, keys) || (log.schemaVersion !== undefined && log.schemaVersion !== 'proof-canvas-log-1')
    || (log.specHash !== undefined && !specHash)
    || !safeChecker(log.checker) || !Array.isArray(log.results) || log.results.length === 0
    || log.results.some((r) => !validResult(r) || r.property === undefined)
    || new Set(log.results.map((r) => r.property)).size !== log.results.length) {
    fail(`invalid structured checker log "${file}"`);
  }
  return {
    checker: log.checker,
    ...(specHash ? { specHash } : {}),
    results: log.results.map(({ property, status, stepsChecked }) => ({
      property, status, ...(stepsChecked === undefined ? {} : { stepsChecked }),
    })),
  };
}

const QUINT_COMMAND = /(?:^|[\s/\\>"'])quint(?:\.cmd)?["']?[ \t]+(verify|run)\b([^\r\n]*)/i;
const QUINT_PROPERTIES = /^--(invariants?|temporal|inductive-invariant)(?:=(.*))?$/;
const NAMED_VIOLATION = new RegExp('(?:invariant|property)\\s+([\\x27"\x60]?)(' + PROPERTY + ')\\1\\s+(?:is |was )?(?:violated|falsified)\\b', 'gi');
const QUINT_CROSS = new RegExp('^[ \\t]*\u274c[ \\t]+(' + PROPERTY + ')[ \\t]*$', 'gm');
const CHECKER_ERROR = /\[(?:error|failure)\]|^\s*(?:(?:fatal\s+)?error\s*(?::|\[\w+\])|fatal error\b|(?:syntax|type) error\b)/im;
const unique = (values) => [...new Set(values)];
const resultFor = (status, property) => property ? { property, status } : { status };
const pathBasename = (path) => path.split(/[/\\]/).at(-1);
const unquote = (arg) => /^(['"])(.*)\1$/.exec(arg)?.[2] ?? arg;
const namesIn = (value) => unquote(value).split(',').map((name) => name.trim()).filter((name) => propertyName.test(name));
const namedViolations = (text) => [...text.matchAll(NAMED_VIOLATION)].map((m) => m[2]);

function cleanLog(text) {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-Z\\-_]/g, '')
    .split(/\r?\n/).map((line) => {
      if (!/[\r\b]/.test(line)) return line;
      const visible = [];
      let cursor = 0;
      for (const char of line) {
        if (char === '\r') cursor = 0;
        else if (char === '\b') cursor = Math.max(0, cursor - 1);
        else visible[cursor++] = char;
      }
      return visible.join('');
    }).join('\n');
}

function quintLog(text) {
  const lines = text.split('\n');
  const invocations = lines.flatMap((line, index) => {
    const command = line.match(QUINT_COMMAND);
    return command ? [{ index, mode: command[1].toLowerCase(), args: command[2] }] : [];
  });
  if (!invocations.length && !/\[(?:ok|violation)\]/i.test(text)) return null;

  const files = [];
  const verdicts = ({ index, mode, args }, end) => {
    const argv = args.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? [];
    const source = argv.map(unquote).find((arg) => !arg.startsWith('-') && /\.qnt$/i.test(arg));
    if (source) files.push(pathBasename(source));
    const scope = [];
    for (let i = 0; i < argv.length; i++) {
      const flag = unquote(argv[i]).match(QUINT_PROPERTIES);
      if (!flag) continue;
      if (flag[2] !== undefined) scope.push(...namesIn(flag[2]));
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) scope.push(...namesIn(argv[++i]));
      if (flag[1] === 'invariants') {
        while (argv[i + 1] && !argv[i + 1].startsWith('-')) scope.push(...namesIn(argv[++i]));
      }
    }

    const output = lines.slice(index + 1, end).join('\n');
    const violation = /\[violation\]/i.test(output);
    const error = CHECKER_ERROR.test(violation
      ? output.replace(/^[ \t]*error:[ \t]*(?:found a counterexample|Invariant violated)\.?[ \t]*$/gim, '')
      : output);
    if (violation || error) {
      const names = unique([...namedViolations(output), ...[...output.matchAll(QUINT_CROSS)].map((m) => m[1])]);
      return (names.length ? names : [new Set(scope).size === 1 && !error ? scope[0] : undefined])
        .map((name) => resultFor('failed', name));
    }
    if (mode !== 'verify' || !/^[ \t]*\[ok\][ \t]+No violation found\b/im.test(output)) return [];
    return unique(scope).map((name) => resultFor('verified', name));
  };

  const results = verdicts({ index: -1, args: '' }, invocations[0]?.index);
  invocations.forEach((run, i) => results.push(...verdicts(run, invocations[i + 1]?.index)));
  if (unique(files).length > 1) fail('split Quint invocations for different specs into separate --log files');
  return { checker: 'Quint', results, ...(files.length ? { specFile: files[0] } : {}) };
}

const TLC_SECTIONS = new Set((
  'SPECIFICATION INIT NEXT CONSTANT CONSTANTS INVARIANT INVARIANTS PROPERTY PROPERTIES ' +
  'CONSTRAINT CONSTRAINTS ACTION_CONSTRAINT ACTION_CONSTRAINTS SYMMETRY VIEW CHECK_DEADLOCK ' +
  'POSTCONDITION ALIAS REWARD PERIODIC'
).split(' '));
const TLC_PROPERTIES = new Set(['INVARIANT', 'INVARIANTS', 'PROPERTY', 'PROPERTIES']);

function tlcScope(config) {
  const scope = [];
  let section;
  for (const token of maskSource(config.text, LANGUAGES.get('.tla')).trim().split(/\s+/)) {
    if (TLC_SECTIONS.has(token)) section = token;
    else if (TLC_PROPERTIES.has(section) && propertyName.test(token)) scope.push(token);
  }
  return unique(scope);
}

function tlcLog(text, specs) {
  const results = [...text.matchAll(/^[ \t]*Error: (?:Invariant|Action property) ([\w.!']+) is violated\./gim)]
    .map((match) => resultFor('failed', match[1]));
  const pass = /^[ \t]*Model checking completed\. No error has been found\./im.test(text);
  if (!pass && !results.length && !/^[ \t]*Error: (?:Temporal properties were violated|Deadlock reached)\./im.test(text)) return null;
  if (!results.length && CHECKER_ERROR.test(text)) results.push(resultFor('failed'));

  const spec = text.match(/^[ \t]*Parsing file[ \t]+(.+\.tla)[ \t]*$/im)?.[1];
  const configs = specs.filter(({ file }) => isConfig(file));
  const commandConfig = text.match(/^[^\n]*\b(?:tlc2\.TLC|tlc)[ \t]+[^\n]*?-config[ \t]+(?:"([^"]+)"|'([^']+)'|(\S+))/im);
  const namedConfig = commandConfig && pathBasename(commandConfig[1] ?? commandConfig[2] ?? commandConfig[3]);
  const config = namedConfig ? configs.find(({ file }) => file === namedConfig)
    : configs.length === 1 ? configs[0] : null;
  const specFile = spec ? pathBasename(spec)
    : config && specs.filter(({ file }) => specExtension(file) === '.tla').length === 1
      ? specs.find(({ file }) => specExtension(file) === '.tla').file : undefined;
  if (pass && !results.length) {
    if (!config) fail('a TLC pass requires one supplied --spec .cfg or a transcript naming its supplied -config file');
    if (!specFile) fail('a TLC pass requires a single TLA+ spec or a log naming the parsed spec file');
    results.push(...tlcScope(config).map((name) => resultFor('verified', name)));
  }

  const states = [...text.matchAll(/^[ \t]*([\d,]+) states generated\b/gim)].at(-1)?.[1];
  const statesGenerated = states === undefined ? undefined : Number(states.replaceAll(',', ''));
  return { checker: 'TLC', results, ...(specFile ? { specFile } : {}),
    ...(pass && config && results.some((r) => r.status === 'verified') ? { configFile: config.file } : {}),
    ...(hasSteps(statesGenerated) ? { statesGenerated } : {}) };
}

function textLog(text, specs) {
  const plain = cleanLog(text);
  const quint = quintLog(plain);
  if (quint) return quint;

  const alloy = [...plain.matchAll(/^[ \t]*\d+\.[ \t]+(?:\w+[ \t]*:[ \t]*)?check[ \t]+(?:\w+[ \t]*:[ \t]*)?([A-Za-z_]\w*)\b[^\n]*\b(UNSAT|SAT)[ \t]*$/gm)]
    .map((m) => resultFor(m[2] === 'UNSAT' ? 'verified' : 'failed', m[1]));
  if (alloy.length) return { checker: 'Alloy', results: alloy };

  const tlc = tlcLog(plain, specs);
  if (tlc) return tlc;

  const reported = [...plain.matchAll(/^[ \t]*>[ \t]*Set an invariant to[ \t]+(\S+)/gm)].flatMap((m) => namesIn(m[1]));
  const flags = [...plain.matchAll(/\bapalache(?:-mc)?(?:\.cmd)?[ \t]+check\b[^\n]*/gi)]
    .flatMap((m) => [...m[0].matchAll(/[ \t]--inv=(?:"([^"]+)"|'([^']+)'|(\S+))/g)])
    .flatMap((m) => namesIn(m[1] ?? m[2] ?? m[3]));
  const scope = unique(reported.length ? reported : flags);
  const pass = /\b(?:The outcome is:\s*NoError|Checker reports no error)\b/i.test(plain);
  const trace = /^[ \t]*State 0:[ \t]*(?:<Initial predicate>[ \t]*|$)/im.test(plain);
  const violation = /\b(?:The outcome is:\s*(?:Error|Deadlock|RuntimeError)|(?:Checker has )?Found an error|Checker has found a deadlock)\b/i.test(plain) || trace;
  if (pass || violation) {
    const names = unique(namedViolations(plain));
    const results = violation || CHECKER_ERROR.test(plain)
      ? (names.length ? names : [scope.length === 1 ? scope[0] : undefined]).map((name) => resultFor('failed', name))
      : scope.map((name) => resultFor('verified', name));
    return { checker: 'Apalache', results };
  }

  if (CHECKER_ERROR.test(plain)) return { checker: 'Checker', results: [resultFor('failed')] };
  return { checker: null, results: [] };
}

function checkerMatches(checker, file) {
  const family = checker.match(/^(Quint|TLC|TLA\+\s+TLC|Apalache|Alloy|Lean|Dafny)(?=\s|$)/i)?.[1].toLowerCase();
  const extensions = { quint: '.qnt', tlc: '.tla', 'tla+ tlc': '.tla', apalache: '.tla', alloy: '.als', lean: '.lean', dafny: '.dfy' };
  return family ? extensions[family.replace(/\s+/g, ' ')] === specExtension(file)
    : ['.lean', '.dfy'].includes(specExtension(file));
}

function checkLogVerdicts(board, files, { specHash, specFiles, refs }) {
  const hashes = new Map(specFiles.map(({ file, hash }) => [file, hash]));
  for (const log of files) {
    if (!log.results.length) fail('unrecognized checker log format in "' + log.file + '"');
    if (specFiles.length && log.specFile && !hashes.has(log.specFile)) {
      fail(log.checker + ' log "' + log.file + '" references spec "' + log.specFile + '" outside the supplied --spec files');
    }
    if (log.specHash && log.specHash !== specHash && !specFiles.some((f) => f.hash === log.specHash && !isConfig(f.file))) {
      fail('spec hash mismatch in checker receipt "' + log.file + '"');
    }
  }

  const results = files.flatMap((log) => log.results.map((result) => ({ ...result, log })));
  const failures = results.filter((result) => result.status === 'failed');
  const byProperty = Map.groupBy(results, (result) => result.property);
  const unnamed = byProperty.get(undefined) ?? [];
  const failedRules = board.rules.filter((r) => ruleStatus(r) === 'failed');
  const ruleEvidence = [];

  for (const rule of board.rules) {
    const status = ruleStatus(rule);
    const ref = refs[rule.id];
    const compatible = ({ log }) => !ref || (checkerMatches(log.checker, ref.file)
      && (!log.specFile || log.specFile === ref.file)
      && (!log.specHash || log.specHash === specHash || log.specHash === hashes.get(ref.file)));
    const matching = byProperty.get(rule.property) ?? [];
    if (matching.some((result) => !compatible(result))) {
      fail('checker or spec in log does not match rule "' + rule.id + '" property "' + rule.property + '" (' + ref.file + ')');
    }
    const passes = matching.filter((r) => r.status === 'verified');
    const namedFailures = matching.filter((r) => r.status === 'failed');
    const unnamedFailures = unnamed.filter(compatible);
    if (status === 'verified' && (namedFailures.length || (unnamedFailures.length && board.rules.length === 1))) {
      fail('checker log contradicts verified rule "' + rule.id + '" property "' + rule.property + '"');
    }
    if (status === 'pending' && namedFailures.length) {
      fail('checker log contradicts pending rule "' + rule.id + '" property "' + rule.property + '"');
    }
    if (status === 'verified' && !passes.length) fail('no passing checker verdict for rule "' + rule.id + '" property "' + rule.property + '"');
    if (status === 'failed' && passes.length) fail('checker log contradicts failed rule "' + rule.id + '" property "' + rule.property + '"');
    const failed = namedFailures.length ? namedFailures : failedRules.length === 1 ? unnamedFailures : [];
    if (status === 'failed' && !failed.length) fail('no failing checker verdict for rule "' + rule.id + '" property "' + rule.property + '"');
    if (rule.stepsChecked !== undefined && matching.some((r) => r.stepsChecked !== undefined && r.stepsChecked !== rule.stepsChecked)) {
      fail('checker log stepsChecked mismatch for rule "' + rule.id + '" property "' + rule.property + '"');
    }
    const contributing = status === 'verified' ? passes : status === 'failed' ? failed : [];
    if (contributing.length) ruleEvidence.push([rule.id, unique(contributing.map(({ log }) => log.file))]);
  }
  if (failures.length && board.run.status !== 'failed') fail('a checker violation or error requires run.status "failed"');
  if (unnamed.length && failedRules.length === 0) fail('an unnamed checker violation or error requires at least one failed rule');
  if (!failures.length && board.run.status === 'failed') fail('no failing checker verdict for run.status "failed"');
  if (board.run.status === 'verified' && !results.some((r) => r.status === 'verified')) {
    fail('no passing checker verdict for run.status "verified"');
  }
  return Object.fromEntries(ruleEvidence);
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
  const logFiles = readFiles(logPaths, 'log').map(({ file, hash, text }) => ({
    file, hash, ...(text.trimStart().startsWith('{') ? structuredLog(text.trim(), file) : textLog(text, specs)),
  }));
  const ruleEvidence = logFiles.length ? checkLogVerdicts(board, logFiles, { specHash, specFiles, refs }) : undefined;
  return {
    level: bindingLevel(specFiles, logFiles),
    specHash,
    logHash: logFiles.length ? manifestHash(logFiles) : null,
    specFiles, logFiles, refs, ...(ruleEvidence ? { ruleEvidence } : {}),
  };
}

function validFiles(files, log) {
  return Array.isArray(files) && files.every((f, i) => {
    const keys = log ? ['file', 'hash', 'checker', 'results'] : ['file', 'hash'];
    if (log && !safeChecker(f?.checker)) return false;
    if (log && f?.specHash !== undefined) {
      if (typeof f.specHash !== 'string' || !SHA256.test(f.specHash)) return false;
      keys.push('specHash');
    }
    if (log && f?.specFile !== undefined) {
      if (!safeFile(f.specFile) || !checkerMatches(f.checker, f.specFile)) return false;
      keys.push('specFile');
    }
    if (log && f?.configFile !== undefined) {
      if (f.checker !== 'TLC' || !safeFile(f.configFile) || !isConfig(f.configFile) || !f.specFile) return false;
      keys.push('configFile');
    }
    if (log && f?.statesGenerated !== undefined) {
      if (f.checker !== 'TLC' || !hasSteps(f.statesGenerated)) return false;
      keys.push('statesGenerated');
    }
    return exactKeys(f, keys) && safeFile(f.file) && typeof f.hash === 'string' && SHA256.test(f.hash)
      && (i === 0 || compare(files[i - 1].file, f.file) < 0)
      && (log
        ? Array.isArray(f.results) && f.results.length > 0 && f.results.every(validResult)
        : LANGUAGES.has(specExtension(f.file)) || isConfig(f.file));
  });
}

export function validateBinding(board, binding) {
  const keys = ['level', 'specHash', 'logHash', 'specFiles', 'logFiles', 'refs'];
  if (binding?.logFiles?.length) keys.push('ruleEvidence');
  if (!exactKeys(binding, keys)
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
    if (!exactKeys(ref, ['file', 'line', 'endLine', 'snippet']) || !files.has(ref.file) || isConfig(ref.file)
      || !Number.isSafeInteger(ref.line) || ref.line < 1 || !Number.isSafeInteger(ref.endLine)
      || typeof ref.snippet !== 'string' || [...ref.snippet].length > 600 || absolutePath.test(ref.snippet)
      || ref.endLine !== ref.line + ref.snippet.split(/\r\n|\r|\n/).length - 1 || ref.endLine - ref.line > 9
      || !excerptDeclares(ref, rule.property)) {
      fail(`invalid embedded spec reference for rule "${rule.id}"`);
    }
  }
  if (logFiles.length) {
    if (logFiles.some(({ configFile }) => configFile && !files.has(configFile))) fail('missing embedded TLC config file');
    const actual = checkLogVerdicts(board, logFiles, { specHash, specFiles, refs });
    if (!isDeepStrictEqual(binding.ruleEvidence, actual)) fail('embedded checker logs do not match the rule evidence');
  }
}

function excerptDeclares(ref, property) {
  const language = LANGUAGES.get(specExtension(ref.file));
  const firstLine = (text) => maskSource(text, language).split(/\r\n|\r|\n/, 1)[0].trimStart();
  const declares = (text) => firstLine(text).match(language.declaration)?.[1] === property;
  if (declares(ref.snippet)) return true;
  const first = ref.snippet.split(/\r\n|\r|\n/, 1)[0];
  const close = first.indexOf(language.block[1]);
  return close !== -1 && !language.line.some((marker) => first.slice(0, close).includes(marker))
    && declares(language.block[0] + ref.snippet);
}
