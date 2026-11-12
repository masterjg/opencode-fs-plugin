/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import picomatch from "picomatch";
import { Type, type Static } from "@sinclair/typebox";
import { FsError } from "../core/errors.js";
import { num, walk } from "../core/fsutil.js";
import { parseSize } from "../core/format.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Starting paths. Default: ['.']." })),
    name: Type.Optional(Type.String({ description: "Filename glob (`-name`)." })),
    iname: Type.Optional(Type.String({ description: "Case-insensitive filename glob (`-iname`)." })),
    pathPattern: Type.Optional(Type.String({ description: "Path glob (`-path`)." })),
    type: Type.Optional(
      Type.Union([Type.Literal("f"), Type.Literal("d"), Type.Literal("l"), Type.Literal("p"), Type.Literal("s")], {
        description: "Entry type (`-type`).",
      }),
    ),
    size: Type.Optional(Type.String({ description: "Size expression, e.g. +10k or -1M (`-size`)." })),
    mtime: Type.Optional(Type.String({ description: "Modification age in days, e.g. +7 (`-mtime`)." })),
    mmin: Type.Optional(Type.String({ description: "Modification age in minutes (`-mmin`)." })),
    maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum depth (`-maxdepth`)." })),
    minDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Minimum depth (`-mindepth`)." })),
    empty: Type.Optional(Type.Boolean({ description: "Empty files or directories (`-empty`)." })),
    perm: Type.Optional(Type.String({ description: "Octal permission mode (`-perm`)." })),
    newer: Type.Optional(Type.String({ description: "Only entries newer than this file (`-newer`)." })),
    follow: Type.Optional(Type.Boolean({ description: "Follow symlinks (`-L`)." })),
    print0: Type.Optional(Type.Boolean({ description: "NUL-separated output (`-print0`)." })),
    sort: Type.Optional(Type.Boolean({ description: "Sort results lexically. Default: true." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const findTool: ToolSpec<Input> = {
  name: "find",
  description:
    "Find entries with a Linux-like predicate subset: `-name`, `-iname`, `-path`, `-type`, " +
    "`-size`, `-mtime`, `-mmin`, `-maxdepth`, `-mindepth`, `-empty`, `-perm`, `-newer`, `-L`, `-print0`.",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const paths = input.paths ?? ["."];
    const newer = input.newer === undefined
      ? undefined
      : num((await ctx.sandbox.lstat((await ctx.sandbox.resolveExisting(input.newer, { allowRoot: true })).full, input.newer)).mtimeMs);
    const nameMatch = input.name === undefined
      ? undefined
      : picomatch(input.name, { dot: true });
    const inameMatch = input.iname === undefined
      ? undefined
      : picomatch(input.iname, { dot: true, nocase: true });
    const pathMatch = input.pathPattern === undefined
      ? undefined
      : picomatch(input.pathPattern, { dot: true });
    const results: string[] = [];

    for (const requested of paths) {
      const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      await ctx.permission.assert([{ target, boundary: target.full }]);
      const rootStats = input.follow === true
        ? await ctx.sandbox.stat(target.full, requested)
        : await ctx.sandbox.lstat(target.full, requested);
      if (!rootStats.isDirectory()) {
        if (await matches(requested, target.full, rootStats, input, { nameMatch, inameMatch, pathMatch, newer })) {
          results.push(requested);
        }
        continue;
      }
      if (input.maxDepth === 0) {
        if (await matches(requested, target.full, rootStats, input, { nameMatch, inameMatch, pathMatch, newer })) {
          results.push(requested);
        }
        continue;
      }
      for await (const entry of walk(target.full, {
        recursive: true,
        followSymlinks: input.follow === true,
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        includeHidden: true,
        signal: ctx.signal,
      })) {
        const relative = path.relative(target.full, entry.path).split(path.sep).length;
        if (input.minDepth !== undefined && relative < input.minDepth) continue;
        if (await matches(entry.path, entry.path, entry.stats, input, { nameMatch, inameMatch, pathMatch, newer })) {
          results.push(entry.path);
        }
      }
    }
    if (input.sort !== false) results.sort((a, b) => a.localeCompare(b));
    const separator = input.print0 === true ? "\0" : "\n";
    const text = results.length === 0 ? "" : results.join(separator) + separator;
    return textResult(text, { found: results.length });
  },
};

async function matches(
  display: string,
  full: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  input: Input,
  patterns: {
    nameMatch?: ((value: string) => boolean) | undefined;
    inameMatch?: ((value: string) => boolean) | undefined;
    pathMatch?: ((value: string) => boolean) | undefined;
    newer?: number | undefined;
  },
): Promise<boolean> {
  const base = path.basename(full);
  if (patterns.nameMatch !== undefined && !patterns.nameMatch(base)) return false;
  if (patterns.inameMatch !== undefined && !patterns.inameMatch(base)) return false;
  if (patterns.pathMatch !== undefined && !patterns.pathMatch(full)) return false;
  if (input.type !== undefined && typeOf(stats) !== input.type) return false;
  if (input.size !== undefined) {
    const sign = input.size.startsWith("+") ? 1 : input.size.startsWith("-") ? -1 : 0;
    const body = sign === 0 ? input.size : input.size.slice(1);
    const size = parseSize(body);
    if (sign === 1 && stats.size <= size) return false;
    if (sign === -1 && stats.size >= size) return false;
    if (sign === 0 && stats.size !== size) return false;
  }
  if (input.mtime !== undefined) {
    const age = (Date.now() - num(stats.mtimeMs)) / 86_400_000;
    if (!ageMatches(age, input.mtime)) return false;
  }
  if (input.mmin !== undefined) {
    const age = (Date.now() - num(stats.mtimeMs)) / 60_000;
    if (!ageMatches(age, input.mmin)) return false;
  }
  if (input.empty === true) {
    if (stats.isDirectory()) {
      if ((await fs.readdir(full)).length > 0) return false;
    } else if (num(stats.size) !== 0) return false;
  }
  if (input.perm !== undefined && (num(stats.mode) & 0o7777) !== Number.parseInt(input.perm, 8)) return false;
  if (patterns.newer !== undefined && num(stats.mtimeMs) <= patterns.newer) return false;
  void display;
  return true;
}

function ageMatches(age: number, expression: string): boolean {
  if (expression.startsWith("+")) return age > Number(expression.slice(1));
  if (expression.startsWith("-")) return age < Number(expression.slice(1));
  return Math.floor(age) === Number(expression);
}

function typeOf(stats: Awaited<ReturnType<typeof fs.lstat>>): string {
  if (stats.isDirectory()) return "d";
  if (stats.isSymbolicLink()) return "l";
  if (stats.isFIFO()) return "p";
  if (stats.isSocket()) return "s";
  return "f";
}

void FsError;
