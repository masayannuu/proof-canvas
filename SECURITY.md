# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately through
[GitHub Private Vulnerability Reporting](https://github.com/masayannuu/proof-canvas/security/advisories/new)
on `masayannuu/proof-canvas`. Do not open public issues for undisclosed vulnerabilities.

Include a minimal reproduction (board JSON, spec/log inputs, or CLI invocation) and the expected
versus actual security behavior.

## Scope

The following classes of issues are in scope:

- **HTML / SVG injection (XSS) and escaping bypasses** in rendered boards (`render_board.mjs` and its
  embedded browser runtime).
- **Offline or embed-safety bypasses** that allow external network requests, CSS leakage outside
  `.pc-root`, or unsafe URLs past `validate_board.mjs`.
- **Evidence, hash, or mutant-log binding bypasses** where forged or mismatched specs, checker logs,
  or mutant traces pass validation as verified or trace-bound.
- **Regular-expression denial of service (ReDoS)** or payload decompression-bomb bypasses when
  parsing untrusted board JSON, spec files, checker logs, or HTML payloads.

## Out of Scope / Threat Model Note

`render_board.mjs` and `validate_board.mjs` are local CLI tools: `--in`, `--out`, `--spec`, `--log`,
and `--mutant-log` file paths are caller-controlled. Reading or writing paths explicitly passed on
the command line by the local operator is expected behavior, though absolute host paths must not
leak into rendered HTML output.
