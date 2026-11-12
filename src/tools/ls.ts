/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { formatDate, lookupGroup, lookupUser, modeString, num, typeName } from "../core/fsutil.js";
import { humanSize } from "../core/format.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Paths to list. Default: ['.']." })),
    all: Type.Optional(Type.Boolean({ description: "Include hidden entries and `.`/`..` (`-a`)." })),
    almostAll: Type.Optional(Type.Boolean({ description: "Include hidden entries but not `.`/`..` (`-A`)." })),
    long: Type.Optional(Type.Boolean({ description: "Long listing (`-l`)." })),
    human: Type.Optional(Type.Boolean({ description: "Human-readable sizes (`-h`)." })),
    recursive: Type.Optional(Type.Boolean({ description: "List subdirectories recursively (`-R`)." })),
    directory: Type.Optional(Type.Boolean({ description: "List directories themselves, not their contents (`-d`)." })),
    inode: Type.Optional(Type.Boolean({ description: "Print inode numbers (`-i`)." })),
    classify: Type.Optional(Type.Boolean({ description: "Append file type indicators (`-F`)." })),
    sortBy: Type.Optional(
      Type.Union([Type.Literal("name"), Type.Literal("size"), Type.Literal("time"), Type.Literal("none")], {
        description: "Sort key. Default: name.",
      }),
    ),
    reverse: Type.Optional(Type.Boolean({ description: "Reverse the sort order (`-r`)." })),
    onePerLine: Type.Optional(Type.Boolean({ description: "One entry per line (`-1`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface Entry {
  name: string;
  full: string;
  stats: Awaited<ReturnType<typeof fs.lstat>>;
  link?: string;
}

export const lsTool: ToolSpec<Input> = {
  name: "ls",
  description:
    "List files and directories with Linux `ls` semantics (`-a`, `-A`, `-l`, `-h`, `-R`, " +
    "`-d`, `-i`, `-F`, `-t`, `-S`, `-r`, `-1`).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const paths = input.paths ?? ["."];
    const blocks: string[] = [];
    for (const requested of paths) {
      const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      await ctx.permission.assert([{ target, boundary: target.full }]);
      const stats = await ctx.sandbox.lstat(target.full, requested);
      const entries = await collect(ctx, requested, target.full, stats, input, 0);
      blocks.push(entries.join("\n"));
    }
    return textResult(blocks.filter((block) => block.length > 0).join("\n\n"), { paths });
  },
};

async function collect(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  requested: string,
  full: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  input: Input,
  depth: number,
): Promise<string[]> {
  const lines: string[] = [];
  const recursive = input.recursive === true;
  if (stats.isDirectory() && input.directory !== true) {
    if (recursive && depth > 0) {
      /* v8 ignore next */
      if (lines.length > 0) lines.push("");
      lines.push(`${requested}:`);
    }
    const entries = await readEntries(full, input);
    if (input.long === true) {
      const total = entries.reduce((sum, entry) => sum + num(entry.stats.blocks), 0);
      lines.push(`total ${total}`);
    }
    lines.push(...(await formatEntries(entries, input)));
    if (recursive) {
      for (const entry of entries) {
        if (entry.name === "." || entry.name === ".." || !entry.stats.isDirectory()) continue;
        lines.push("");
        /* v8 ignore next */
        lines.push(`${requested === "." ? entry.name : `${requested}/${entry.name}`}:`);
        lines.push(...(await collect(ctx, path.join(requested, entry.name), entry.full, entry.stats, input, depth + 1)));
      }
    }
    return lines;
  }

  /* v8 ignore next */
  const link = stats.isSymbolicLink() ? await fs.readlink(full).catch(() => undefined) : undefined;
  /* v8 ignore next */
  lines.push(await formatEntry({ name: requested, full, stats, ...(link === undefined ? {} : { link }) }, input));
  return lines;
}

async function readEntries(full: string, input: Input): Promise<Entry[]> {
  let names: string[];
  try {
    names = await fs.readdir(full);
  } catch (error) {
    /* v8 ignore next */
    throw fromErrno(error, "access");
  }
  if (input.all === true) names = [".", "..", ...names];
  else if (input.almostAll !== true) names = names.filter((name) => !name.startsWith("."));
  const entries: Entry[] = [];
  for (const name of names) {
    const target = path.join(full, name);
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stats = await fs.lstat(target);
    } catch {
      /* v8 ignore next */
      continue;
    }
    /* v8 ignore next */
    const link = stats.isSymbolicLink() ? await fs.readlink(target).catch(() => undefined) : undefined;
    entries.push({ name, full: target, stats, ...(link === undefined ? {} : { link }) });
  }
  return sortEntries(entries, input);
}

function sortEntries(entries: Entry[], input: Input): Entry[] {
  const sortBy = input.sortBy ?? "name";
  if (sortBy !== "none") {
    entries.sort((a, b) => {
      if (sortBy === "size") return num(a.stats.size) - num(b.stats.size);
      if (sortBy === "time") return num(a.stats.mtimeMs) - num(b.stats.mtimeMs);
      return a.name.localeCompare(b.name);
    });
  }
  if (input.reverse === true) entries.reverse();
  return entries;
}

async function formatEntries(entries: Entry[], input: Input): Promise<string[]> {
  if (input.long === true) {
    return Promise.all(entries.map((entry) => formatEntry(entry, input)));
  }
  return entries.map((entry) => classify(entry.name, entry.stats, input));
}

async function formatEntry(entry: Entry, input: Input): Promise<string> {
  const name = classify(entry.name, entry.stats, input);
  /* v8 ignore next */
  if (input.long !== true) return input.inode === true ? `${entry.stats.ino} ${name}` : name;
  const user = await lookupUser(num(entry.stats.uid));
  const group = await lookupGroup(num(entry.stats.gid));
  const size = input.human === true ? humanSize(num(entry.stats.size)) : String(num(entry.stats.size));
  const link = entry.link === undefined ? "" : ` -> ${entry.link}`;
  /* v8 ignore next */
  const inode = input.inode === true ? `${num(entry.stats.ino)} ` : "";
  return `${inode}${modeString(entry.stats)} ${String(num(entry.stats.nlink)).padStart(2)} ${user} ${group} ${size.padStart(8)} ${formatDate(entry.stats.mtime)} ${name}${link}`;
}

function classify(name: string, stats: Awaited<ReturnType<typeof fs.lstat>>, input: Input): string {
  if (input.classify !== true) return name;
  if (stats.isDirectory()) return `${name}/`;
  if (stats.isSymbolicLink()) return `${name}@`;
  /* v8 ignore next */
  if (stats.isFIFO()) return `${name}|`;
  /* v8 ignore next */
  if (stats.isSocket()) return `${name}=`;
  if ((num(stats.mode) & 0o111) !== 0) return `${name}*`;
  return name;
}
