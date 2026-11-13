---
name: Filesystem
description: Use when a task needs Linux-style filesystem, text, network, process, or system operations beyond OpenCode's built-ins - copy, move, metadata, permissions, ownership, touch, truncate, symlinks, chmod/chown, hashes, disk usage, find, archives (tar/zip/cpio/ar), comparing files or directories, process listing and signals, system info, binary inspection, text primitives, HTTP(S) requests, API calls, or file downloads (curl replacement), trash, background jobs, or composing filters through a pipe. Covers the fs namespace, argument shapes, native options, permissions, limits, and verification.
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
| HTTP(S) fetch, API call, or file download | `fs.http_request` |
| Batching or loops | `execute` JS loops over `tools.fs.*` |

Do not duplicate a built-in when it already covers the job. `fs` exists for the
operations the built-ins do not cover, and for composable text/archive work.

Use the `fs` tool for both the operation and its verification. Do not route an
`fs` operation through a shell or `toolbox.run`, and do not use shell to check
what `fs.stat`, `fs.ls`, `fs.hash`, `fs.diff`, or `fs.cat` can confirm.

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
| Archives | `fs.tar` (`create`/`extract`/`list`), `fs.zip`, `fs.unzip` (`extract`/`list`), `fs.cpio`, `fs.ar`, `fs.gzip`, `fs.gunzip` |
| Compare | `fs.diff` |
| Temp and trash | `fs.mktemp`, `fs.trash` |
| Text filters | `fs.cat`, `fs.head`, `fs.tail`, `fs.grep`, `fs.sed`, `fs.sort`, `fs.uniq`, `fs.cut`, `fs.tr`, `fs.wc`, `fs.tee`, `fs.tac`, `fs.rev`, `fs.nl`, `fs.paste`, `fs.comm`, `fs.split`, `fs.shuf`, `fs.fold` |
| Compose filters | `fs.pipe` |
| HTTP(S) | `fs.http_request` (`output`, `checksum`, `maxBytes`, `json`) |
| Processes | `fs.ps`, `fs.pgrep`, `fs.kill` (`dryRun` available) |
| System info | `fs.id`, `fs.uname`, `fs.uptime`, `fs.date`, `fs.findmnt`, `fs.mountpoint` |
| Binary inspection | `fs.file`, `fs.base64`, `fs.od`, `fs.strings` |
| Ownership | `fs.chown` (names or ids, `recursive`) |
| Block I/O | `fs.dd` (`blockSize`, `count`, `skip`, `seek`, `status`), `fs.sync` |
| cpio / ar | `fs.cpio`, `fs.ar` (`create`/`list`/`extract`) |
| Background jobs | `background: true`, then `fs.job` |

Recent parity additions:

| Tool | Added |
|---|---|
| `fs.sort` | `generalNumeric`, `humanNumeric`, `version`, `dictionary`, `ignoreNonPrinting`, `stable`, `check`, `checkQuiet`, `zeroTerminated`, GNU `keys` ranges |
| `fs.ls` | `size`, `numericIds`, `noGroup`, `noOwner`, `slash`, `quote`, `versionSort`, `extensionSort`, `fullTime`, `timeStyle`, `hide`, `ignore`, `groupDirectoriesFirst` |
| `fs.find` | `lname`/`ilname`, `regex`/`iregex`, `uid`/`gid`/`user`/`group`, `links`, `inum`, `samefile`, `fstype`, `newerXY`, `printf`; `c`/`w`/`b` size suffixes |
| `fs.stat` | `terse`, extended tokens `%f`, `%m`, `%r`, `%w`, `%W`, `%C` |
| `fs.tail` | bounded `follow`, `timeoutMs`, `intervalMs`, `maxBytes` |
| `fs.tar`/`fs.zip` | `input`/`member` stream input and pipe sink support |

## Argument shapes

Use the exact field names; scalar `path` is only valid for `fs.mkdir`. The host
silently drops unknown arguments, so a typo like `path` instead of `paths` makes
the tool run with defaults (often `.`), not fail.

| Field | Commands |
|---|---|
| `path` | `fs.mkdir` |
| `sources` + `destination` | `fs.cp`, `fs.mv`, `fs.ln` |
| `paths` | `fs.stat`, `fs.ls`, `fs.find`, `fs.rm`, `fs.rmdir`, `fs.touch`, `fs.truncate`, `fs.chmod`, `fs.chown`, `fs.readlink`, `fs.du`, `fs.df`, `fs.cat`, `fs.head`, `fs.tail`, `fs.tee`, `fs.wc`, `fs.sort`, `fs.uniq`, `fs.cut`, `fs.tr`, `fs.grep`, `fs.sed`, `fs.gzip`, `fs.gunzip`, `fs.trash`, `fs.file`, `fs.base64`, `fs.od`, `fs.strings`, `fs.sync`, `fs.mountpoint`, `fs.tac`, `fs.rev`, `fs.nl`, `fs.fold`, `fs.shuf` |
| `pids` | `fs.ps`, `fs.kill` |
| `pattern` | `fs.pgrep` |
| `files` | `fs.hash` |
| `left` + `right` | `fs.diff`, `fs.comm` |
| `archive` + `paths` | `fs.tar` create, `fs.zip` create, `fs.cpio` create, `fs.ar` create |
| `archive` + `mode` | `fs.tar`, `fs.cpio`, `fs.ar` (`create`/`extract`/`list`), `fs.unzip` (`extract`/`list`) |
| `input` + `output` | `fs.dd` (`blockSize`, `count`, `skip`, `seek`) |
| `content` | `fs.tee` when there is no stdin |
| `paths` + optional `keep`/`force`/`stdout`/`level`/`suffix` | `fs.gzip`, `fs.gunzip` |
| `url` + optional `output` | `fs.http_request` |
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
`input` or a preceding source stage. Set `grep.noFilename: true` in a pipe when
later stages need bare lines instead of `path:line`.

New filter stages: `tac`, `rev`, `nl`, `paste`, `shuf`, `fold`, `base64`, `od`,
and `strings`. `dd` and `cpio` are source/sink stages.

`http_request` is a source stage. Pipe stages exchange whole buffers, so set
`maxBytes` for large responses; use `output` for real streaming to disk.

```js
await tools.fs.pipe({
  stages: [
    { tool: "http_request", args: { url: "https://example.com/app.log", maxBytes: 8_000_000 } },
    { tool: "grep", args: { pattern: "ERROR" } },
  ],
})
```

## Background jobs

Every tool accepts `background: true`. It returns immediately with a job id and
an atomic status-file path; use it for long copies, searches, archives, or
hashes, then keep working and collect the result later.

```js
const job = JSON.parse(
  await tools.fs.cp({
    sources: ["large-tree"],
    destination: "backup",
    recursive: true,
    background: true,
  }),
)
// { jobId, tool, state: "running", statusPath }

await tools.fs.job({ id: job.jobId, wait: true, timeoutMs: 600000 }) // blocks
await tools.fs.job({ id: job.jobId })               // current status
await tools.fs.job({ id: job.jobId, cancel: true }) // abort
await tools.fs.job({ list: true })                  // newest first
```

`wait` returns the original tool result once the job completes; on timeout it
returns the status with `timedOut: true`. Jobs are process-local and lost on
server restart. Status files live under `/tmp/opencode/fs-jobs/<server-pid>/`;
eight jobs may run at once and finished jobs are cleaned after one hour.

To wait without blocking the session, combine the status file with `wait_for`.
Wait for any terminal state, then read the job for the result or error:

```js
await tools.wait.for({
  condition: {
    type: "file_contains",
    path: job.statusPath,
    pattern: '"state":"(completed|failed|cancelled)"',
    regex: true,
  },
  timeoutMs: 600000,
  intervalMs: 500,
})
const status = JSON.parse(await tools.fs.job({ id: job.jobId }))
```

A job that produces no text returns empty content from `fs.job wait`; verify the
effect with `fs.stat`, `fs.ls`, or `fs.diff`, and use `fs.job({ id })` for state.

## Loops and batching

`execute` is always available and is the orchestration layer for every `fs` tool.
Use ordinary JavaScript for iteration, conditionals, retries, and parallel calls.
Do not use a shell or `toolbox.run` for batching.

Sequential is the safe default for writes, destructive work, ordering, and
permission prompts:

```js
const files = (
  await tools.fs.find({
    paths: ["src"],
    name: "*.sh",
    type: "f",
    print0: true,
  })
).split("\0").filter(Boolean)

for (const file of files) {
  await tools.fs.chmod({ paths: [file], mode: "640" })
}
```

Use `Promise.all` only for independent work. It rejects on the first failure
while the other calls continue, so prefer `Promise.allSettled` when partial
results are useful. Bound concurrency to about 4–8:

```js
async function mapLimit(items, limit, fn) {
  const results = []
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return results
}

const stats = await mapLimit(files, 4, (file) =>
  tools.fs.stat({ paths: [file], format: "%n %s" }),
)
```

Each call still enforces its own `fs_<tool>` and `external_directory`
permissions; loops do not bypass them. Code Mode has no timers, so use
`wait_for` for time-based waits and `background: true` for long jobs.

## Performance

All `fs` I/O is asynchronous. Independent work is parallelized automatically
within each call, up to `os.availableParallelism()`: tree copies, hashing,
gzip/gunzip, grep reads, `find`/`du`/`grep -r`/`chmod -R`/`chown -R` traversal,
`diff -r`, `ls` formatting, `ps` /proc scans, and `split` writes. Do not add
your own concurrency for those.

The limit comes from the plugin `concurrency` option or
`OPENCODE_FS_CONCURRENCY`. CPU-bound `sort`, `sed`, and text diffing stay
single-threaded, so very large inputs use one core.

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

// create, list, and extract an archive
await tools.fs.tar({ mode: "create", archive: "dist.tgz", paths: ["dist"], gzip: true })
await tools.fs.tar({ mode: "list", archive: "dist.tgz" })
await tools.fs.tar({ mode: "extract", archive: "dist.tgz", directory: "out" })
await tools.fs.unzip({ archive: "bundle.zip", mode: "list" })

// compare two files
await tools.fs.diff({ left: "old.txt", right: "new.txt", unified: 3 })

// processes, binaries and archives
await tools.fs.ps({ command: "node", sortBy: "rss", limit: 5 })
await tools.fs.file({ paths: ["dist/app"] })
await tools.fs.cpio({ mode: "create", archive: "bundle.cpio", paths: ["dist"] })
await tools.fs.ar({ mode: "list", archive: "lib.a" })

// API call, then a verified download
await tools.fs.http_request({ url: "https://api.github.com/repos/owner/repo/releases/latest" })
await tools.fs.http_request({
  url: "https://example.com/tool-1.0.0.tgz",
  output: "tool-1.0.0.tgz",
  checksum: "sha256:<hex>",
  maxBytes: 50_000_000,
  background: true,
})
```

## Limits

- Linux only; there is no Windows branch.
- `fs.sed` supports `s<delim>pattern<delim>replacement<delim>flags` with `g`,
  `i` and `p`. It is not a full sed interpreter.
- `fs.find` has no `-exec`; use `fs.rm`/`fs.trash` separately.
- No `xz`, `zstd`, `7z`, `rar`, `chattr`, ACLs, xattrs, or `rsync`.
  `chown` and `dd` are available; the SSH MCP covers transfers.
- `fs.tail` has bounded `follow` only; unbounded `tail -f` is not supported.
- `cp -a` preserves mode and timestamps but not ACLs or xattrs.
- `fs.tar`/`fs.zip` create from `input` or stdin; extraction is file-backed.
- `fs.http_request` is HTTP(S) only: no FTP/SFTP, cookie jars, client
  certificates, proxies, multipart uploads, or resumable downloads.
- No process can be started or wrapped: `nohup`, `setsid`, and `timeout` are
  unavailable, and `fs.kill` rejects pid 0, pid 1, and process groups.
- No ICMP ping; use `fs.http_request` or a TCP port check. No ACL, xattr, or
  `chattr` support. `rsync`/`scp` are out of scope; use the SSH MCP.
- `fs.comm` expects sorted input. `fs.ar` uses GNU short names (16 bytes max);
  `fs.cpio` reads and writes newc only. `fs.dd` has no conversion flags.
- `fs.tar` resolves `paths` even when `directory` is set; pass absolute sources
  with `directory` or the member path may not be found.
- `fs.du` reports allocated blocks like `du`; use `fs.stat` with `%s` for
  apparent file bytes.
- `fs.trash` uses the XDG home trash only and refuses cross-device moves.
  Files under `/tmp` are usually on another filesystem; use a project path or a
  same-filesystem holding directory instead.
- `fs.mktemp` uses the OS temp directory unless `tmpdir` is supplied.
- `fs.mkdir` fails when the directory already exists; check with `fs.stat`
  first or treat `ERROR: Already exists` as a no-op.
- `fs.gunzip` needs `force` to overwrite the restored file; without `keep` it
  removes the `.gz` after decompressing.

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

`fs_http_request` is allowed by default, like `fetch`. Its resource is the
request host; rules can allow one host and ask or deny the rest. Each redirect
hop is checked against the new host. Nothing blocks localhost or private
addresses by default.

## Errors and output

- `ERROR: ...` is a recoverable tool failure; `BLOCKED: ...` is a sandbox hard
  stop. Both carry a stable `code` in metadata.
- `fs.grep` with no matches and `fs.diff` with differences return exit code 1;
  that is a result, not a tool failure.
- Binary output is returned as base64 when no `output` file is supplied. NUL
  output (`print0`, `sort -z`) is base64 too; prefer newline output in Code
  Mode.
- Tools that produce no text (`cp`, `mv`, `rm`, `touch`, `chmod`, `sed -i`) return
  empty content; verify the effect with `fs.stat`, `fs.ls`, or `fs.diff`.
- Invalid arguments return `ERROR: Invalid ...`; fix the field names or option
  values rather than retrying the same call.

## Verification

Use `fs.stat`, `fs.ls`, `fs.hash`, `fs.cat`, or `fs.diff` to confirm the result.
Do not verify with a shell command. Report the tool result or the verified state,
such as `copied: 1`, `found: 2`, or `differences: true`.
