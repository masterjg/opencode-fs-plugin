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
| `ls` | `fs.ls` | `all`, `almostAll`, `long`, `human`, `recursive`, `directory`, `inode`, `classify`, `sortBy`, `reverse`, `onePerLine` |
| `stat` | `fs.stat` | `follow`, `format`, `filesystem` |
| `touch` | `fs.touch` | `accessOnly`, `modifyOnly`, `noCreate`, `date`, `timestamp`, `reference`, `noDereference` |
| `truncate` | `fs.truncate` | `size`, `reference`, `noCreate`, `noDereference` |
| `ln` | `fs.ln` | `symbolic`, `force`, `noDereference`, `relative`, `verbose` |
| `readlink` | `fs.readlink` | `mode` (`raw`, `canonical`, `existing`, `missing`), `noNewline` |
| `chmod` | `fs.chmod` | octal/symbolic mode, `reference`, `recursive`, `noDereference`, `verbose`, `changes`, `silent` |
| `sha256sum`/`md5sum` | `fs.hash` | `algorithm`, `tag`; hashes files or stdin |
| `du` | `fs.du` | `summarize`, `all`, `human`, `total`, `maxDepth`, `follow`, `oneFileSystem` |
| `df` | `fs.df` | `human`, `inodes`, `printType`, `all` |
| `find` | `fs.find` | `name`, `iname`, `pathPattern`, `type`, `size`, `mtime`, `mmin`, `maxDepth`, `minDepth`, `empty`, `perm`, `newer`, `follow`, `print0`, `sort` |
| `cat` | `fs.cat` | `number`, `numberNonBlank`, `squeezeBlank`, `showEnds`, `showTabs`, `showNonPrinting` |
| `head` | `fs.head` | `lines`, `bytes`, `quiet`, `verbose` |
| `tail` | `fs.tail` | `lines`, `bytes`, `fromStart`, `quiet`, `verbose` |
| `tee` | `fs.tee` | `append`, `content` |
| `wc` | `fs.wc` | `lines`, `words`, `bytes`, `chars`, `maxLineLength` |
| `sort` | `fs.sort` | `numeric`, `reverse`, `unique`, `ignoreCase`, `ignoreLeadingBlanks`, `field`, `separator` |
| `uniq` | `fs.uniq` | `count`, `repeated`, `uniqueOnly`, `ignoreCase`, `skipFields`, `skipChars` |
| `cut` | `fs.cut` | `fields`, `characters`, `bytes`, `delimiter`, `outputDelimiter`, `complement`, `onlyDelimited` |
| `tr` | `fs.tr` | `set1`, `set2`, `delete`, `squeeze`, `complement`; ranges and classes |
| `sed` | `fs.sed` | `script`, `expressions`, `inPlace`, `extendedRegexp`, `quiet`; `s///` subset |
| `grep` | `fs.grep` | `recursive`, `include`, `exclude`, `ignoreCase`, `invert`, `lineNumbers`, `withFilename`, `noFilename`, `filesWithMatches`, `filesWithoutMatch`, `count`, `onlyMatching`, `word`, `line`, `fixed`, `context`, `before`, `after`, `maxCount`, `noMessages` |
| `tar` | `fs.tar` | `create`/`extract`/`list`, `gzip`, `directory`, `stripComponents`, `exclude`, `verbose` |
| `zip` | `fs.zip` | `archive`, `paths`, `level` |
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

## Loading

```jsonc
{
  "plugins": [
    "./repos/opencode-fs-plugin"
  ]
}
```

Packages can also be loaded by name or Git URL. The plugin exports TypeScript
source directly and targets Node 22+.

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

Alternatively, symlink `skills/filesystem` into `~/.config/opencode/skills`,
which OpenCode discovers automatically. See [INSTALL.md](INSTALL.md) for both
options, verification, and an agent-ready installation prompt.

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
tarball, uploads it as a workflow artifact, and creates a GitHub release tagged
`v<version>` when that release does not exist yet. Bump the version in
`package.json` to publish a new release; an unchanged version is skipped with a
notice.

## License

EPL-2.0. The original project and this fork remain under the same license.
