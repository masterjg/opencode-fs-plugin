# opencode-fs-plugin

An OpenCode 2 plugin that adds a Linux-style filesystem and text toolkit under
the `fs` namespace. It is a maintained fork of
[`kiu345/opencode-fs-plugin`](https://github.com/kiu345/opencode-fs-plugin),
rewritten with async I/O, permission integration, a symlink-aware sandbox, and
unit, end-to-end and coverage tests.

## Tools

| Native command | Tool | Main options |
|---|---|---|
| `mkdir` | `fs.mkdir` | `parents`, `mode`, `verbose` |
| `rmdir` | `fs.rmdir` | `parents`, `ignoreNonEmpty`, `verbose` |
| `rm` | `fs.rm` | `recursive`, `force`, `dir`, `verbose` |
| `cp` | `fs.cp` | `recursive`, `archive`, `force`, `noClobber`, `update`, `preserve`, `dereference`, `verbose` |
| `mv` | `fs.mv` | `force`, `noClobber`, `update`, `verbose` |
| `ls` | `fs.ls` | `all`, `almostAll`, `long`, `human`, `recursive`, `directory`, `inode`, `classify`, `size`, `numericIds`, `noGroup`, `noOwner`, `slash`, `quote`, `versionSort`, `extensionSort`, `fullTime`, `timeStyle`, `hide`, `ignore`, `groupDirectoriesFirst`, `sortBy`, `reverse`, `onePerLine` |
| `stat` | `fs.stat` | `follow`, `format`, `terse`, `filesystem` |
| `touch` | `fs.touch` | `accessOnly`, `modifyOnly`, `noCreate`, `date`, `timestamp`, `reference`, `noDereference` |
| `truncate` | `fs.truncate` | `size`, `reference`, `noCreate`, `noDereference` |
| `ln` | `fs.ln` | `symbolic`, `force`, `noDereference`, `relative`, `verbose` |
| `readlink` | `fs.readlink` | `mode` (`raw`, `canonical`, `existing`, `missing`), `noNewline` |
| `chmod` | `fs.chmod` | octal/symbolic mode, `reference`, `recursive`, `noDereference`, `verbose`, `changes`, `silent` |
| `sha256sum`/`md5sum` | `fs.hash` | `algorithm`, `tag`; hashes files or stdin |
| `du` | `fs.du` | `summarize`, `all`, `human`, `total`, `maxDepth`, `follow`, `oneFileSystem` |
| `df` | `fs.df` | `human`, `inodes`, `printType`, `all` |
| `find` | `fs.find` | `name`, `iname`, `pathPattern`, `lname`, `ilname`, `regex`, `iregex`, `type`, `size`, `mtime`, `mmin`, `maxDepth`, `minDepth`, `empty`, `perm`, `uid`, `gid`, `user`, `group`, `links`, `inum`, `samefile`, `fstype`, `newer`, `newerXY`, `printf`, `follow`, `print0`, `sort` |
| `cat` | `fs.cat` | `number`, `numberNonBlank`, `squeezeBlank`, `showEnds`, `showTabs`, `showNonPrinting` |
| `head` | `fs.head` | `lines`, `bytes`, `quiet`, `verbose` |
| `tail` | `fs.tail` | `lines`, `bytes`, `fromStart`, `quiet`, `verbose`, `follow`, `timeoutMs`, `intervalMs`, `maxBytes` |
| `tee` | `fs.tee` | `append`, `content` |
| `wc` | `fs.wc` | `lines`, `words`, `bytes`, `chars`, `maxLineLength` |
| `sort` | `fs.sort` | `numeric`, `generalNumeric`, `humanNumeric`, `version`, `reverse`, `unique`, `ignoreCase`, `dictionary`, `ignoreNonPrinting`, `ignoreLeadingBlanks`, `stable`, `check`, `checkQuiet`, `zeroTerminated`, `keys`, `field`, `separator` |
| `uniq` | `fs.uniq` | `count`, `repeated`, `uniqueOnly`, `ignoreCase`, `skipFields`, `skipChars` |
| `cut` | `fs.cut` | `fields`, `characters`, `bytes`, `delimiter`, `outputDelimiter`, `complement`, `onlyDelimited` |
| `tr` | `fs.tr` | `set1`, `set2`, `delete`, `squeeze`, `complement`; ranges and classes |
| `sed` | `fs.sed` | `script`, `expressions`, `inPlace`, `extendedRegexp`, `quiet`; `s///` subset |
| `grep` | `fs.grep` | `recursive`, `include`, `exclude`, `ignoreCase`, `invert`, `lineNumbers`, `withFilename`, `noFilename`, `filesWithMatches`, `filesWithoutMatch`, `count`, `onlyMatching`, `word`, `line`, `fixed`, `context`, `before`, `after`, `maxCount`, `noMessages` |
| `tar` | `fs.tar` | `create`/`extract`/`list`, `gzip`, `directory`, `stripComponents`, `exclude`, `verbose`, `input`, `member` |
| `zip` | `fs.zip` | `archive`, `paths`, `level`, `input`, `member` |
| `unzip` | `fs.unzip` | `extract`/`list`, `directory`, `overwrite`, `noOverwrite` |
| `gzip` | `fs.gzip` | `keep`, `force`, `stdout`, `level` |
| `gunzip` | `fs.gunzip` | `keep`, `force`, `stdout`, `suffix` |
| `mktemp` | `fs.mktemp` | `template`, `directory`, `tmpdir`, `suffix` |
| `trash` | `fs.trash` | XDG home trash |
| `diff` | `fs.diff` | `unified`, `brief`, `recursive`, `ignoreWhitespace`, `ignoreCase`, `exclude` |
| shell pipe | `fs.pipe` | `stages`, `input`, `output`, `append` |

## Pipe

`fs.pipe` joins registered tools through byte buffers. Stages run in order;
only pipeable tools can be used. `output` and `append` behave like a final
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

There is no shell, redirection operator, nested pipe, or `find -exec`.

## Background jobs

Every `fs.*` tool accepts `background: true`. The call returns immediately with
a job id and a status-file path:

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
status files may remain under `/tmp/opencode/fs-jobs/<server-pid>/`. The manager
allows 8 concurrent jobs and cleans up finished jobs after one hour. Results
stay in memory and are returned by `fs.job`; the status file contains only the
job state and metadata. Background permission prompts can appear after the
starting call returns, and a denied permission fails the job.

## Installing from npm

Add the registry package directly to the plugin list:

```jsonc
{
  "plugins": ["opencode-fs-plugin@1.2.0"]
}
```

`opencode plugin add opencode-fs-plugin@1.2.0` installs it and writes the config
entry. A bare `opencode-fs-plugin` follows the `latest` tag.

OpenCode manages the package under its cache, so the path is not stable. If you
also want the packaged skill, install it into a project instead:

```bash
npm install opencode-fs-plugin@1.2.0
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
VERSION=1.2.0
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
  "plugins": ["github:masterjg/opencode-fs-plugin#v1.2.0"]
}
```

`opencode plugin add 'github:masterjg/opencode-fs-plugin#v1.2.0'` installs the
same spec and writes the config entry. The equivalent full URL is
`git+https://github.com/masterjg/opencode-fs-plugin.git#v1.2.0`. A tag is
checked for updates; use a full commit hash to pin it.

Git plugins are installed under OpenCode's cache, so their package path is not
stable. If you also want the packaged skill, install with npm instead:

```bash
npm install "github:masterjg/opencode-fs-plugin#v1.2.0"
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
`fs_pipe` stages, and so on). Internal paths use project-relative resources;
external targets first require `external_directory` on the absolute boundary.
`allow always` persists the same patterns as the built-in tools.

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
- Paths are resolved with symlink awareness. Traversing a link that escapes the
  project requires `external_directory`; removing or renaming the link itself is
  internal.
- Archive extraction rejects absolute paths, `..`, and escaping symlinks.
- `rm` is permanent. `trash` uses the XDG home trash and refuses cross-device
  moves instead of silently copying.
- The sandbox is a guardrail, not a kernel security boundary. Symlink races
  remain possible.

## Development

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
