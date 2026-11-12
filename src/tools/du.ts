/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { num, walk } from "../core/fsutil.js";
import { humanSize } from "../core/format.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Paths to measure. Default: ['.']." })),
    summarize: Type.Optional(Type.Boolean({ description: "Only print a total per argument (`-s`)." })),
    all: Type.Optional(Type.Boolean({ description: "Print every file, not just directories (`-a`)." })),
    human: Type.Optional(Type.Boolean({ description: "Human-readable sizes (`-h`)." })),
    total: Type.Optional(Type.Boolean({ description: "Print a grand total (`-c`)." })),
    maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum recursion depth (`-d`)." })),
    follow: Type.Optional(Type.Boolean({ description: "Follow symlinks (`-L`)." })),
    oneFileSystem: Type.Optional(Type.Boolean({ description: "Stay on the starting filesystem (`-x`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface Row {
  path: string;
  bytes: number;
}

export const duTool: ToolSpec<Input> = {
  name: "du",
  description:
    "Estimate file and directory space usage with Linux `du` semantics (`-s`, `-a`, `-h`, `-c`, " +
    "`-d`, `-L`, `-x`). Hard links are counted once.",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const paths = input.paths ?? ["."];
    const rows: Row[] = [];
    let grand = 0;
    for (const requested of paths) {
      const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      await ctx.permission.assert([{ target, boundary: target.full }]);
      const rootStats = input.follow === true
        ? await ctx.sandbox.stat(target.full, requested)
        : await ctx.sandbox.lstat(target.full, requested);
      const rootDev = num(rootStats.dev);
      const seen = new Set<string>();
      let total = usage(rootStats, seen);
      const local: Row[] = [];
      if (input.all === true && !rootStats.isDirectory()) {
        local.push({ path: requested, bytes: total });
      }
      if (rootStats.isDirectory()) {
        for await (const entry of walk(target.full, {
          recursive: true,
          followSymlinks: input.follow === true,
          ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
          includeHidden: true,
          signal: ctx.signal,
        })) {
          /* v8 ignore next */
          if (input.oneFileSystem === true && num(entry.stats.dev) !== rootDev) continue;
          const bytes = usage(entry.stats, seen);
          total += bytes;
          if (input.all === true || entry.stats.isDirectory()) {
            local.push({ path: entry.path, bytes });
          }
        }
      }
      if (!rootStats.isDirectory()) {
        rows.push({ path: requested, bytes: total });
      } else if (input.summarize === true) {
        rows.push({ path: requested, bytes: total });
      } else {
        rows.push(...local, { path: requested, bytes: total });
      }
      grand += total;
    }
    if (input.total === true) rows.push({ path: "total", bytes: grand });
    const text = rows
      .map((row) => `${input.human === true ? humanSize(row.bytes) : String(Math.ceil(row.bytes / 1024))}\t${row.path}`)
      .join("\n");
    return textResult(text.length > 0 ? `${text}\n` : "", { total: grand });
  },
};

function usage(stats: Awaited<ReturnType<typeof fs.lstat>>, seen: Set<string>): number {
  if (!stats.isDirectory() && num(stats.nlink) > 1) {
    const key = `${num(stats.dev)}:${num(stats.ino)}`;
    /* v8 ignore next */
    if (seen.has(key)) return 0;
    seen.add(key);
  }
  return num(stats.blocks) * 512;
}
