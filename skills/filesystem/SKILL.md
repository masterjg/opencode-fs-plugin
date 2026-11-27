---
name: Filesystem
description: Use when a task needs Linux-style filesystem, text, network, process, or system operations through the `fs` namespace - call `tools.fs.*` under `execute` or direct `fs_*` tools for paths, metadata, copy/move/remove, permissions, text filters and pipes, archives, hashing, comparing files/directories (`fs.diff`/`fs.comm`), HTTP(S) fetches, process listing, or the sandboxed `command` runner; includes `commandPaths`/`commandEnvVars`/per-call `envVars`, background jobs, and exact per-tool argument schemas, field types, bounds, required/optional fields, returns, and exit codes.
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
| `curl` fetch, API call, or file download | `fs.curl` |
| Allowlisted CLI or package tool | `fs.command` (no shell; names allowed by `fs_command`) |
| Many independent fs calls | one multi-path call, else `Promise.all` in `execute` |
| Sequential byte pipeline | `fs.pipe` |

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
| Predicate search | `fs.find` (`name`, `type`, `size`, `mtime`, `maxDepth`, `action`) |
| Archives | `fs.tar` (`create`/`extract`/`list`), `fs.zip`, `fs.unzip` (`extract`/`list`), `fs.cpio`, `fs.ar`, `fs.gzip`, `fs.gunzip` |
| Compare | `fs.diff` |
| Temp and trash | `fs.mktemp`, `fs.trash` |
| Text filters | `fs.cat`, `fs.head`, `fs.tail`, `fs.grep`, `fs.sed`, `fs.sort`, `fs.uniq`, `fs.cut`, `fs.tr`, `fs.wc`, `fs.tee`, `fs.tac`, `fs.rev`, `fs.nl`, `fs.paste`, `fs.comm`, `fs.split`, `fs.shuf`, `fs.fold` |
| Compose filters | `fs.pipe` |
| curl | `fs.curl` (`output`, `checksum`, `maxBytes`, `json`) |
| Allowlisted package CLI | `fs.command` (`command`, `args`, `cwd`, `stdin`, `timeoutMs`) |
| Processes | `fs.ps`, `fs.pgrep`, `fs.kill` (`dryRun` available) |
| System info | `fs.id`, `fs.uname`, `fs.uptime`, `fs.date`, `fs.findmnt`, `fs.mountpoint` |
| Binary inspection | `fs.file`, `fs.base64`, `fs.od`, `fs.strings` |
| Ownership | `fs.chown` (names or ids, `recursive`) |
| Block I/O | `fs.dd` (`blockSize`, `count`, `skip`, `seek`, `status`), `fs.sync` |
| cpio / ar | `fs.cpio`, `fs.ar` (`create`/`list`/`extract`) |
| Background jobs | `background: true`, then `fs.job` |

## Argument reference

Every registered tool is listed below with its real input schema. `?` marks an
optional field; a field without `?` is required. Types are `str`, `int`, `bool`,
`str[]`, `int[]`, `enum(a, b)`, `obj`; Notes give real bounds and defaults.
Canonical names are the schema names. These aliases exist and no others: `path`
for one `paths` element (`fs.stat`, `fs.ls`, `fs.cat`, `fs.find`, `fs.tee`,
`fs.grep`, `fs.sed`), `source` for one `sources` element (`fs.cp`, `fs.mv`,
`fs.ln`), `expression` for one `expressions` element (`fs.sed`), `limit` for
`maxCount` (`fs.grep`), and `paths`/`path` for `files` (`fs.hash`). `fs.mkdir`
accepts `path` or `paths`, but not both.

- There are no positional arguments and no `-` flags; every option is a named
  field, and enum values are exact lowercase strings.
- The host drops unknown fields, so a misspelled field silently runs the call
  without that option. Check the exact name here instead of guessing.
- Every tool except `fs.job` also accepts `background? bool`; a pipe stage's
  `args` does not (see Background jobs).

### Paths, metadata, links

| Tool | Fields | Notes |
|---|---|---|
| `fs.stat` | `paths? str[]`, `path? str`, `follow? bool`, `format? str`, `terse? bool`, `filesystem? bool` | Runtime requires `paths` or `path` even though the schema marks both optional. `format` is printf-style (`%n %s %a %y`); `%s` is apparent bytes. |
| `fs.ls` | `paths? str[]` (default `["."]`), `path? str`, `all? bool`, `almostAll? bool`, `long? bool`, `human? bool`, `recursive? bool`, `directory? bool`, `inode? bool`, `classify? bool`, `size? bool`, `numericIds? bool`, `noGroup? bool`, `noOwner? bool`, `slash? bool`, `quote? bool`, `versionSort? bool`, `extensionSort? bool`, `fullTime? bool`, `timeStyle? enum(full-iso, long-iso, iso, locale)`, `hide? str[]`, `ignore? str[]`, `groupDirectoriesFirst? bool`, `sortBy? enum(name, size, time, none)`, `reverse? bool`, `onePerLine? bool` | `sortBy` default `name`; `hide`/`ignore` are name globs. |
| `fs.file` | `paths str[]` (min 1), `mime? bool` | Content magic detection. |
| `fs.find` | `paths? str[]` (default `["."]`), `path? str`, `name? str`, `iname? str`, `pathPattern? str`, `lname? str`, `ilname? str`, `regex? str`, `iregex? str`, `type? enum(f, d, l, p, s)`, `size? str` (`+10k`), `mtime? str` (`+7`), `mmin? str`, `maxDepth? int` (min 0), `minDepth? int` (min 0), `empty? bool`, `perm? str`, `uid? int`, `gid? int`, `user? str`, `group? str`, `links? str` (`+1`), `inum? int`, `samefile? str`, `fstype? str`, `newer? str`, `newerXY? str`, `printf? str`, `follow? bool`, `print0? bool`, `sort? bool` (default true), `action? enum(print, delete, trash)`, `recursive? bool` | `recursive: true` is legal only with `action: "delete"` and is needed to remove matched directories. `delete`/`trash` reject `printf`/`print0` and never remove the starting directory. `newerXY` is `XY:path`, e.g. `mm:/tmp/ref`. |
| `fs.du` | `paths? str[]` (default `["."]`), `summarize? bool`, `all? bool`, `human? bool`, `total? bool`, `maxDepth? int` (min 0), `follow? bool`, `oneFileSystem? bool` | Reports allocated blocks; `fs.stat %s` gives apparent bytes. |
| `fs.df` | `paths? str[]` (default `["."]`), `human? bool`, `inodes? bool`, `printType? bool`, `all? bool` | |
| `fs.findmnt` | `paths? str[]`, `fsType? str`, `noHeader? bool` | Mounts containing the paths. |
| `fs.mountpoint` | `paths str[]` (min 1), `quiet? bool` | Exit code 1 when a path is not a mount point. |
| `fs.readlink` | `paths str[]` (min 1), `mode? enum(raw, canonical, existing, missing)`, `noNewline? bool` | `mode` default `raw`. |
| `fs.sync` | `paths? str[]` (default `["."]`) | fsync files or directories. |

### Copy, move, remove, permissions, times

| Tool | Fields | Notes |
|---|---|---|
| `fs.cp` | `sources? str[]`, `source? str`, `destination str`, `recursive? bool`, `archive? bool`, `force? bool`, `noClobber? bool`, `update? bool`, `preserve? bool`, `dereference? bool` (default true), `verbose? bool` | Needs `sources` or `source`. Directory sources need `recursive` or `archive`; `archive` implies recursive+preserve+keep symlinks. Multiple sources need an existing directory destination. |
| `fs.mv` | `sources? str[]`, `source? str`, `destination str`, `force? bool`, `noClobber? bool`, `update? bool`, `verbose? bool` | Same source rule; multiple sources need an existing directory destination. |
| `fs.ln` | `sources? str[]`, `source? str`, `destination str`, `symbolic? bool`, `force? bool`, `noDereference? bool`, `relative? bool`, `verbose? bool` | Hard link by default; `symbolic: true` for a symlink. |
| `fs.mkdir` | `path? str`, `paths? str[]` (min 1), `parents? bool` (default false), `mode? str`, `verbose? bool` | Use `path` or `paths`, not both. An existing directory fails unless `parents: true` (then it is a no-op). |
| `fs.mktemp` | `template? str` (default `tmp.XXXXXXXXXX`), `directory? bool`, `tmpdir? str`, `suffix? str` | The template must END with at least three `X`; `suffix` must be one path component. The created path is printed. |
| `fs.rm` | `paths str[]` (min 1), `recursive? bool`, `force? bool`, `dir? bool`, `verbose? bool` | Permanent. Directory removal needs `recursive` (or `dir` for empty dirs). |
| `fs.rmdir` | `paths str[]` (min 1), `parents? bool`, `ignoreNonEmpty? bool`, `verbose? bool` | Empty directories only. |
| `fs.trash` | `paths str[]` (min 1), `force? bool` | XDG home trash; refuses cross-device moves. |
| `fs.chmod` | `paths str[]` (min 1), `mode? str`, `reference? str`, `recursive? bool`, `noDereference? bool`, `verbose? bool`, `changes? bool`, `silent? bool` | `mode` or `reference` is required. `mode` is octal (`755`) or symbolic (`u=rwx,go=rx`). |
| `fs.chown` | `paths str[]` (min 1), `user? str`, `uid? int` (min 0), `group? str`, `gid? int` (min 0), `recursive? bool`, `noDereference? bool` | `user`/`uid` are mutually exclusive, as are `group`/`gid`; at least one of user or group is required. |
| `fs.touch` | `paths str[]` (min 1), `accessOnly? bool`, `modifyOnly? bool`, `noCreate? bool`, `date? str`, `timestamp? str`, `reference? str`, `noDereference? bool` | `date` is `Date.parse` text or `@epoch`; `timestamp` is GNU `[[CC]YY]MMDDhhmm[.ss]`; `reference` copies another file's times. |
| `fs.truncate` | `paths str[]` (min 1), `size? str`, `reference? str`, `noCreate? bool`, `noDereference? bool` | `size` or `reference` is required. `size` accepts `10M` or a relative `+1K`/`-1K`. |

### Read, transform, compare text

| Tool | Fields | Notes |
|---|---|---|
| `fs.cat` | `paths? str[]`, `path? str`, `number? bool`, `numberNonBlank? bool`, `squeezeBlank? bool`, `showEnds? bool`, `showTabs? bool`, `showNonPrinting? bool` | With no `paths` it reads stdin; Code Mode has no stdin outside `fs.pipe`, so `fs.cat({})` fails. |
| `fs.head` | `paths? str[]`, `lines? int` (min 1, default 10), `skip? int` (min 0, default 0), `bytes? int` (min 1), `quiet? bool`, `verbose? bool` | `lines` XOR `bytes`; `skip` applies to lines only and is rejected with `bytes`. Range output is lines `skip+1 … skip+lines`. |
| `fs.tail` | `paths? str[]`, `lines? int` (min 1, default 10), `bytes? int` (min 1), `fromStart? bool`, `quiet? bool`, `verbose? bool`, `follow? bool`, `timeoutMs? int` (100–600000, default 10000), `intervalMs? int` (50–10000, default 250), `maxBytes? int` (min 1, default 1048576) | `lines` XOR `bytes`. `fromStart` makes `lines` a 1-based start line. `follow` needs exactly one file. |
| `fs.nl` | `paths? str[]`, `all? bool`, `start? int` (min 1, default 1), `width? int` (1–20, default 6), `separator? str` (default tab) | |
| `fs.tac` | `paths? str[]` | Reverse line order. |
| `fs.rev` | `paths? str[]` | Reverse characters per line. |
| `fs.fold` | `paths? str[]`, `width? int` (1–10000, default 80), `spaces? bool` | Wrap at spaces when `spaces`. |
| `fs.cut` | `paths? str[]`, `fields? str` (`1,3-5`), `characters? str`, `bytes? str`, `delimiter? str` (default tab), `outputDelimiter? str`, `complement? bool`, `onlyDelimited? bool` | Use one of fields/characters/bytes. |
| `fs.paste` | `paths? str[]`, `delimiters? str` (default tab), `serial? bool` | |
| `fs.comm` | `left str`, `right str`, `suppress1? bool`, `suppress2? bool`, `suppress3? bool`, `outputDelimiter? str` (default tab) | Inputs must be sorted. |
| `fs.tr` | `paths? str[]`, `set1 str`, `set2? str`, `delete? bool`, `squeeze? bool`, `complement? bool` | Ranges and character classes supported. |
| `fs.sed` | `script? str`, `expression? str`, `expressions? str[]`, `paths? str[]`, `path? str`, `inPlace? bool`, `extendedRegexp? bool`, `quiet? bool` | Requires `script`/`expression`/`expressions`. Only `s<delim>pattern<delim>replacement<delim>flags` with `g`, `i`, `p`. `inPlace` requires `paths`. |
| `fs.sort` | `paths? str[]`, `numeric? bool`, `generalNumeric? bool`, `humanNumeric? bool`, `version? bool`, `reverse? bool`, `unique? bool`, `ignoreCase? bool`, `dictionary? bool`, `ignoreNonPrinting? bool`, `ignoreLeadingBlanks? bool`, `stable? bool`, `check? bool`, `checkQuiet? bool`, `zeroTerminated? bool`, `keys? str[]`, `field? int` (min 1), `separator? str` | `keys` use GNU `-k` syntax (`2,2n`); `field` is a 1-based single field. |
| `fs.uniq` | `paths? str[]`, `count? bool`, `repeated? bool`, `uniqueOnly? bool`, `ignoreCase? bool`, `skipFields? int` (min 0), `skipChars? int` (min 0) | Compares adjacent lines; sort first for global uniqueness. |
| `fs.shuf` | `paths? str[]`, `headCount? int` (min 1), `zeroTerminated? bool` | |
| `fs.wc` | `paths? str[]`, `lines? bool`, `words? bool`, `bytes? bool`, `chars? bool`, `maxLineLength? bool` | |
| `fs.grep` | `pattern str`, `paths? str[]`, `path? str`, `recursive? bool`, `include? str[]`, `exclude? str[]`, `ignoreCase? bool`, `invert? bool`, `lineNumbers? bool`, `withFilename? bool`, `noFilename? bool`, `filesWithMatches? bool`, `filesWithoutMatch? bool`, `count? bool`, `onlyMatching? bool`, `word? bool`, `line? bool`, `fixed? bool`, `extended? bool`, `context? int` (min 0), `before? int` (min 0), `after? int` (min 0), `maxCount? int` (min 1), `limit? int` (min 1), `noMessages? bool` | A directory path needs `recursive: true`. Exit code 1 when nothing matches. |
| `fs.tee` | `paths? str[]`, `path? str`, `append? bool`, `content? str` | Needs `paths`, `content`, or stdin. Empty `paths` passes through only. |
| `fs.strings` | `paths? str[]`, `minLength? int` (1–255, default 4) | |
| `fs.base64` | `paths? str[]`, `decode? bool`, `wrap? int` (0–4096, default 76), `ignoreGarbage? bool` | `wrap: 0` disables wrapping. |
| `fs.od` | `paths? str[]`, `offset? int` (min 0, default 0), `length? int` (min 1), `width? int` (1–64, default 16) | |
| `fs.split` | `input? str`, `prefix? str` (default `x`), `lines? int` (min 1), `bytes? int` (min 1), `suffixLength? int` (1–16, default 2), `numeric? bool`, `additionalSuffix? str` | Exactly one of `lines` or `bytes`. Chunk capacity is checked before writing. |
| `fs.dd` | `input? str`, `output? str`, `blockSize? int` (1–16777216, default 512), `count? int` (min 1), `skip? int` (min 0), `seek? int` (min 0), `status? bool` | Needs `input` or stdin; omit `output` to write stdout. No conversion flags. |
| `fs.diff` | `left str`, `right str`, `unified? int` (min 0, default 3), `brief? bool`, `recursive? bool`, `ignoreWhitespace? bool`, `ignoreCase? bool`, `exclude? str[]` | Exit code 1 when files differ; that is a result, not a failure. |

### Archives and hashing

| Tool | Fields | Notes |
|---|---|---|
| `fs.tar` | `mode enum(create, extract, list)`, `archive str`, `paths? str[]`, `directory? str`, `gzip? bool`, `stripComponents? int` (min 0), `exclude? str[]`, `verbose? bool`, `input? str`, `member? str` | Create needs `paths`, `input`, or stdin. `gzip` is inferred from `.gz`/`.tgz`. Create resolves relative paths under `directory`. |
| `fs.zip` | `archive str`, `paths? str[]`, `level? int` (0–9), `input? str`, `member? str` | Recursive by default. Create needs `paths`, `input`, or stdin. |
| `fs.unzip` | `archive str`, `mode? enum(extract, list)`, `directory? str`, `overwrite? bool`, `noOverwrite? bool` | `mode` default `extract`; `directory` is the destination. |
| `fs.cpio` | `mode enum(create, list, extract)`, `archive str`, `paths? str[]`, `directory? str`, `members? str[]`, `input? str`, `member? str`, `verbose? bool` | newc format; create needs `paths`, `input`, or stdin. |
| `fs.ar` | `mode enum(create, list, extract)`, `archive str`, `paths? str[]`, `directory? str`, `members? str[]` | GNU short names (16 bytes max). Create needs `paths`. |
| `fs.gzip` | `paths? str[]`, `keep? bool`, `force? bool`, `stdout? bool`, `level? int` (0–9, default 6) | File mode writes `<name>.gz` and removes the source unless `keep`. |
| `fs.gunzip` | `paths? str[]`, `keep? bool`, `force? bool`, `stdout? bool`, `suffix? str` (default `.gz`) | Input must end with `suffix`; strips it and removes the source unless `keep`. |
| `fs.hash` | `files? str[]`, `paths? str[]`, `path? str`, `algorithm? enum(md5, sha1, sha256, sha512)`, `tag? bool` | Canonical is `files`; `algorithm` default `sha256`. Omit files to hash stdin. |

### Processes, system, HTTP

| Tool | Fields | Notes |
|---|---|---|
| `fs.ps` | `pids? int[]` (min 1), `user? str`, `command? str`, `sortBy? enum(pid, rss, start)`, `limit? int` (min 1), `noHeader? bool`, `format? enum(table, json)` | `sortBy` default `pid`; `format` default `table`; `command` is a regex. |
| `fs.pgrep` | `pattern str`, `full? bool`, `ignoreCase? bool`, `user? str`, `newest? bool`, `oldest? bool`, `count? bool`, `delimiter? str` | Exit code 1 when nothing matches; `delimiter` default newline. |
| `fs.kill` | `pids int[]` (each min 2), `signal? enum(HUP, INT, QUIT, KILL, TERM, USR1, USR2, STOP, CONT, CHLD)`, `dryRun? bool` | Signal default `TERM`; pid 0, 1, and process groups are rejected. |
| `fs.id` | `only? enum(user, group, groups)` | |
| `fs.uname` | `kernel? bool`, `nodename? bool`, `release? bool`, `version? bool`, `machine? bool` | |
| `fs.uptime` | `pretty? bool`, `loadAverage? bool` | |
| `fs.date` | `value? str`, `utc? bool`, `format? enum(iso, unix, rfc, date)` | `value` is `Date.parse` text or `@epoch`; `format` default `iso`. |
| `fs.curl` | `url str`, `method? enum(GET, POST, PUT, PATCH, DELETE, HEAD)`, `headers? obj`, `body? str`, `json? any`, `output? str`, `checksum? str`, `maxBytes? int` (min 1), `timeoutMs? int` (100–600000, default 30000), `failOnError? bool` (default true), `followRedirects? bool` (default true), `maxRedirects? int` (0–20, default 10) | `headers` maps names to string values; `body` and `json` are mutually exclusive. `checksum` is `<md5\|sha1\|sha256\|sha512>:<hex>`; bare hex means sha256. `output` streams to a temp file then renames. |

### Execution and orchestration

| Tool | Fields | Notes |
|---|---|---|
| `fs.command` | `command str`, `args? str[]`, `cwd? str`, `stdin? str`, `timeoutMs? int` (100–600000, default 120000), `envVars? obj` (name → str) | `command` is a bare executable name with no path or shell syntax. `args` are literal argv; `cwd` defaults to the project root and is sandboxed; `stdin` is used only outside a pipe. `envVars` is a per-call shallow overlay on `commandEnvVars` with the same validation; `commandPaths`/`commandEnvVars` are plugin options. There is no arbitrary `env` or per-call PATH field. |
| `fs.pipe` | `stages` 1–50 × `{ tool str, args? obj }`, `input? str`, `output? str`, `append? bool` | Stage names are short (`cat`, not `fs.cat`) and only the registered stage set is accepted (see Pipe). `output`/`append` act as a final `tee` under `fs_tee`. |
| `fs.job` | `id? str`, `wait? bool`, `cancel? bool`, `list? bool`, `timeoutMs? int` (1–600000, default 600000) | Needs `id` or `list`. `list` cannot combine with `id`/`wait`/`cancel`; `cancel` and `wait` are mutually exclusive. Permission `fs_job`. |

### Common mistakes

- Code Mode has no implicit stdin. For a direct call, pass the input field(s)
  that tool's schema requires: usually `paths`, but also `files` (`fs.hash`),
  `input` (`fs.split`, `fs.dd`), or `left`/`right` (`fs.diff`, `fs.comm`). With no
  input, tools that expect stdin fail, for example `fs.cat({})` returns
  `ERROR: no input files and no stdin.` Use `fs.pipe({ input, ... })` to supply
  stdin to a pipe source or filter.
- `fs.hash` canonical is `files`; `paths` and `path` are accepted aliases. `hash`
  needs `files` or pipe stdin.
- `fs.mkdir` canonical is `path`; `paths` is accepted but cannot be combined, and
  an existing directory is an error unless `parents: true`.
- `fs.stat` accepts `paths` or `path`; omitting both fails even though both are
  schema-optional.
- `fs.cp`/`fs.mv`/`fs.ln` use `sources` (or one `source`) plus `destination`;
  there is no `from`/`to`.
- `fs.sed` canonical is `script`/`expressions`; `expression` is accepted. Only
  `s/.../.../flags` is supported; line ranges use `fs.head({ skip, lines })` or
  `fs.tail`.
- `fs.grep` canonical is `maxCount`; `limit` is accepted. `pattern` is required,
  and `maxCount`/`limit` must be at least 1: there is no `0` for "unlimited", so
  omit the field instead. Add `recursive: true` for a directory.
- `fs.find.type` takes one GNU letter (`f`, `d`, `l`, `p`, `s`), not a word such
  as `file` or `dir`; any other value fails the call as invalid input.
- `fs.find` defaults to `action: "print"`; `recursive: true` is not a delete
  switch and is legal only together with `action: "delete"`. To delete, pass both
  `action: "delete"` and `recursive: true`; neither one removes a matched
  directory on its own. `delete`/`trash` never remove the starting directory, so
  use `fs.rm` if you mean the root.
- `fs.readlink` requires `paths` (at least one); it has no single `path` alias.
- `fs.zip` has no `directory` field: use `archive` plus `paths`/`input`/`member`.
  `directory` belongs to `fs.unzip` (and to `fs.tar`/`fs.cpio` create/extract).
- `fs.curl` rejects a body over `maxBytes` with
  `ERROR: Response exceeded maxBytes (...)`; the host call still completes, so
  check that text (and `metadata.ok` where exposed) rather than assuming a
  successful download.
- An unknown or stale `fs.job` id returns `ERROR: job not found: <id>` as normal
  content, not a host-level rejection; `fs.job({ list: true })` shows the ids
  still retained for this session.
- A missing path in `fs.ls`/`fs.stat`/`fs.cat` returns `ERROR: Not found: ...`;
  that is not a permission problem. Permission asks and denials happen at the
  host layer instead of producing an `ERROR:` string, so fix the path or the
  rule rather than retrying field names.
- For `fs.command`, a malformed name returns
  `ERROR: command must be a bare executable name: "<name>"` (schema-type errors
  still surface as `ERROR: Invalid ...`), an allowed name with no matching
  binary is `ERROR: exec command not found`, and a name that `fs_command` does
  not allow is a permission decision, not an argument error; allow the bare
  executable name rather than changing `args`.
- `fs.head` range is `skip` lines skipped, then `lines` lines (default 10), so
  `20–40` is `skip: 19, lines: 21`.
- `fs.mktemp` needs a template ending in at least three `X`; use `suffix` for an
  extension.
- `fs.chmod` needs `mode` or `reference`; `fs.truncate` needs `size` or
  `reference`; `fs.split` needs exactly one of `lines`/`bytes`; `fs.tee` needs
  `paths`, `content`, or stdin.
- `fs.command` does not accept a path, arbitrary `env`, or per-call PATH. Use
  its validated `envVars` overlay for selected child variables, and configure
  `commandPaths`/`commandEnvVars` in the plugin options.
- There is no `fs.write`; use the built-in `write` or `fs.tee({ paths, content })`.
- Do not expect a JSON envelope from ordinary tools: a call resolves to text.
  `fs.command`, background starts, and `fs.job` are the exceptions.

### Shell patterns and their fs equivalents

| Shell pattern | Use |
|---|---|
| `sed -n '1,80p' f` | `fs.head({ paths: [f], lines: 80 })` |
| `sed -n '20,40p' f` | `fs.head({ paths: [f], skip: 19, lines: 21 })` |
| `sed 's/a/b/'` / `sed -i` | `fs.sed({ script, paths, inPlace })` |
| `head -n N f` / `tail -n N f` | `fs.head` / `fs.tail` |
| `wc -l f` | `fs.wc({ paths: [f], lines: true })` |
| `sha256sum f` | `fs.hash({ files: [f] })` |
| `find ... -exec rm -rf {} +` | `fs.find({ ..., action: "delete", recursive: true })` or `action: "trash"` |
| `cat > f <<EOF` | built-in `write` or `fs.tee({ paths: [f], content })` |
| `rg pattern path` | `fs.grep({ pattern, paths })` or the built-in `grep` |
| `ls -l f` | `fs.ls({ paths: [f], long: true })` |
| `npm ...` / `uv run ...` | `fs.command({ command, args })` (`fs_command` permission) |

`sed -n` applied to another command's stdout has no fs equivalent; keep that in
the command pipeline. `fs.find` has no arbitrary `-exec` by design; use
`action: "delete"` or `"trash"` for the common cleanup case, or list the paths and
remove them explicitly.

## Command

`fs.command` runs an executable in a **procage sandbox** without a shell. It is
closest to the shell's `command <prog>`: one program with literal argv, not
`exec` (which replaces the shell) or `sh -c` (which parses shell syntax). The
executable allowlist is the `fs_command` permission: the tool asserts that action
with the bare executable name as its resource. Deny `*`, then allow the names
you need:

```jsonc
{ "permissions": [
  { "action": "fs_command", "resource": "*", "effect": "deny" },
  { "action": "fs_command", "resource": "npm", "effect": "allow" },
  { "action": "fs_command", "resource": "uv", "effect": "allow" }
] }
```

With no rule the base allow applies to every executable.

Executable lookup can be widened once in the plugin options with
`commandPaths`: absolute trusted directories are canonicalized (a configuration
symlink is trusted at its real target), deduplicated, and prepended in order to
both lookup and the child `PATH`. Each root grants read+exec for its whole
directory tree and never pre-grants write; the existing exec rules also add exec
on the resolved binary's directory and parent, with no target read/write from
this option. The option adds no executable names; `fs_command` still checks the
bare command name and there is no per-call path, arbitrary `env`, or PATH field
(only the validated `envVars` overlay). Prepend
only narrow, trusted directories: a broad ancestor such as `$HOME` grants broad
read+exec, and prepending shadows same-named binaries. A project rooted at `/`
has no eligible entries: every absolute directory is inside the workspace, so
setup fails closed. A symlink inside a configured directory is resolved before
execution under the same rules.

Extra child environment entries can be configured once with `commandEnvVars`, a
closed object of names to string values. They reach every `fs.command` child,
including pipe stages and background jobs, and override same-named proxy or
preset values. The plugin does not explicitly forward arbitrary caller
`process.env` entries; procage's baseline allowlist still supplies its normal
variables. Empty strings set a variable to the empty string; they do not unset
it. `PATH` and `TMPDIR` are refused as plugin-managed, names must match
`[A-Za-z_][A-Za-z0-9_]*`, values must be NUL-free strings, and invalid
configuration fails setup. Values are literal: the plugin does no interpolation
or implicit forwarding of unrelated host variables. OpenCode's own
`{env:VARIABLE_NAME}` config substitution may apply before plugin setup, and an
unset variable becomes the empty string.

A single call can overlay selected values with `envVars`. It is a shallow
per-invocation overlay on `commandEnvVars`: a same-named value wins, unspecified
configured entries remain, and an empty string sets that variable to empty. It
works for direct calls, pipe command stages, and background jobs, uses the same
validation, and adds no lookup, `PATH`, filesystem, or network permission:

```js
await tools.fs.command({ command: "npm", args: ["test"], envVars: { NODE_ENV: "test" } })
```

The configured and per-call values are trusted input and can change what the
allowlisted executable and its descendants do. The plugin does
not automatically add them to its own errors or result metadata,
but the executable and its descendants can read them and may print or write
them; stdout and stderr are returned normally. Treat them as visible to that
executable and its descendants.

The project is read/write/exec. **Network egress needs Linux tier T1** and uses
procage's transparent relay. There are no per-call grants. Every TCP/UDP flow is
named as a DNS QNAME, TLS SNI, HTTP `Host`, QUIC SNI, or IP literal, and that
exact resource is approved through `fs_command_network`; ports, URLs, and payloads
are never part of the permission. Bare IPv6 literals and bracketed IPv6 `Host`
forms with an optional port are valid resources. The permission rules are the
network allowlist: a `*` deny plus name/address allows fails closed for anything
else.

> **Migration from `fs_exec_network`:** replace every old rule with
> `fs_command_network` before upgrading. Old rules are ignored; an unlisted
> `fs_command_network` resource can fall back to the base allow unless another
> matching rule applies, so an old `fs_exec_network` `deny *` no longer closes
> egress.

DNS is authorized by QNAME. Allowed answers feed a per-run address-to-name
cache: a nameless flow is allowed by a fresh allowed name bound to its address,
else by the address. A named flow needs the exact `(name, address)` from an
allowed answer plus the allowed name, or both name and address allowed; a denied
named identity is never rescued by an allowed address. Allow an address in
addition to the name when a program connects to an IP literal, or when a named
flow's exact `(name, address)` was not returned by an allowed DNS answer.

DoH blocking is best-effort: TCP/853 and known DoH names are refused, but custom
or unknown DoH endpoints on other names or ports may not be recognized. ECH
detected in TLS or QUIC is visibly refused.

```js
await tools.fs.command({ command: "npm", args: ["install"], timeoutMs: 300000 })
```

Proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, lowercase
forms, npm proxy settings) pass through explicitly. The relay treats the proxy
as the destination, never its `CONNECT` target, so allow the proxy's address or
cached DNS name in `fs_command_network`; approving it lets the proxy reach whatever
it forwards. Beyond the explicit proxy list and plugin-managed `TMPDIR` (and
`PATH` when `commandPaths` is set), the only caller-supplied entries passed
explicitly are the validated `commandEnvVars` and per-call `envVars`; arbitrary
caller `process.env` entries do not pass. The preset's own allowlist still
applies, and a proxy variable may itself carry proxy credentials.

Denied paths ask `external_directory` and approval covers the denied path's
containing directory (or nearest existing ancestor) only when procage reports a
structured **write** violation (`file-write-*`). Read, exec, network, and
unknown operations never add a write rule; otherwise no path grant is inferred
and access stays denied — pre-grant the path or configure a rule. A path printed
on stdout or stderr is reported, never auto-approved. Denied access returns
`violations` and a `hint`. On Linux T2 or macOS the relay is unavailable, and a
relay control server that cannot start is treated the same way: the run
retries once with networking off (`net: "none"`, no resolver sockets, no macOS
resolver grant) and reports `networkMode: "disabled"` plus `networkReason`. A
denial, lost control link, malformed frame, or decision timeout refuses the
flow; there is no direct-IP fallback. `command` is a bare name, `args` are
literal, and `cwd` is sandboxed. Direct calls return JSON with
`exitCode`/`stdout`/`stderr`, violations, and the network fields `network`,
`networkMode`, `networkHosts`, and `networkReason`; `externalPaths` lists the
external roots the run could write to. In `fs.pipe` the stage passes raw stdout.

```js
await tools.fs.pipe({
  stages: [
    { tool: "command", args: { command: "npm", args: ["test"] } },
    { tool: "grep", args: { pattern: "FAIL" } },
  ],
})
```

A non-zero exit is a normal result; permission denial, timeout, and abort are
handled explicitly. Procage kills every process the run started, including
detached descendants, and returns captured stdout/stderr in full. It requires Linux
x64/arm64, glibc 2.28+, and Node 22.12+.

## Batch independent calls

`execute` is a JS runtime. Do not `await` independent fs calls one at a time.

1. **Use the widest native call first.** `cat`, `stat`, `hash`, `ls`, `grep`,
   `tee`, `wc`, `chmod`, `touch`, `rm`, and `trash` take `paths` arrays. Use one
   call when combined output is enough:

   ```js
   const stats = await tools.fs.stat({ paths: files, format: "%n %s" })
   const sums = await tools.fs.hash({ files })
   ```

2. **Fan out when you need per-item results.** `Promise.all` preserves input
   order:

   ```js
   const rows = await Promise.all(files.map(async (f) => {
     const text = String(await tools.fs.cat({ paths: [f] }))
     return { f, text, ok: !/^(ERROR|BLOCKED):/.test(text) }
   }))
   ```

   `fs` domain errors resolve as `ERROR:`/`BLOCKED:` text; they do not reject.
   Permission denials and host validation throw, so use `Promise.allSettled`
   only when those should not cancel the batch.

3. **Bound very large fan-outs.** One tool call per item is expensive; use a
   small worker pool (for example 8) instead of `Promise.all` over thousands:

   ```js
   async function mapLimit(items, limit, fn) {
     const out = new Array(items.length)
     let next = 0
     await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
       while (next < items.length) {
         const i = next++
         out[i] = await fn(items[i], i)
       }
     }))
     return out
   }
   ```

Keep `for (const x of items) { await ... }` only when each step depends on the
previous result, such as read → transform → write the same file. Use `fs.pipe`
for a sequential byte chain; use this section for independent work.

## Pipe

`fs.pipe` runs fs tools as a **sequential byte pipeline**: each stage's stdout
is the next stage's stdin. Use it for filter chains; use the batching pattern
above for parallel fan-out.

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

| Field | Meaning |
|---|---|
| `stages` | 1–50 `{ tool, args }` entries; names are short (`cat`, not `fs.cat`) |
| `input` | Initial stdin text when the first stage is a filter |
| `output` | Write final stdout to a file (final `tee`) |
| `append` | Append to `output` instead of overwriting |

The registered stage set is exact:

| Mode | Stage names |
|---|---|
| source | `base64`, `cat`, `curl`, `dd`, `fold`, `nl`, `od`, `paste`, `rev`, `shuf`, `strings`, `tac` |
| filter | `command`, `cut`, `grep`, `gzip`, `gunzip`, `head`, `sed`, `sort`, `tail`, `tee`, `tr`, `uniq` |
| sink | `cpio`, `hash`, `tar`, `wc`, `zip` |

The first stage must be a source or receive `input`. A filter first without
`input` fails the whole call with `ERROR: no input files and no stdin.`; the error
is the call result, not pipeline data. A source stage later in the chain ignores
pipe stdin when it has `paths`. Archive writers (`tar`, `zip`, `cpio`) emit no
stdout, so put them last; `wc` and `hash` emit their result text and can also end
a chain or feed a later stage.

Stages exchange whole buffers. Set `maxBytes` on `curl`; for large
downloads prefer `fs.curl({ output })`, which streams to disk. In-memory
text is allowed:

```js
await tools.fs.pipe({
  input: "b\na\nb\n",
  stages: [{ tool: "sort", args: { unique: true } }],
})
```

```js
await tools.fs.pipe({
  stages: [
    { tool: "curl", args: { url: "https://example.com/app.log", maxBytes: 8_000_000 } },
    { tool: "grep", args: { pattern: "ERROR" } },
  ],
})
```

`output` and `append` assert `fs_tee` on the destination. The result carries
per-stage metadata (`tool`, `bytesIn`, `bytesOut`, `exitCode`), which is the
verification trail where the surface exposes metadata; `execute` resolves to the
final text only. A stage that yields no stdout becomes an empty buffer, so
`output` writes an empty file. The signal is checked before each stage and
before the final write, so an abort stops the chain before creating output.

The returned content is the final buffer decoded as UTF-8. A binary stage such as
`gzip` cannot round-trip through that text; write it with `output`, which gets the
raw bytes before decoding. A stage's `args` use the same schema as the tool but
cannot include `background`.

Common pipe mistakes:

- `commands` is not a field; the field is `stages`.
- A bare `{ tool: "sort", args: {} }` first stage fails with
  `ERROR: no input files and no stdin.`; add a source stage or `input`.
- Stage names are `cat`, not `fs.cat`; any name outside the table fails with
  `ERROR: Unknown pipe stage: <name>` (`unsupported`).
- There is no shell, redirection operator, nested pipe, `find -exec`, or
  `xargs`.

## Background jobs

Every tool except `fs.job` accepts `background: true`. It returns immediately
with a job id and an atomic status-file path; use it for long copies, searches,
archives, or hashes, then keep working and collect the result later.

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

`wait` returns the original tool content once the job completes; on timeout it
returns the status JSON with `timedOut: true`. Status and `fs.job({ id })` content
is JSON with `id`, `tool`, `state` (`running`, `completed`, `failed`,
`cancelled`), `startedAt`, optional `finishedAt`/`error`, and `statusPath`;
`fs.job({ list: true })` returns `{ "jobs": [ ... ] }`, newest first. Jobs are
process-local and lost on server restart. Status files live under `/tmp/opencode/fs-jobs/<server-pid>/`
by default; set the plugin option `jobDir` to move them. The caps are global to
one server, not per session: eight jobs may run at once and 64 are retained,
evicting the oldest finished job and deleting its status file; finished jobs are
cleaned after one hour. A background start or `fs.job` call without a non-empty
session id fails with `invalid`. Jobs are visible only to the session that
started them; the `jobDir` path is validated component by component (an existing
symlink, non-directory component, or `/` is refused; missing components and the
final directory become `0700`), and status files are `0600`. This is deliberately
fail-closed: a benign path through a host symlink such as `/home` is rejected,
while the default `/tmp/opencode/fs-jobs/<pid>` path is unaffected. A component
swapped after validation is a residual TOCTOU gap. Status files omit the result,
raw error, and absolute status path. Each
in-memory result is capped at 1 MiB: longer text is truncated with
`[truncated]`/`truncated`/`originalBytes`, and oversized base64/binary output
becomes empty. Retaining 64 results can hold roughly 64 MiB in the server
process until eviction.

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

## Orchestration notes

`execute` is the orchestration layer for every `fs` tool. Each batched call still
asserts its own `fs_<tool>` and `external_directory` permission, so fan-out does
not bypass permissions. Code Mode has no timers: use `wait_for` for time-based
waits and `background: true` for long jobs. Writes and destructive operations
may fan out too when their targets are independent; keep ordering only when a
later step depends on an earlier result.

## Performance

All `fs` I/O is asynchronous. Independent work is parallelized automatically
within each call, up to `os.availableParallelism()`: tree copies, hashing,
gzip/gunzip, grep reads, `find`/`du`/`grep -r`/`chmod -R`/`chown -R` traversal,
`diff -r`, `ls` formatting, `ps` /proc scans, and `split` writes. Do not
re-implement that internal concurrency; fan out separate tool calls only as
described in Batch independent calls.

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
await tools.fs.curl({ url: "https://api.github.com/repos/owner/repo/releases/latest" })
await tools.fs.curl({
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
- `fs.command` requires procage: Linux x64/arm64, glibc 2.28+, Node 22.12+.
  Network egress needs Linux T1; elsewhere networking is disabled. External
  paths are denied until approved.
- `fs.find` has no arbitrary `-exec`; use `action: "delete"`/`"trash"` for the
  common cleanup case, or `fs.rm`/`fs.trash` separately.
- No `xz`, `zstd`, `7z`, `rar`, `chattr`, ACLs, xattrs, or `rsync`.
  `chown` and `dd` are available; the SSH MCP covers transfers.
- `fs.tail` has bounded `follow` only; unbounded `tail -f` is not supported.
- `cp -a` preserves mode and timestamps but not ACLs or xattrs.
- `fs.tar`/`fs.zip` create from `input` or stdin; extraction is file-backed.
- `fs.curl` is HTTP(S) only: no FTP/SFTP, cookie jars, client
  certificates, proxies, multipart uploads, or resumable downloads.
- Only `fs.command` starts processes, and only names allowed by `fs_command`; `nohup`,
  `setsid`, and `timeout` wrappers are unavailable. `fs.kill` rejects pid 0,
  pid 1, and process groups.
- No ICMP ping; use `fs.curl` or a TCP port check. No ACL, xattr, or
  `chattr` support. `rsync`/`scp` are out of scope; use the SSH MCP.
- `fs.comm` expects sorted input. `fs.ar` uses GNU short names (16 bytes max);
  `fs.cpio` writes newc with GNU 4-byte padding, reads both that and the prior
  3.x plugin padding, and rejects nonzero data after the trailer (concatenated
  archives); its fields must fit `0..0xffffffff`. `fs.dd` has no conversion
  flags.
  Archives store files, directories, and symlinks only; hard links, device
  nodes, and ACL/xattr metadata are dropped.
- `fs.tar` and `fs.cpio` create resolve relative `paths` under `directory`; an
  absolute source is named relative to `directory` first, then the project, else
  by basename (a traversing source also uses its basename).
- `fs.cp` fails closed on an existing symlink inside a recursive destination;
  `fs.mv` refuses a directory destination under the source, and EXDEV falls back
  to copy-then-remove that refuses a destination symlink. If nothing was copied
  or an entry was skipped, the source is kept and a partial destination remains.
- `fs.chown` refuses the sandbox root, ancestors, `/`, `$HOME`, and core system
  dirs before permission or mutation. `noDereference` canonicalizes the parent
  chain but leaves the final link, so `lchown` changes a final symlink itself.
- `fs.split` takes 1-16 suffix characters and fails with `invalid` before
  writing when the chunk count exceeds `26^n` (alphabetic) or `10^n`
  (`numeric`).
- `fs.curl` refuses a cross-origin redirect unless it is a bodyless `GET`/`HEAD`
  with only safe headers (`accept`, `accept-language`, `cache-control`,
  `pragma`, `range`, `user-agent`), and refuses an HTTPS to HTTP hop. A 303
  becomes a bodyless `GET` before that check; 301/302 rewrite `POST` after it;
  307/308 keep the method and body. `output` asks `external_directory` for the
  file's containing directory.
- Archive extraction plans every member, refuses an existing final symlink,
  applies the process umask to extracted file modes (strips setuid/setgid), and
  preserves sticky on directories. ZIP entries without a Unix mode default to
  `0644` files and `0755` directories before the umask. Directory modes are
  deduplicated by canonical target (last entry wins) and applied deepest-first.
  Ordinary mode changes use opened `O_NOFOLLOW` handles; an `EACCES` fallback for
  an unreadable existing directory uses guarded pathname `chmod`, keeping a
  final-component TOCTOU race. A bulk permission denial writes no members. A
  swapped parent, an existing destination hardlink, an OS error, or an abort can
  still redirect or partially write members.
  Archive create and extraction buffer the whole archive and each extracted
  member in memory, with no global archive-size cap.
- `fs.du` reports allocated blocks like `du`; use `fs.stat` with `%s` for
  apparent file bytes.
- `fs.trash` uses the XDG home trash only and refuses cross-device moves.
  Files under `/tmp` are usually on another filesystem; use a project path or a
  same-filesystem holding directory instead.
- `fs.mktemp` uses the OS temp directory unless `tmpdir` is supplied.
- `fs.mkdir` fails when the directory already exists unless `parents: true`,
  which makes an existing directory a no-op; check with `fs.stat` first when you
  need a hard answer.
- `fs.gunzip` needs `force` to overwrite the restored file; without `keep` it
  removes the `.gz` after decompressing.

## Paths and safety

- Paths resolve to their canonical target before permissions are asserted, so a
  symlink out of the project asks `external_directory` for the real location.
  Single-file output tools open the final component no-follow; `cp` rejects an
  existing symlink at a nested entry but its copy call is not no-follow. A
  parent directory swapped concurrently is still a TOCTOU gap, so treat the
  sandbox as a guardrail.
- This installation's global config allows `/tmp/opencode/**` and the OpenCode
  cache, state, and config trees; prefer `fs.mktemp` for scratch files, and treat
  a denied path as a blocker rather than switching to shell.
- Symlinks are handled per command: `rm`/`mv` never follow the final link, `cp`
  follows a top-level destination link and gates its target but refuses to write
  through an existing symlink inside a recursive copy, and `stat`/`ls` use lstat
  unless asked to follow.
- The project root, its ancestors, `/`, `$HOME`, and core system directories are
  hard stops for destructive operations; `fs.chown` enforces them before
  permission or mutation.
- Archive extraction plans every member before writing and asserts one bulk
  permission check for all targets: a denied member means nothing is written.
  Existing final symlinks, absolute names, `..`, and escaping links are
  rejected. File modes apply the umask and strip setuid/setgid; directory modes
  preserve sticky. Directory modes are deduplicated by canonical target (last
  entry wins) and applied deepest-first. Ordinary mode changes use `O_NOFOLLOW`
  handles; an `EACCES` fallback uses guarded pathname `chmod` with a
  final-component TOCTOU race. A swapped parent, an existing destination
  hardlink, an OS error, or an abort can still redirect or partially write
  members.
- `rm` is permanent; prefer `trash` for recoverable deletes.
- Pass `recursive: true` only when you intend to remove a whole tree.

## Permissions

Command actions are `fs_<command>` (for example `fs_cp`). `fs_*` wildcards work
in agent rules. `fs.pipe` asserts each stage's action; a denied stage cannot be
hidden inside a pipeline. Do not work around a denied tool with shell.

`fs.command` asserts `fs_command` with the executable name as its resource;
deny `*` for a closed set. It asks `external_directory` for a blocked path and
`fs_command_network` with the exact DNS name or IP address named by the relay.
There is no `*` fallback and no direct-IP mode; networking that cannot use the
relay is disabled. There are no per-call grants and no shell.

`fs.curl` reuses the built-in `webfetch` permission (there is no `fs_curl`
action) with the requested URL as the resource, so one rule set covers both; each
redirect hop is checked against its URL. Nothing blocks localhost or private addresses by default.

## Returns, errors, and exit codes

- A normal call resolves to its **content text**: stdout decoded as UTF-8. The
  host attaches metadata beside it (`ok`, `exitCode`, `bytes`, `encoding`, and
  tool counters); in `execute` you see the content string, not that metadata.
  JSON *object* text is returned by direct `fs.command`, a background start,
  `fs.job` status/list/cancel or a timed-out `wait`, while
  `fs.ps({ format: "json" })` returns a JSON *array*. A completed
  `fs.job({ wait: true })` returns the original tool's content instead (its
  plain text, or that tool's own JSON). Every other tool returns plain text.
- Empty stdout means empty content. Many mutating tools succeed silently, for
  example `cp`, `mv`, `rm`, `touch`, `chmod`, `truncate`, `sed -i`, archive
  writes, and `fs.job wait` for them. Verify the effect with `fs.stat`,
  `fs.ls`, `fs.hash`, or `fs.diff`; do not read empty content as failure.
- Binary or NUL output is returned as **base64** when stdout contains a NUL byte
  in its first 8 KiB, with `metadata.encoding: "base64"`. That covers compressed
  data and NUL modes such as `fs.find({ print0: true })`,
  `fs.sort({ zeroTerminated: true })`, and `fs.shuf({ zeroTerminated: true })`.
  Prefer newline output; a pipe's final content is always decoded as UTF-8.
- `ERROR: ...` is a recoverable failure (`ERROR: Not found`, `ERROR: Invalid
  <tool> input: ...`, `ERROR: Unknown pipe stage: ...`); `BLOCKED: ...` is a
  sandbox hard stop. Both carry a stable `code` in metadata. Domain errors
  resolve as text; permission denials and host validation can reject the call
  instead.
- Exit code 1 is a normal result for `fs.grep` with no match, `fs.diff` with
  differences, `fs.mountpoint` on a non-mount, and `fs.pgrep` with no match.
  Do not retry those as failures.
- `fs.command` (direct call) content is JSON text for an object with `command`,
  `args`, `exitCode`, `signal`, `timedOut`, `aborted`, `sandboxBlocked`, `violations`,
  `network`, `networkMode`, `networkHosts`, `externalPaths`, `stdout`, and
  `stderr`, plus `networkReason` only when networking was disabled and `hint`
  when the sandbox blocked it. A non-zero exit is still a normal result. As a
  pipe stage it emits raw stdout instead.
- `fs.mktemp` prints the created path; `fs.ps`/`fs.pgrep` output is text, and
  `fs.ps({ format: "json" })` returns JSON text.

## Verification

Use `fs.stat`, `fs.ls`, `fs.hash`, `fs.cat`, or `fs.diff` to confirm the result.
Do not verify with a shell command. Report the tool result or the verified state,
such as `copied: 1`, `found: 2`, or `differences: true`.
