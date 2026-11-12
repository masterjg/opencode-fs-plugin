---
name: Filesystem
description: Use when a task needs Linux-style filesystem or text operations beyond OpenCode's built-ins - copy, move, metadata, touch, truncate, symlinks, chmod, hashes, disk usage, find, archives, diff, trash, or composing filters through a pipe. Covers the fs namespace, argument shapes, native options, permissions, limits, and verification.
---

# Filesystem

The `opencode-fs-plugin` exposes a Linux-style toolkit under the `fs` namespace.
With `execute` allowed, call it as `tools.fs.<command>`; agents without
`execute` get direct `fs_<command>` tools.

## Choose the right tool

| Task | Use |
|---|---|
| Read file text or directory names | built-in `read` |
| Create or overwrite text | built-in `write` |
| Exact text replacement | built-in `edit` |
| Find paths by name | built-in `glob` |
| Ordinary content search | built-in `grep` |
| Copy, move, remove, metadata, links, archives | `fs.*` |
| Byte-exact concatenation or pipe input | `fs.cat` |
| Search inside a pipe or with extra flags | `fs.grep` |
| Metadata/predicate search | `fs.find` |
| Regex substitution or in-place edit | `fs.sed` |
| Recoverable deletion | `fs.trash` |

Do not duplicate a built-in when it already covers the job. `fs` exists for the
operations the built-ins do not cover, and for composable text/archive work.

## Command map

| Need | Command |
|---|---|
| Copy files/directories | `fs.cp` (`recursive`, `archive`, `noClobber`, `preserve`) |
| Move or rename | `fs.mv` (`noClobber`, `update`) |
| List, metadata | `fs.ls`, `fs.stat` (`long`, `human`, `format`) |
| Create, remove | `fs.mkdir`, `fs.rmdir`, `fs.rm` |
| Times and sizes | `fs.touch`, `fs.truncate` |
| Links and modes | `fs.ln`, `fs.readlink`, `fs.chmod` |
| Hash, usage | `fs.hash`, `fs.du`, `fs.df` |
| Predicate search | `fs.find` (`name`, `type`, `size`, `mtime`, `maxDepth`) |
| Archives | `fs.tar`, `fs.zip`, `fs.unzip`, `fs.gzip`, `fs.gunzip` |
| Compare | `fs.diff` |
| Temp and trash | `fs.mktemp`, `fs.trash` |
| Text filters | `fs.cat`, `fs.head`, `fs.tail`, `fs.grep`, `fs.sed`, `fs.sort`, `fs.uniq`, `fs.cut`, `fs.tr`, `fs.wc`, `fs.tee` |
| Compose filters | `fs.pipe` |

## Argument shapes

Use the exact field names; scalar `path` is only valid for `fs.mkdir`.

| Field | Commands |
|---|---|
| `path` | `fs.mkdir` |
| `sources` + `destination` | `fs.cp`, `fs.mv`, `fs.ln` |
| `paths` | `fs.stat`, `fs.ls`, `fs.find`, `fs.rm`, `fs.rmdir`, `fs.touch`, `fs.truncate`, `fs.chmod`, `fs.readlink`, `fs.du`, `fs.df`, `fs.cat`, `fs.head`, `fs.tail`, `fs.tee`, `fs.wc`, `fs.sort`, `fs.uniq`, `fs.cut`, `fs.tr`, `fs.grep`, `fs.sed`, `fs.gzip`, `fs.gunzip`, `fs.trash` |
| `files` | `fs.hash` |
| `left` + `right` | `fs.diff` |
| `archive` + `paths` | `fs.tar` create, `fs.zip` create |
| `archive` + `mode` | `fs.tar`, `fs.unzip` |
| `stages` + optional `input`/`output` | `fs.pipe` |

## Pipe

Stages run sequentially and pass bytes. Only pipeable tools are allowed. The
first stage may be a source or a filter; later stages consume stdin.

```js
await tools.fs.pipe({
  stages: [
    { tool: "cat", args: { paths: ["app.log"] } },
    { tool: "grep", args: { pattern: "ERROR", lineNumbers: true } },
    { tool: "sort", args: { unique: true } },
  ],
  output: "errors.txt",
})
```

`output` writes the final stream and `append` appends. Stage names are the short
native names (`cat`, `grep`, `sort`), not `fs.cat`. There is no shell,
redirection operator, nested pipe, or `find -exec`. A filter stage needs
`input` or a preceding source stage.

## Recipes

```js
// copy a tree and keep modes/timestamps
await tools.fs.cp({ sources: ["src"], destination: "backup", recursive: true, preserve: true })

// metadata and a human-readable listing
await tools.fs.stat({ paths: ["package.json"], format: "%n %s %a %y" })
await tools.fs.ls({ paths: ["dist"], long: true, human: true })

// find by name and size, then remove or trash deliberately
await tools.fs.find({ paths: ["."], name: "*.log", size: "+10M" })
await tools.fs.trash({ paths: ["old.log"] })

// create and extract an archive
await tools.fs.tar({ mode: "create", archive: "dist.tgz", paths: ["dist"], gzip: true })
await tools.fs.tar({ mode: "extract", archive: "dist.tgz", directory: "out" })

// compare two files
await tools.fs.diff({ left: "old.txt", right: "new.txt", unified: 3 })
```

## Limits

- Linux only; there is no Windows branch.
- `fs.sed` supports `s<delim>pattern<delim>replacement<delim>flags` with `g`,
  `i` and `p`. It is not a full sed interpreter.
- `fs.find` has no `-exec`; use `fs.rm`/`fs.trash` separately.
- No `xz`, `zstd`, `7z`, `chown`, `chattr`, `dd`, or `rsync`.
- `fs.tail` has no follow mode; `fs.diff` compares files/directories only.
- `cp -a` preserves mode and timestamps but not ACLs or xattrs.
- `fs.tar`/`fs.zip` are file-backed; they are not pipe stages.
- `fs.trash` uses the XDG home trash only and refuses cross-device moves.
- `fs.mktemp` uses the OS temp directory unless `tmpdir` is supplied.

## Paths and safety

- Paths resolve against the project directory. Paths outside it require
  `external_directory` approval, except tool-owned temp/trash paths.
- Symlinks are handled per command: `rm`/`mv` never follow the final link, `cp`
  follows unless `archive`/`dereference: false`, and `stat`/`ls` use lstat
  unless asked to follow.
- The project root, its ancestors, `/`, `$HOME`, and core system directories are
  hard stops for destructive operations.
- Archive extraction rejects absolute paths, `..`, and escaping links.
- `rm` is permanent; prefer `trash` for recoverable deletes.
- Pass `recursive: true` only when you intend to remove a whole tree.

## Permissions

Command actions are `fs_<command>` (for example `fs_cp`). `fs_*` wildcards work
in agent rules. `fs.pipe` asserts each stage's action; a denied stage cannot be
hidden inside a pipeline. Do not work around a denied tool with shell.

## Errors and output

- `ERROR: ...` is a recoverable tool failure; `BLOCKED: ...` is a sandbox hard
  stop. Both carry a stable `code` in metadata.
- `fs.grep` with no matches and `fs.diff` with differences return exit code 1;
  that is a result, not a tool failure.
- Binary output is returned as base64 when no `output` file is supplied.
- Invalid arguments return `ERROR: Invalid ...`; fix the field names or option
  values rather than retrying the same call.

## Verification

Use `fs.stat`, `fs.ls`, `fs.hash`, `fs.cat`, or `fs.diff` to confirm the result.
Report the tool result, such as `copied: 1`, `found: 2`, or
`differences: true`.
