# Manual agent-selection checks

These checks verify that the Worker chooses `fs` tools instead of `shell` or
`toolbox` for ordinary filesystem work. They were run with:

```bash
opencode run --agent worker --model opencode-go/deepseek-v4.1-flash \
  --format json --auto "<task>"
```

| Task | Observed `fs` tools | Shell/toolbox |
|---|---|---|
| Copy, stat, sort, long list | `fs.cp`, `fs.stat`, `fs.sort`, `fs.ls` | none |
| Pipe `cat -> grep` to a file | `fs.pipe` (`cat`, `grep`) | none |
| Touch, chmod, symlink, readlink, hash, du, df | `fs.touch`, `fs.chmod`, `fs.ln`, `fs.readlink`, `fs.hash`, `fs.du`, `fs.df`, `fs.ls`, `fs.stat` | none |
| Tar, gzip/gunzip, zip/unzip, diff | `fs.tar`, `fs.gzip`, `fs.gunzip`, `fs.zip`, `fs.unzip`, `fs.diff`, `fs.mkdir` | none |
| Find, mktemp, cp, mv, trash, rmdir | `fs.find`, `fs.mktemp`, `fs.cp`, `fs.mv`, `fs.trash`, `fs.rmdir` | none |
| Head, tail, wc, tr, cut, sed, uniq, tee | `fs.head`, `fs.tail`, `fs.wc`, `fs.tr`, `fs.cut`, `fs.sed`, `fs.uniq`, `fs.pipe`/`fs.tee` | none |
| Grep, rm, rmdir | `fs.grep`, `fs.rm`, `fs.rmdir` | none |

The only non-`fs` tool used was the built-in `read` for final content
verification. That is intentional: built-ins remain preferred for ordinary text
reads.

The skill was loaded in the pipe and archive checks without being named, which
confirms the `filesystem` description is wide enough to match. The first copy
prompt exposed one UX issue: `fs.stat` and `fs.cp` take `paths`/`sources`
arrays, not a scalar `path`. The skill now records that gotcha.
