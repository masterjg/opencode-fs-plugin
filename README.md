# opencode-fs-plugin

An OpenCode 2 plugin that adds a Linux-style filesystem, text, and HTTP(S)
toolkit under the `fs` namespace. It is a maintained fork of
[`kiu345/opencode-fs-plugin`](https://github.com/kiu345/opencode-fs-plugin),
rewritten with async I/O, permission integration, a symlink-aware sandbox, and
unit, end-to-end and coverage tests.

## Tools

| Native command | Tool | Main options |
|---|---|---|
| `ar` | `fs.ar` | `create`/`list`/`extract`, `directory`, `members` |
| `base64` | `fs.base64` | `decode`, `wrap`, `ignoreGarbage` |
| `cat` | `fs.cat` | `number`, `numberNonBlank`, `squeezeBlank`, `showEnds`, `showTabs`, `showNonPrinting` |
| `chmod` | `fs.chmod` | octal/symbolic mode, `reference`, `recursive`, `noDereference`, `verbose`, `changes`, `silent` |
| `chown` | `fs.chown` | `user`/`uid`, `group`/`gid`, `recursive`, `noDereference` |
| `comm` | `fs.comm` | `suppress1`/`2`/`3`, `outputDelimiter` |
| `command` | `fs.command` | `command`, `args`, `cwd`, `stdin`, `timeoutMs`; `fs_command` permission, procage sandbox, no shell |
| `cp` | `fs.cp` | `recursive`, `archive`, `force`, `noClobber`, `update`, `preserve`, `dereference`, `verbose` |
| `cpio` | `fs.cpio` | `create`/`list`/`extract` (newc), `directory`, `members`, `input`, `member`, `verbose` |
| `curl` | `fs.curl` | `url`, `method`, `headers`, `body`, `json`, `output`, `checksum`, `maxBytes`, `timeoutMs`, `failOnError`, `followRedirects`, `maxRedirects` |
| `cut` | `fs.cut` | `fields`, `characters`, `bytes`, `delimiter`, `outputDelimiter`, `complement`, `onlyDelimited` |
| `date` | `fs.date` | `value`, `utc`, `format` (`iso`, `unix`, `rfc`, `date`) |
| `dd` | `fs.dd` | `input`, `output`, `blockSize`, `count`, `skip`, `seek`, `status` |
| `df` | `fs.df` | `human`, `inodes`, `printType`, `all` |
| `diff` | `fs.diff` | `unified`, `brief`, `recursive`, `ignoreWhitespace`, `ignoreCase`, `exclude` |
| `du` | `fs.du` | `summarize`, `all`, `human`, `total`, `maxDepth`, `follow`, `oneFileSystem` |
| `file` | `fs.file` | `paths`, `mime`; content magic detection |
| `find` | `fs.find` | `name`, `iname`, `pathPattern`, `lname`, `ilname`, `regex`, `iregex`, `type`, `size`, `mtime`, `mmin`, `maxDepth`, `minDepth`, `empty`, `perm`, `uid`, `gid`, `user`, `group`, `links`, `inum`, `samefile`, `fstype`, `newer`, `newerXY`, `printf`, `follow`, `print0`, `sort`, `action` (`print`/`delete`/`trash`), `recursive` |
| `findmnt` | `fs.findmnt` | `paths`, `fsType`, `noHeader` |
| `fold` | `fs.fold` | `width`, `spaces` |
| `grep` | `fs.grep` | `recursive`, `include`, `exclude`, `ignoreCase`, `invert`, `lineNumbers`, `withFilename`, `noFilename`, `filesWithMatches`, `filesWithoutMatch`, `count`, `onlyMatching`, `word`, `line`, `fixed`, `context`, `before`, `after`, `maxCount`, `noMessages` |
| `gunzip` | `fs.gunzip` | `keep`, `force`, `stdout`, `suffix` |
| `gzip` | `fs.gzip` | `keep`, `force`, `stdout`, `level` |
| `sha256sum`/`md5sum` | `fs.hash` | `algorithm`, `tag`; hashes files or stdin |
| `head` | `fs.head` | `lines`, `skip`, `bytes`, `quiet`, `verbose` |
| `id` | `fs.id` | `only` (`user`, `group`, `groups`) |
| `kill` | `fs.kill` | `pids`, `signal`, `dryRun`; pid 0/1 and groups rejected |
| `ln` | `fs.ln` | `symbolic`, `force`, `noDereference`, `relative`, `verbose` |
| `ls` | `fs.ls` | `all`, `almostAll`, `long`, `human`, `recursive`, `directory`, `inode`, `classify`, `size`, `numericIds`, `noGroup`, `noOwner`, `slash`, `quote`, `versionSort`, `extensionSort`, `fullTime`, `timeStyle`, `hide`, `ignore`, `groupDirectoriesFirst`, `sortBy`, `reverse`, `onePerLine` |
| `mkdir` | `fs.mkdir` | `parents`, `mode`, `verbose` |
| `mktemp` | `fs.mktemp` | `template`, `directory`, `tmpdir`, `suffix` |
| `mountpoint` | `fs.mountpoint` | `paths`, `quiet` |
| `mv` | `fs.mv` | `force`, `noClobber`, `update`, `verbose` |
| `nl` | `fs.nl` | `all`, `start`, `width`, `separator` |
| `od` | `fs.od` | `offset`, `length`, `width` |
| `paste` | `fs.paste` | `delimiters`, `serial` |
| `pgrep` | `fs.pgrep` | `pattern`, `full`, `ignoreCase`, `user`, `newest`, `oldest`, `count`, `delimiter` |
| `ps` | `fs.ps` | `pids`, `user`, `command`, `sortBy`, `limit`, `noHeader`, `format` |
| `readlink` | `fs.readlink` | `mode` (`raw`, `canonical`, `existing`, `missing`), `noNewline` |
| `rev` | `fs.rev` | reverse characters per line |
| `rm` | `fs.rm` | `recursive`, `force`, `dir`, `verbose` |
| `rmdir` | `fs.rmdir` | `parents`, `ignoreNonEmpty`, `verbose` |
| `sed` | `fs.sed` | `script`, `expressions`, `inPlace`, `extendedRegexp`, `quiet`; `s///` subset |
| `shuf` | `fs.shuf` | `headCount`, `zeroTerminated` |
| `sort` | `fs.sort` | `numeric`, `generalNumeric`, `humanNumeric`, `version`, `reverse`, `unique`, `ignoreCase`, `dictionary`, `ignoreNonPrinting`, `ignoreLeadingBlanks`, `stable`, `check`, `checkQuiet`, `zeroTerminated`, `keys`, `field`, `separator` |
| `split` | `fs.split` | `lines`/`bytes`, `prefix`, `suffixLength`, `numeric`, `additionalSuffix` |
| `stat` | `fs.stat` | `follow`, `format`, `terse`, `filesystem` |
| `strings` | `fs.strings` | `minLength` |
| `sync` | `fs.sync` | `paths`; file/directory fsync |
| `tac` | `fs.tac` | reverse lines |
| `tail` | `fs.tail` | `lines`, `bytes`, `fromStart`, `quiet`, `verbose`, `follow`, `timeoutMs`, `intervalMs`, `maxBytes` |
| `tar` | `fs.tar` | `create`/`extract`/`list`, `gzip`, `directory`, `stripComponents`, `exclude`, `verbose`, `input`, `member` |
| `tee` | `fs.tee` | `append`, `content` |
| `touch` | `fs.touch` | `accessOnly`, `modifyOnly`, `noCreate`, `date`, `timestamp`, `reference`, `noDereference` |
| `tr` | `fs.tr` | `set1`, `set2`, `delete`, `squeeze`, `complement`; ranges and classes |
| `trash` | `fs.trash` | XDG home trash |
| `truncate` | `fs.truncate` | `size`, `reference`, `noCreate`, `noDereference` |
| `uname` | `fs.uname` | `kernel`, `nodename`, `release`, `version`, `machine` |
| `uniq` | `fs.uniq` | `count`, `repeated`, `uniqueOnly`, `ignoreCase`, `skipFields`, `skipChars` |
| `unzip` | `fs.unzip` | `extract`/`list`, `directory`, `overwrite`, `noOverwrite` |
| `uptime` | `fs.uptime` | `pretty`, `loadAverage` |
| `wc` | `fs.wc` | `lines`, `words`, `bytes`, `chars`, `maxLineLength` |
| `zip` | `fs.zip` | `archive`, `paths`, `level`, `input`, `member` |

`fs.job` and `fs.pipe` are support tools rather than shell replacements:

| Purpose | Tool | Main options |
|---|---|---|
| Background jobs | `fs.job` | `id`, `wait`, `cancel`, `list`, `timeoutMs` |
| Sequential byte pipeline | `fs.pipe` | `stages`, `input`, `output`, `append` |

`fs.head.skip` selects line ranges (`sed -n '20,40p'`). `fs.find` can
`action: "delete"` or `"trash"` its matches; the starting directory itself is
never removed, and the `fs_rm`/`fs_trash` permissions are asserted.

Canonical field names are listed above. Aliases are accepted only where noted:
`path` for one `paths` element (`stat`, `ls`, `cat`, `find`, `tee`, `grep`,
`sed`), `source` for `sources` (`cp`, `mv`, `ln`), `expression` for
`expressions` (`sed`), and `limit` for `maxCount` (`grep`). `fs.mkdir` accepts
`paths` beside `path`, and `fs.hash` accepts `paths`/`path` beside `files`.
Prefer the canonical names.

## Pipe

`fs.pipe` joins registered tools through byte buffers. Stages run in order;
only pipeable tools can be used. Each stage asserts its own `fs_<tool>` action
before it runs, so a disabled stage cannot be hidden inside a pipe. `output` and
`append` behave like a final
`tee`.

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

Filter stages: `base64`, `command`, `fold`, `nl`, `od`, `paste`, `rev`, `shuf`, `tac`,
and `strings`; `dd` and `cpio` are source/sink stages like `tar`.

`fs.curl` is a pipe source, so network data can feed the same stages:

```js
await tools.fs.pipe({
  stages: [
    { tool: "curl", args: { url: "https://example.com/app.log" } },
    { tool: "grep", args: { pattern: "ERROR" } },
  ],
})
```

Pipe stages exchange whole buffers, so use `maxBytes` for large responses. For
large downloads prefer `fs.curl({ output })`, which streams to disk. A stage
that yields no stdout becomes an empty buffer, so `output` writes an empty file
instead of skipping it. The signal is checked before each stage and before the
final write, so an abort stops the chain without creating the output.

There is no shell, redirection operator, nested pipe, or arbitrary `find -exec`.

`fs.pipe` is sequential by design and is not a batch primitive. For independent
work, fan out with `Promise.all` over `tools.fs.*` (or one multi-path call).
`fs` domain errors resolve as `ERROR:`/`BLOCKED:` text; permission denials throw.

## Command

`fs.command` runs one executable inside a procage sandbox with
`shell: false`. It is closest to the shell's `command <prog>`: one program with
literal argv, not `exec` (which replaces the calling shell) and not `sh -c`
(which parses shell syntax). The executable allowlist is the `fs_command`
permission: the tool asserts that action with the bare executable name as its
resource. Deny `*` to close the set, then allow the names you need:

```jsonc
{
  "permissions": [
    { "action": "fs_command", "resource": "*", "effect": "deny" },
    { "action": "fs_command", "resource": "npm", "effect": "allow" },
    { "action": "fs_command", "resource": "uv", "effect": "allow" }
  ]
}
```

With no rule the base allow applies to every executable, so keep the `*` deny
when you want a closed set.

The workspace (project) is read/write/exec. **Network egress needs Linux tier
T1** (user namespaces and TPROXY). Every run gets procage's transparent relay:
there is no direct route, and every TCP or UDP flow is named to the plugin as a
DNS QNAME, TLS SNI, HTTP `Host`, QUIC SNI, or an IP literal. Bare IPv6 literals
and bracketed IPv6 `Host` forms with an optional port are accepted as
resources. That exact resource must be approved through `fs_command_network`; the
port, URL, headers, and payload are never part of the permission. There is no
separate network allowlist option:

```jsonc
{
  "permissions": [
    { "action": "fs_command_network", "resource": "*", "effect": "deny" },
    { "action": "fs_command_network", "resource": "registry.npmjs.org", "effect": "allow" },
    { "action": "fs_command_network", "resource": "pypi.org", "effect": "allow" }
  ]
}
```

A flow asks with its own resource. With no rule (base allow) the request is
approved silently; with a `*` deny an unlisted resource fails closed. DNS
queries are flows too: an allowed QNAME is answered through the parent resolver
(procage reads `/etc/resolv.conf` and systemd-resolved paths, including a
loopback stub), a denied one gets `REFUSED`, and TCP/853 or a known
encrypted-DNS endpoint is refused without asking. That DoH filtering is
best-effort: TCP/853 and the finite list of known DoH names are blocked, but
custom or unknown DoH endpoints on other names or ports may not be recognized.
ECH detected in TLS or QUIC is visibly refused. Allowed answers feed a
bounded per-run address-to-name cache: a later flow that names no host is
authorized by a fresh allowed name bound to its address, otherwise by the
address itself. A named flow must either match an allowed DNS answer for the
exact `(name, address)` pair or have both its name and its address allowed; a
denied named identity is never rescued by an allowed address. Allow the DNS
names a program uses. Also allow an address when the program connects to IP
literals, or when a named flow's name is allowed but that exact
`(name, address)` was not returned by an allowed DNS answer: only the cached
pair avoids the separate address check, so that named flow needs both
permissions.

External proxy settings are preserved: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
`NO_PROXY`, their lowercase forms, and the npm proxy variables are passed to the
child explicitly, because they are not in the preset's environment allowlist.
The relay treats the proxy as the destination, never its `CONNECT` target, so
an external proxy works only when `fs_command_network` allows the proxy's address
(or its cached DNS name, which also needs its DNS query allowed). That approval
lets the proxy forward to whatever it reaches; it is not scoped to the target
URL behind the proxy. No other caller environment variable is forwarded
explicitly, but the preset's own environment allowlist still applies, and a
proxy variable may itself carry proxy credentials.

External paths are separate: a blocked path asks `external_directory` for its
containing directory (or the nearest existing ancestor), and the sandbox grants
read/write there. Only procage's structured **write** violations (`file-write-*`)
can trigger that auto-approval; read, exec, network, or unknown path failures
never do. When procage reports no write violation, no path grant is inferred and
access remains denied — pre-grant the path with `external_directory` or a rule.
A path printed by the child on stdout or stderr is reported, never auto-approved.

The decision comes from your `opencode.jsonc` rules (`ask`, `allow`, `deny`), the
same as every other tool. If a path stays blocked after approval, the result
reports `violations` and a `hint`. `fs.command` also kills every process it started
when the run ends, including detached descendants.

On Linux T2 and on macOS the relay is unavailable, and a relay control server
that cannot start is treated the same way. `fs.command` retries the same run once
with networking off: the policy stays `net: "none"`, no resolver sockets are
granted, and macOS gets no resolver exception. The result carries
`networkMode: "disabled"` and a `networkReason`; there is no direct-IP fallback. Every flow decision is
fail-closed: a denial, a closed control link, an oversized or malformed frame,
a missing HELLO, or a decision timeout refuses the flow. The control socket
lives in a private per-run directory and is never part of the child's known
Unix sockets.

```js
await tools.fs.command({ command: "npm", args: ["install"], timeoutMs: 300000 })
```

`command` is a bare name, `args` are literal, and `cwd` is sandboxed. Direct
calls return JSON with `exitCode`, `stdout`, `stderr`, `violations`, and the
network fields `network`, `networkMode`, `networkHosts`, and `networkReason`
(when networking was disabled); `externalPaths` lists the external roots the
run could write to. A pipe stage returns raw stdout so it composes with `grep`,
`sort`, `tee`, and the rest.

```js
await tools.fs.pipe({
  stages: [
    { tool: "command", args: { command: "npm", args: ["test"] } },
    { tool: "grep", args: { pattern: "FAIL" } },
  ],
})
```

The command asserts `fs_command`, returns stdout/stderr in full, and treats a non-zero exit as
a normal result. Procage requires Linux x64/arm64, glibc 2.28+, and Node 22.12+.
On kernels before Landlock ABI 6, signal isolation relaxes to same-user. The
trust-handoff class is waived so package tools can update workspace files such as
`.git/hooks`; the `fs_command` permission remains the trust boundary.

## Performance and concurrency

All I/O is asynchronous; the plugin never calls a synchronous `fs` API.

The concurrency limit defaults to `os.availableParallelism()`. Override it with
the plugin option `concurrency` or the `OPENCODE_FS_CONCURRENCY` environment
variable (the option wins). It bounds every parallel path, so a large tree cannot
start unbounded work:

- `cp`/`mv` tree copies
- `hash`, `gzip`, and `gunzip` over multiple files
- `grep` file reads
- `find`, `du`, `grep -r`, and `chmod -R` traversal, including directory
  recursion and per-entry stats
- `diff -r` file comparisons
- `ls` long-format rendering

`gzip`/`gunzip` also use the libuv thread pool for compression; raise
`UV_THREADPOOL_SIZE` if compression dominates.

CPU-bound JavaScript stages (`sort`, `sed`, `diff` text patching) stay
single-threaded. Splitting them would need worker threads and is a deliberate
gap; their input/output cost is dominated by the async I/O above.

## Background jobs

Every tool except `fs.job` accepts `background: true`. The call returns
immediately with a job id and a status-file path:

```js
const started = JSON.parse(
  await tools.fs.cp({
    sources: ["large-tree"],
    destination: "backup",
    recursive: true,
    background: true,
  }),
)
```

Wait for it with `fs.job`, or let the agent continue and check later:

```js
const result = await tools.fs.job({
  id: started.jobId,
  wait: true,
  timeoutMs: 600000,
})
```

`fs.job` also supports `status`, `cancel`, and `list`:

```js
await tools.fs.job({ id: started.jobId })              // current status
await tools.fs.job({ id: started.jobId, cancel: true }) // abort
await tools.fs.job({ list: true })                     // newest first
```

The status file lets the `wait` plugin observe a job without coupling the two
plugins:

```js
await tools.wait.for({
  condition: {
    type: "file_contains",
    path: started.statusPath,
    pattern: '"state":"completed"',
  },
  timeoutMs: 600000,
})
```

Jobs are process-local: they are lost on an OpenCode server restart, and their
status files may remain under `/tmp/opencode/fs-jobs/<server-pid>/`; set the
plugin option `jobDir` to move them. The limits are global to one plugin
instance (one OpenCode server), not per session: at most 8 jobs run at once and
up to 64 are retained. Starting another evicts the oldest finished job and
deletes its status file; if no finished job is available to evict the start
fails with `busy`. Finished jobs are also cleaned up after one hour.

Each job is visible only to the session that started it: `fs.job` list, status,
wait, and cancel treat another session's id as not found. A background start or
`fs.job` call without a non-empty host session id fails with `invalid`. The
`jobDir` path is validated component by component: an existing symlink, a
non-directory component, or the filesystem root is refused, missing components
are created `0700`, and the final directory is `0700`. This is deliberately
fail-closed: a benign configured path that traverses a host symlink such as
`/home` is rejected, while the default `/tmp/opencode/fs-jobs/<pid>` path is
unaffected. A component swapped after validation remains a residual TOCTOU
race. Status files are `0600` and hold only id, tool, state, timing, and
`hasResult`; they omit the result, the raw error, and the absolute status path.
Results stay in memory and are returned by
`fs.job`, capped at 1 MiB per result. Longer text is truncated with
a `[truncated]` marker plus `truncated`/`originalBytes` metadata,
and an oversized base64/binary result becomes empty content. With 64 retained
results this can hold roughly 64 MiB of result text in the server process until
eviction. Background permission prompts can appear after the starting call
returns, and a denied permission fails the job.

## Installing from npm

Add the registry package directly to the plugin list:

```jsonc
{
  "plugins": ["opencode-fs-plugin@<version>"]
}
```

`opencode plugin add opencode-fs-plugin@<version>` installs it and writes the config
entry. A bare `opencode-fs-plugin` follows the `latest` tag.

OpenCode manages the package under its cache, so the path is not stable. If you
also want the packaged skill, install it into a project instead:

```bash
npm install opencode-fs-plugin@<version>
```

```jsonc
{
  "plugins": ["./node_modules/opencode-fs-plugin"],
  "skills": ["./node_modules/opencode-fs-plugin/skills"]
}
```

## Installing from a release

Download the release tarball, then install it as a normal npm package:

```bash
VERSION=<version>
curl -L -o "opencode-fs-plugin-${VERSION}.tgz" \
  "https://github.com/masterjg/opencode-fs-plugin/releases/download/v${VERSION}/opencode-fs-plugin-${VERSION}.tgz"
npm install "./opencode-fs-plugin-${VERSION}.tgz"
```

Point OpenCode at the installed directory:

```jsonc
{
  "plugins": ["./node_modules/opencode-fs-plugin"]
}
```

Relative paths resolve from the config file that contains them, so use an
absolute path in the global config. The tarball contains `src/`, `skills/`,
`SPEC.md` and `INSTALL.md`; npm installs its runtime dependencies. Do not unpack
it by hand.

OpenCode does not accept the release asset URL or a `.tgz` file directly in
`plugins`; install it with npm first and point at the installed directory.

## Installing from a Git tag

Every release is tagged `v<version>`. Add the tag directly to the plugin list;
OpenCode installs it from Git:

```jsonc
{
  "plugins": ["github:masterjg/opencode-fs-plugin#v<version>"]
}
```

`opencode plugin add 'github:masterjg/opencode-fs-plugin#v<version>'` installs the
same spec and writes the config entry. The equivalent full URL is
`git+https://github.com/masterjg/opencode-fs-plugin.git#v<version>`. A tag is
checked for updates; use a full commit hash to pin it.

Git plugins are installed under OpenCode's cache, so their package path is not
stable. If you also want the packaged skill, install with npm instead:

```bash
npm install "github:masterjg/opencode-fs-plugin#v<version>"
```

Then use `./node_modules/opencode-fs-plugin` in `plugins` and
`./node_modules/opencode-fs-plugin/skills` in `skills`.

## Loading from a checkout

```jsonc
{
  "plugins": [
    "./repos/opencode-fs-plugin"
  ]
}
```

The plugin exports TypeScript source directly and targets Node 22+.

## Skill discovery

The plugin ships `skills/filesystem/SKILL.md`. OpenCode does not search inside a
plugin package automatically, so register the directory once:

```jsonc
{
  "skills": [
    "~/.config/opencode/repos/opencode-fs-plugin/skills"
  ]
}
```

If the plugin was installed from the release tarball, the npm registry, or with
`npm install` from a Git tag into a project's `node_modules`, point at the
packaged skill instead:

```jsonc
{
  "skills": [
    "./node_modules/opencode-fs-plugin/skills"
  ]
}
```

Relative skill paths resolve from the active working directory, not the config
file; use an absolute path for a global install. Alternatively, symlink
`skills/filesystem` into `~/.config/opencode/skills`; OpenCode discovers that
directory automatically. See [INSTALL.md](INSTALL.md) for all options,
verification, and an agent-ready installation prompt.

The skill ID is `filesystem`; `@filesystem` loads it explicitly.

## Permissions

Every tool asserts an action named after the tool (`fs_cp`, `fs_rm`,
`fs_pipe` stages, and so on), except `fs.curl`, which reuses the
built-in `webfetch` action. Internal paths use project-relative resources;
external targets first require `external_directory` on the absolute boundary,
computed from the canonical target rather than the symlink path.
`allow always` saves the exact resources the call asserted — project-relative
paths, absolute external boundaries, or network names/addresses. A specific
resource saves narrowly; an explicitly requested `*` remains `*`.

`fs.command` asserts `fs_command` with the executable name, asks
`external_directory` for any blocked path, and asks `fs_command_network` for the
exact DNS name or IP address the transparent relay named. There is no `*`
fallback and no direct-IP mode; networking that cannot use the relay is
disabled:

```jsonc
{
  "permissions": [
    { "action": "fs_command", "resource": "*", "effect": "deny" },
    { "action": "fs_command", "resource": "npm", "effect": "allow" },
    { "action": "external_directory", "resource": "$HOME/.npm/**", "effect": "ask" },
    { "action": "fs_command_network", "resource": "*", "effect": "deny" },
    { "action": "fs_command_network", "resource": "registry.npmjs.org", "effect": "allow" }
  ]
}
```

Keep the rules explicit. Plugin actions match OpenCode's base
`{ "action": "*", "resource": "*", "effect": "allow" }` rule, so an unlisted
`fs_command`, `fs_command_network`, or `external_directory` resource is allowed
without a prompt, not asked.

`fs.curl` reuses the built-in `webfetch` permission, with the requested
URL as the resource, so one rule set covers both tools:

```jsonc
{
  "permissions": [
    { "action": "webfetch", "resource": "*", "effect": "deny" },
    { "action": "webfetch", "resource": "https://api.github.com/*", "effect": "allow" }
  ]
}
```

Redirects re-assert the rule against each new URL.

Agent rules can use wildcards:

```jsonc
{
  "permissions": [
    { "action": "fs_*", "resource": "*", "effect": "deny" }
  ]
}
```

To direct agents to this toolkit instead of the built-in shell, deny `shell`:

```jsonc
{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "deny" }
  ]
}
```

This removes the built-in shell tool; MCP servers and other tools that run
commands are unaffected. Apply it globally or under `agents.<id>.permissions`
when only some agents should be shell-free.

## Safety

- The sandbox root, its ancestors, `/`, `$HOME` and core system directories are
  hard stops for destructive operations.
- Paths resolve to their canonical target before a permission is asserted, so a
  symlink that escapes the project asks `external_directory` for the real
  location; removing or renaming the link itself stays internal. Single-file
  output tools (archives, `gzip`, `tee`, `split`, `dd`, `pipe`) open the resolved
  final component with `O_NOFOLLOW`, so a link swapped in after the check fails
  instead of being followed; `cp` refuses an existing symlink at a nested entry
  but its final copy call is not no-follow. Node has no `openat`, so a
  concurrently swapped parent directory remains a TOCTOU gap.
- `cp` follows a top-level destination symlink to its canonical target and gates
  that path. Inside a recursive copy it refuses to write through an existing
  symlink (directory or file) and fails closed; a copied symlink replaces the
  destination link itself. A source/destination hard-link alias is rejected.
- `mv` refuses to move a directory into itself. A cross-device move (EXDEV)
  refuses a destination symlink, copies with `preserve`, and removes the source
  only after every entry was copied. If nothing was copied or a
  `noClobber`/`update` entry was skipped, it reports `cross-device` and preserves
  the source; the partially populated destination is left in place.
- `chown` refuses the sandbox root, its ancestors, `/`, `$HOME`, and core system
  directories before asserting permission or changing ownership; recursive chown
  skips traversal symlinks. With `noDereference` it resolves the parent chain to
  its canonical directory but leaves the final component, so a parent symlink is
  gated at its real location and `lchown` changes a final symlink itself.
- Archive create writes its output through the same no-follow final open.
  Extraction first plans every member: destinations are resolved in their
  canonical parents, an existing final symlink is refused, and one bulk
  permission check covers all targets before anything is written, so a denial
  writes no archive members. A symlink member is refused over any existing
  destination, and absolute names, `..`, and absolute or traversing link targets
  are rejected. Extracted file modes apply the process umask and strip
  setuid/setgid; directory modes also preserve the sticky bit. ZIP entries with
  no Unix mode default to `0644` files and `0755` directories before the umask.
  Directory modes are deduplicated by canonical target (last entry wins) and
  applied deepest-first. Ordinary file and directory mode changes use opened
  `O_NOFOLLOW` handles; an `EACCES` fallback for an unreadable existing
  directory uses a guarded pathname `chmod`, keeping a final-component TOCTOU
  race. Parent-component races remain. An abort before an archive create write
  leaves no archive file. A parent directory swapped after planning can still redirect a
  write, an existing destination hardlink can be written through, and an OS
  error or abort can leave earlier members or a truncated file. Archive create
  and extraction buffer the whole archive (extraction also buffers each member)
  in memory and have no global archive-size cap, so large archives can consume
  substantial memory.
- `tar` and `cpio` create resolve relative `paths` under `directory`; absolute
  sources are named relative to `directory` first, then the project, and fall
  back to the basename (a traversing source uses its basename). `tar`/`zip` store
  files, directories, and symlinks (no hardlinks, devices, ACLs, or xattrs);
  `cpio` is newc with GNU 4-byte padding, and its decoder also accepts the prior
  3.x plugin padding; strict decode rejects nonzero data after the trailer
  (concatenated archives). `cpio` fields must fit 0..0xffffffff; `ar` uses 16-byte
  GNU short names.
- `split` checks suffix capacity before writing: alphabetic suffixes cover
  `26^suffixLength` chunks and `numeric` covers `10^suffixLength`; more chunks
  fail with `invalid`.
- `curl` accepts only `http:` and `https:`, keeps TLS verification on, and
  re-checks permissions on every redirect hop. A same-origin redirect keeps the
  request. A cross-origin redirect is refused unless it is a bodyless `GET` or
  `HEAD` whose caller headers are all in the safe set (`accept`,
  `accept-language`, `cache-control`, `pragma`, `range`, `user-agent`);
  credentials, custom headers, other methods, a request body, and embedded URL
  credentials are refused, not stripped. A 303 rewrites `POST` to a bodyless
  `GET` before that policy, so a safe resulting GET may cross origins; 301/302
  rewrite `POST` after the policy, and 307/308 keep the method and body. An
  HTTPS to HTTP redirect is always refused. For `output`, the resolved file's
  containing directory is the permission boundary, so an external destination
  asks `external_directory` for that directory. Downloads stream to a temporary
  file and are renamed only after the body and checksum complete. Localhost and
  private addresses are not blocked by default.
- `rm` is permanent. `trash` uses the XDG home trash and refuses cross-device
  moves instead of silently copying.
- The sandbox is a guardrail, not a kernel security boundary.
  Parent/hardlink races and partial writes remain possible.

## Development

See [AGENTS.md](AGENTS.md) for the engineering rules: async-only I/O,
core-count concurrency, and where every independent operation must be
parallelized.

```bash
npm install
npm run typecheck
npm test
npm run coverage
```

`npm run coverage` enforces 100% statements, branches, functions and lines.
A small number of OS-error branches are marked with `/* v8 ignore next */` when
they cannot be produced deterministically; all tool logic and normal error
paths are exercised.

## Releases

Every push to `main` runs `.github/workflows/release.yml`. It reads the version
from `package.json`, runs typecheck and the 100% coverage gate, packs the npm
tarball, uploads it as a workflow artifact, publishes it to npm with provenance
when the version is new, and creates a GitHub release tagged `v<version>` when
that release does not exist yet. Bump the version in `package.json` to publish a
new release; an unchanged version is skipped with a notice.

The npm step uses trusted publishing (OIDC); no npm token is stored. The
package's trusted publisher must authorize workflow `release.yml` in
`masterjg/opencode-fs-plugin`. Keep **Allow npm publish** enabled on that
connection: the workflow uses `npm publish`, not `npm stage publish`, so
releases publish directly without per-version approval.

## License

EPL-2.0. The original project and this fork remain under the same license.
