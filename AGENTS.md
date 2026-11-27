# AGENTS.md

Engineering rules for `opencode-fs-plugin`. Read this before adding or changing
a tool.

## Non-negotiable goals

1. **Async-only I/O.** Use `fs/promises`, streams, and async iterables. No
   `*Sync` filesystem calls, no `child_process`, no shell. The permission-gated
   `command` tool starts processes only through `procage`, never `spawn` or a
   shell. The `fs_command` permission decides which executables may run.
2. **Concurrency follows the hardware.** The default is
   `os.availableParallelism()`; the plugin option `concurrency` and
   `OPENCODE_FS_CONCURRENCY` override it. Never hardcode a limit.
3. **Use every core that the work allows.** Any independent, per-item I/O must
   run in bounded parallel. Do not add sequential loops over files, entries, or
   directories when the results do not depend on each other.
4. **Keep command semantics.** Parallel work must preserve output order, stable
   error codes, permission checks, and cancellation. Speed never justifies a
   behavior change.

## Concurrency rules

- Take the limit from `ctx.concurrency`; never call `Promise.all` over
  user-sized input without a bound.
- Use `mapLimit` for arrays, `createLimiter` for recursive work, and `walkAll`
  for tree traversal. Do not add a new sequential `walk` loop in a tool.
- Pass `ctx.signal` through so aborts stop scheduling new work.
- Preserve input order in output, even when work completes out of order.
- Bound syscalls, not memory: a limiter slot must not be held while awaiting a
  nested traversal.

## Performance rules

- CPU-bound JavaScript (`sort`, `sed`, text diffing) stays single-threaded.
  Add worker threads only with a measured, documented reason.
- `tar`/`zip` member order is fixed by the format; do not reorder members for
  speed.
- Long operations must accept cancellation and must not buffer unbounded bodies
  in memory; prefer streams or a file sink.
- When changing traversal, hashing, copying, or archive code, measure with a
  synthetic tree (thousands of files, multiple directories) at concurrency 1
  versus the default before claiming an improvement.

## Layout

- `src/core/` — `parallel`, `fsutil` (`walkAll`), `stream`, `sandbox`,
  `permissions`, `jobs`.
- `src/tools/` — one tool per file, exporting a `ToolSpec`.
- `test/unit` and `test/e2e` — coverage is enforced at 100%. Use
  `/* v8 ignore next */` only for OS-error branches that cannot be produced
  deterministically.
- `skills/filesystem/SKILL.md` — shipped skill. Keep it byte-identical to
  `/var/home/marius/.config/opencode/skills/filesystem/SKILL.md`.

## Validation and self-review

CI (`.github/workflows/ci.yml`) runs Node 22, 24 and 26 on Ubuntu and is the
floor, not proof. Reproduce it locally before declaring complete:

```bash
npm ci
npm run typecheck
npm run coverage
npm audit --omit=dev --audit-level=high
npm pack --dry-run
```

- Every behavior change or bugfix needs focused regression tests: the reported
  failure, the successful path, and the relevant rejection/boundary cases. 100%
  coverage does not establish correctness; a test that mirrors the
  implementation's own assumption proves nothing.
- Security-sensitive changes (paths, permissions, archives, symlinks): inspect
  path components and canonicalization, symlink and hardlink cases,
  permission-check ordering, absence of side effects on denial, partial writes,
  cancellation, and races. Fail closed; document any residual.
- Formats and protocols: check interoperability against independent known-good
  fixtures or oracles in both directions. A writer→reader roundtrip through the
  same code can hide shared bugs such as wrong cpio padding.
- Before declaring complete, adversarially review the entire final diff against
  the base commit: trace failure paths and invariants, look for semantic
  regressions, and confirm the tests hit real branches rather than a shared-bug
  assumption. Document unresolved limitations.
- Report the exact commands and results. Check new tools manually through real
  calls in foreground, `background: true` with `fs.job`, and as a `pipe` stage
  where applicable.

Tests reduce risk; they do not replace judgment about what is untested.

## Commits and releases

- Conventional Commits, signed. Do not push or publish unless explicitly
  requested.
- Update `README.md`, `SPEC.md`, and the skill in the same change as behavior.
- Docs or instruction-only commits (including this file) do not by themselves
  imply a release.
- Version bumps for release-bound changes: a feature, new option or tool, or
  performance change → minor; fixes or docs only → patch. Major only for a
  complete rewrite, a new architecture, or a fully new or incompatible public
  API; never for a single option removal, a rename, or a `!` by itself. Release
  CI publishes npm and creates the GitHub tag; npm processing can lag a few
  minutes.
