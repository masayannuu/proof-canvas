# Evidence files: spec and checker log details

Detail for section 5 of [`SKILL.md`](../SKILL.md): how `--spec` and `--log` files are hashed,
matched to rules, and read.

## Spec files

Repeat `--spec` for Quint (`.qnt`), TLA+ (`.tla`), Alloy (`.als`), Lean (`.lean`),
and Dafny (`.dfy`) files. Include any TLC `.cfg` files used to scope passing logs.
Configs contribute to the spec hash. Each rule's `property` must match exactly one declaration.
Evidence includes the source basename, line range, and up to 10 lines or 600 characters.
Keep absolute paths out of source excerpts before publishing the board.

For one file, the hash is `sha256:` followed by the digest of the raw bytes. For several
files, hash the manifest. Sort by basename, encode each entry as the basename, a
newline, and the lowercase hex digest. Join entries with one newline. Use distinct
basenames. Apply the same convention to log hashes. If `run.specHash` is present, it
must match the full spec digest, with or without the `sha256:` prefix. If omitted, the
derived hash is saved in the evidence and the input board stays in sync.

## Checker logs

Repeat `--log` for native logs or `proof-canvas-log-1` JSON receipts from your actual
checker runs. Every supplied file must contain a recognized verdict.

- **Quint.** Include the `quint verify` command and its named invariant or temporal
  options. A passing `quint run` simulation cannot substantiate a verified rule.
- **Alloy 6.** Include the `exec` output. A `check` row ending in `UNSAT` confirms
  the assertion within its scope. A row ending in `SAT` reports a violation.
- **TLC.** A passing log covers the invariants and properties in its supplied `.cfg`.
  If you supply multiple configs, prefix each passing log with its TLC command
  and `-config` argument. With multiple TLA+ specs, keep the log line that names
  the parsed spec file.
- **Apalache.** A passing log covers the named invariants reported by the checker
  or recorded in the command's `--inv=` argument.

Log names are matched to rule properties. With `--spec`, the checker family must
match the bound source. Quint uses `.qnt`, Alloy uses `.als`, and TLC and Apalache
use `.tla`. Only named passes can substantiate a verified rule.

A JSON receipt uses a checker name and an array with one result per property.

```json
{
  "schemaVersion": "proof-canvas-log-1",
  "checker": "Dafny",
  "results": [{ "property": "RefundCap", "status": "verified", "stepsChecked": 5 }]
}
```

Use `verified` or `failed` in the receipt. The schema version, `specHash`, and
`stepsChecked` are optional. If present, `specHash` must match the full manifest
or the spec file bound to the reported rule. If the board and receipt both include
a step count, the counts must match.

The log producer supplies the record of what the checker ran. In the
[`examples/04_refund_guard/`](../../../examples/04_refund_guard/) example,
`refund_guard.quint.log` records the Quint command followed by its verbatim output.
See the [README](../../../README.md#check-a-spec-and-checker-log) for the commands and the
combined native-log example.
