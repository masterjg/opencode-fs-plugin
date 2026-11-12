# Compatibility specification

This fork targets Linux and Node 22+. Tool names follow native commands; option
fields follow the native long options. The model-facing tools are grouped under
the `fs` namespace (`tools.fs.cp`, direct `fs_cp`).

## Principles

- Every tool is async and uses `fs/promises`.
- Every mutating tool asserts `fs_<tool>` permission before touching the disk.
- External targets require `external_directory` first.
- Output is native-style text plus structured metadata; errors are `ERROR:` or
  `BLOCKED:` with a stable code.
- Unsupported options fail with `unsupported` rather than being ignored.
- No tool invokes a shell or `child_process`.

## Background jobs

- Every tool accepts `background: true`; it returns a job id and an atomic
  status-file path instead of waiting.
- `fs.job` exposes `status`, `wait`, `cancel`, and `list`.
- Jobs are process-local and are lost on server restart. Status files live under
  `/tmp/opencode/fs-jobs/<server-pid>/`; finished jobs are cleaned after one hour.
- At most eight jobs run concurrently. Excess starts fail with `busy`.
- Results stay in memory and are returned by `fs.job`; status files contain only
  state and metadata. Permission checks still apply to background work.

## Deliberate gaps

These are not implemented:

- `xz`, `zstd`, `7z`, `rar`
- `awk`, full `sed` command language, `find -exec`
- `chown`, `chgrp`, `chattr`, `dd`, `rsync`
- ACL and xattr preservation in `cp -a`
- remaining GNU edge-flag parity for `ls`, `stat`, `sort`, `find`
- symlink-race-proof sandboxing
- unbounded `tail -f`; use bounded `follow` or the wait plugin
- archive extraction from arbitrary streams; create accepts text/stdin stream input
- cross-filesystem `trash`; use `rm` or a mount-trash helper

## Format details

- `stat` supports `%n %N %s %F %a %A %f %u %U %g %G %d %i %h %b %B %o %m %r
  %x %X %y %Y %z %Z %w %W %t %T %C %L`, plus `\n`, `\t`, `\\` and `%%`.
  `%C` returns `?` because Node does not expose the SELinux file context.
- `chmod` supports octal modes and symbolic `[ugoa]*[-+=][rwxXst]*` clauses.
- `find -size` uses binary suffixes (`K`, `M`, `G`, ...); `-mtime`/`-mmin`
  accept `+N` (older), `-N` (newer), and exact `N`. `newerXY` uses `XY:path`.
- `sort -k` accepts field/character ranges with modifiers `bdfghiMnrV`.
- `tar`/`zip` extraction rejects path traversal and escaping links.
- `pipe` passes raw bytes and only accepts registered pipeable stages; `tar` and
  `zip` are sink stages.

## Coverage policy

`npm run coverage` enforces 100% on `src/**`. `/* v8 ignore next */` is used only
for OS-error branches that cannot be produced deterministically in the test
environment; those paths remain in the source and are still exercised by the
type checker and integration tests where possible.
