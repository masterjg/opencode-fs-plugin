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

## Deliberate gaps

These are not implemented:

- `xz`, `zstd`, `7z`, `rar`
- `awk`, full `sed` command language, `find -exec`, `tail -f`
- `chown`, `chgrp`, `chattr`, `dd`, `rsync`
- ACL and xattr preservation in `cp -a`
- full GNU edge-flag parity for `ls`, `stat`, `sort`, `find`
- symlink-race-proof sandboxing
- `tar`/`zip` creation from arbitrary streams; archives are file-backed
- cross-filesystem `trash`; use `rm` or a mount-trash helper

## Format details

- `stat` supports `%n %N %s %F %a %A %u %U %g %G %d %i %h %b %B %o %x %X %y
  %Y %z %Z %t %T %L`, plus `\n`, `\t`, `\\` and `%%`.
- `chmod` supports octal modes and symbolic `[ugoa]*[-+=][rwxXst]*` clauses.
- `find -size` uses binary suffixes (`K`, `M`, `G`, ...); `-mtime`/`-mmin`
  accept `+N` (older), `-N` (newer), and exact `N`.
- `tar`/`zip` extraction rejects path traversal and escaping links.
- `pipe` passes raw bytes and only accepts registered pipeable stages.

## Coverage policy

`npm run coverage` enforces 100% on `src/**`. `/* v8 ignore next */` is used only
for OS-error branches that cannot be produced deterministically in the test
environment; those paths remain in the source and are still exercised by the
type checker and integration tests where possible.
