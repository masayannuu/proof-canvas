# Contributing to proof-canvas

Thank you for your interest in contributing to `proof-canvas`.

## Principles

- **Zero runtime or build dependencies.** Production scripts (`scripts/*.mjs`) must use only
  Node 22+ standard-library ESM. Never add `dependencies` or `devDependencies` to `package.json`.
- **Deterministic, offline, self-contained HTML.** Identical inputs must produce byte-for-byte
  identical output with zero network access at view time.
- **Honest evidence.** Never relax provenance, spec/log binding, or `--mutant-log` verification
  gates.

## Local checks

Run these before opening a pull request:

```bash
npm test
node scripts/render_board.mjs --in examples/00_minimal.board.json --out /tmp/minimal.html
node scripts/validate_board.mjs --in examples/00_minimal.board.json /tmp/minimal.html
```

If you change layout, SVG figures, flow maps, or mobile styles, also run the headless Chromium
sweeps (`scripts/sweep_figures.py sweep|flow|mobile`) and `npm run bench` (requires `uv`).

## Pull requests and licensing

Keep PRs focused and include tests in `scripts/test_validator.mjs` for any schema, renderer,
validator, or parser change. All contributions are licensed under the [MIT License](LICENSE).
