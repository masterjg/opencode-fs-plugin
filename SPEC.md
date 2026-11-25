# Compatibility specification

This fork targets Linux and Node 22+. Tool names follow native commands; option
fields follow the native long options. The model-facing tools are grouped under
the `fs` namespace (`tools.fs.cp`, direct `fs_cp`).

Aliases are accepted only where noted: `path` for one `paths` element (`stat`,
`ls`, `cat`, `find`, `tee`, `grep`, `sed`), `source` for `sources` (`cp`, `mv`,
`ln`), `expression` for `expressions` (`sed`), and `limit` for `maxCount`
(`grep`). `mkdir` accepts `paths` beside `path`, and `hash` accepts
`paths`/`path` beside `files`; the canonical names remain preferred.

## Principles

- Every tool is async and uses `fs/promises`; no synchronous filesystem calls.
- Independent I/O runs with bounded parallelism. The limit defaults to
  `os.availableParallelism()` and can be set with the plugin `concurrency`
  option or `OPENCODE_FS_CONCURRENCY`.
- Parallel paths: `cp`/`mv` trees, `hash`, `gzip`/`gunzip`, `grep` reads,
  `find`/`du`/`grep -r`/`chmod -R` traversal, `diff -r`, and `ls` formatting.
- CPU-bound JS (`sort`, `sed`, text diffing) stays single-threaded; worker
  threads are a deliberate gap.
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

## Batch 1 tools

- `ps`, `pgrep`, and `kill` read `/proc` and use `process.kill`; no process can
  be started or wrapped, so `nohup`, `setsid`, and `timeout` are out of scope.
- `kill` rejects pid 0, pid 1, and negative process groups.
- `file` reads the first 1 KiB and detects ELF, images, archives, compression,
  SQLite, wasm, text, and generic data.
- `base64` encodes with optional wrapping and validates decoded input; decoded
  bytes may be binary and are base64-encoded again by the renderer.
- `od` is an xxd-style hex/ASCII dump with offset, length, and width.
- `strings` extracts printable ASCII runs.
- `id`, `uname`, `uptime`, `date`, `findmnt`, and `mountpoint` read OS data;
  `findmnt` parses `/proc/self/mountinfo`.
- `tac`, `rev`, `nl`, `paste`, `comm`, `split`, `shuf`, and `fold` cover text
  primitives that `pipe` could not express. `comm` expects sorted input.
- `chown` uses `fs.chown`/`fs.lchown`, accepts names or ids, and walks
  recursively with the shared concurrency limit.
- `sync` calls `fsync` per path; Node has no global sync syscall.
- `dd` supports `bs`, `count`, `skip`, `seek`, and `status`; it does not
  implement conversions or `iflag`/`oflag`.
- `cpio` reads and writes newc archives; `ar` uses GNU short names (max 16 bytes).
  Both reject traversal and unsafe member names. Like `tar`, create resolves
  `paths` against the project; pass absolute sources plus `directory` for
  relative member names.

## HTTP requests

- `fs.http_request` supports `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `HEAD`
  over `http:`/`https:` only; other schemes fail with `unsupported`.
- Requests are allowed by default. `fs.http_request` asserts the built-in
  `webfetch` action with the requested URL as the resource; there is no separate
  `fs_http_request` action. Every redirect hop re-asserts it for the new URL.
- Redirects are followed manually: 301/302 rewrite `POST` to `GET`, 303 always
  does, and the hop count is bounded by `maxRedirects`.
- `output` streams the response to a temporary file in the target directory and
  renames it only after the body and checksum are complete.
- `checksum` accepts `<md5|sha1|sha256|sha512>:<hex>`; a bare digest means
  SHA-256. Mismatches fail with `checksum` and leave no partial file.
- `maxBytes` is enforced while reading, for buffered and downloaded bodies.
- Pipe use is a buffered source; whole bodies pass between stages.

## Process execution

- `fs.exec` is the only tool that starts processes, through `procage`; it never
  uses `child_process`, `spawn`, or a shell.
- `command` must be a bare executable name and must match the allowlist exactly.
  Default: `npm`, `npx`, `uv`, `uvx`, `pip`, `pip3`. Override with the plugin
  option `execAllowlist`; an empty list disables execution.
- The policy is procage `agent_workspace` v3: the project is read/write/exec.
  External paths are denied by default and there are no per-call grants.
- Network egress uses procage's transparent relay on Linux tier T1. A per-run
  `AF_UNIX` control server in a 0700 directory accepts exactly one connection,
  validates HELLO against the run id, and multiplexes at most 64 decisions over
  the length-prefixed protocol in `src/core/relay-protocol.ts`.
- Every TCP/UDP flow is named as a DNS QNAME, TLS SNI, HTTP `Host`, QUIC SNI, or
  IP literal. That exact resource is asserted with `fs_exec_network`; the port,
  protocol, URL, headers, and payload never reach the permission. The rules are
  the only allowlist; there is no plugin option for it.
- DNS queries are decisions too. An allowed QNAME is forwarded to the parent
  resolver; procage's discovery reads `/etc/resolv.conf` and systemd-resolved
  paths, including a loopback stub, and the plugin leaves `relay_dns_upstream`
  and `relay_resolv_conf` unset. A denied QNAME gets `REFUSED`. An allowed
  answer feeds procage's bounded per-run address-to-name cache. A nameless flow
  to an address is authorized by a fresh allowed name bound to it, else by the
  address. A named flow requires the exact `(name, address)` from an allowed
  answer plus the allowed name, or both name and address explicitly allowed; a
  denied named identity is never rescued by an allowed address. Allow an address
  in addition to the name when a program connects to an IP literal, or when a
  named flow's exact `(name, address)` was not returned by an allowed DNS
  answer. TCP/853 and the finite list of known DoH names are refused without
  asking; custom or unknown DoH endpoints on other names or ports may not be
  recognized, so DoH blocking is best-effort. ECH detected in TLS or QUIC is
  visibly refused.
- Denials, a closed control link, a failed handshake, an oversized or malformed
  frame, an exhausted in-flight window, and a decision timeout all refuse the
  flow. Completed decision ids are retained in a bounded 1024-entry window so a
  replay is rejected without unbounded memory. There is no direct-route
  fallback.
- On Linux T2 and macOS procage reports the `net-relay` gap; a relay control
  server that cannot start is treated the same way. The run retries once with
  networking off (`net: "none"`), no resolver sockets, and no macOS resolver
  exception, and reports `networkMode: "disabled"` plus `networkReason`.
- External proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
  `NO_PROXY`, lowercase forms, and npm proxy variables) are passed explicitly
  because they are not in the preset environment allowlist. The relay treats
  the proxy as the destination, never its `CONNECT` target, so the proxy's
  address or cached DNS name must be allowed in `fs_exec_network`. No other
  caller environment variable is forwarded explicitly; the preset's own
  allowlist still applies, and a proxy variable may itself carry credentials.
- Denied paths ask `external_directory` on their containing directory (or the
  nearest existing ancestor for a missing or redacted path) only when procage
  reports a structured **write** violation (`file-write-*`). Read, exec,
  network, and unknown operations never add a write rule; without a write
  violation no path grant is inferred and access stays denied — pre-grant the
  path or configure a rule. Child stdout/stderr is never parsed for paths.
  Access handling is bounded to twelve attempts.
- If a path or socket stays blocked after approval, the result reports
  `violations` plus a `hint`; stderr containing EACCES/EPERM/EROFS marks
  `sandboxBlocked`. Results carry `network`, `networkMode`, `networkHosts`,
  `networkReason` when the relay was unavailable, and `externalPaths`.
- `args` are passed verbatim. `cwd` resolves inside the sandbox and asserts
  `external_directory` when it leaves the project; the action is `fs_exec`.
- Timeout defaults to 120000 ms, capped at 600000. Procage ends the run and kills
  every process it started, including detached descendants; `timedOut: true`
  and exit code 124 are returned.
- Captured stdout/stderr are returned in full; the host's `tool_output` setting bounds what the model sees.
- Direct calls return JSON with `exitCode`, `stdout`, `stderr`, `violations`, and
  the sandbox decision. In `fs.pipe`, the stage returns raw stdout and composes as
  a source or filter.
- A non-zero exit is a normal result, not a tool error.
- `procage` is lazy-loaded; if the host cannot load it, `fs.exec` fails with
  `unsupported` while the other fs tools continue to work. Requires Linux
  x64/arm64, glibc 2.28+, and Node 22.12+. On kernels before Landlock ABI 6,
  signals are relaxed from self-and-children to same-user, as procage requires.
  The trust-handoff class is waived so package tools can update workspace files
  such as `.git/hooks`; the executable allowlist remains the trust boundary.

## Deliberate gaps

These are not implemented:

- `xz`, `zstd`, `7z`, `rar`
- `awk`, full `sed` command language, arbitrary `find -exec`; `find action` covers
  delete/trash only
- `chgrp`, `chattr`, `rsync`
- ACL and xattr preservation in `cp -a`
- remaining GNU edge-flag parity for `ls`, `stat`, `sort`, `find`
- symlink-race-proof sandboxing
- unbounded `tail -f`; use bounded `follow` or the wait plugin
- archive extraction from arbitrary streams; create accepts text/stdin stream input
- cross-filesystem `trash`; use `rm` or a mount-trash helper
- curl protocols beyond HTTP(S), cookie jars, client certificates, proxies,
  multipart uploads, and resumable/range downloads
- true streaming through pipe stages; `http_request` buffers unless `output` is set
- worker threads for CPU-bound stages (`sort`, `sed`, text diffing)
- parallel member reads inside a single `tar`/`zip` archive; member order is fixed
- process start beyond the allowlisted `exec` tool; `nohup`, `setsid`, and
  `timeout` wrappers are unavailable
- ICMP `ping` (raw sockets) and `ip`/netlink configuration
- `rsync`, `scp`, and other transfer protocols; use the SSH MCP for remote work
- ACLs, xattrs, and `chattr`/`lsattr`
- `jq`/`yq`
- `7z`, `rar`, `xz`, `zstd`, and `bzip2`; batch 2 may add pure-JS or native deps
- `fallocate`, `mkfifo`, `mknod`, `flock`, and mount operations

## Format details

- `stat` supports `%n %N %s %F %a %A %f %u %U %g %G %d %i %h %b %B %o %m %r
  %x %X %y %Y %z %Z %w %W %t %T %C %L`, plus `\n`, `\t`, `\\` and `%%`.
  `%C` returns `?` because Node does not expose the SELinux file context.
- `chmod` supports octal modes and symbolic `[ugoa]*[-+=][rwxXst]*` clauses.
- `find -size` accepts `c` (bytes), `w` (2-byte words), `b` (512-byte blocks),
  and binary `K`/`M`/`G`/... suffixes; `-mtime`/`-mmin` accept `+N` (older),
  `-N` (newer), and exact `N`. `newerXY` uses `XY:path`.
- `head skip` selects a line range: `skip: 19, lines: 21` is `sed -n '20,40p'`.
- `find action: "delete"|"trash"` reuses the `fs_rm`/`fs_trash` gates, removes
  deepest matches first, and never removes the starting directory itself.
- `sort -k` accepts field/character ranges with modifiers `bdfghiMnrV`.
- `tar`/`zip` extraction rejects path traversal and escaping links.
- `pipe` passes raw bytes and only accepts registered pipeable stages; `tar` and
  `zip` are sink stages. Each stage asserts its own `fs_<tool>` action before it
  runs, so per-tool denial also applies inside a pipe. It is sequential and not a
  batch primitive: independent
  calls fan out with `Promise.all` in `execute`.

## Coverage policy

`npm run coverage` enforces 100% on `src/**`. `/* v8 ignore next */` is used only
for OS-error branches that cannot be produced deterministically in the test
environment; those paths remain in the source and are still exercised by the
type checker and integration tests where possible.
