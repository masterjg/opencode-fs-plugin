/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import picomatch from "picomatch";
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
    size: Type.Optional(Type.Boolean({ description: "Print allocated block counts (`-s`)." })),
    numericIds: Type.Optional(Type.Boolean({ description: "Use numeric uid/gid and long format (`-n`)." })),
    noGroup: Type.Optional(Type.Boolean({ description: "Long format without group (`-g`)." })),
    noOwner: Type.Optional(Type.Boolean({ description: "Long format without owner (`-o`)." })),
    slash: Type.Optional(Type.Boolean({ description: "Append `/` to directories (`-p`)." })),
    quote: Type.Optional(Type.Boolean({ description: "Quote names with C-style escapes (`-Q`)." })),
    versionSort: Type.Optional(Type.Boolean({ description: "Natural version sort (`-v`)." })),
    extensionSort: Type.Optional(Type.Boolean({ description: "Sort by extension (`-X`)." })),
    fullTime: Type.Optional(Type.Boolean({ description: "Full ISO timestamps (`--full-time`)." })),
    timeStyle: Type.Optional(
      Type.Union(
        [Type.Literal("full-iso"), Type.Literal("long-iso"), Type.Literal("iso"), Type.Literal("locale")],
        { description: "Timestamp style (`--time-style`)." },
      ),
    ),
    hide: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Hide matching names (`--hide`)." })),
    ignore: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Ignore matching names (`--ignore`)." })),
    groupDirectoriesFirst: Type.Optional(Type.Boolean({ description: "List directories before files (`--group-directories-first`)." })),
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
    "`-d`, `-i`, `-F`, `-t`, `-S`, `-r`, `-1`, `-s`, `-n`, `-g`, `-o`, `-p`, `-Q`, `-v`, `-X`, " +
    "`--time-style`, `--hide`, `--ignore`, `--group-directories-first`).",
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
  const hidden = input.hide?.map((pattern) => picomatch(pattern, { dot: true }));
  const ignored = input.ignore?.map((pattern) => picomatch(pattern, { dot: true }));
  names = names.filter((name) =>
    hidden?.some((match) => match(name)) !== true &&
    ignored?.some((match) => match(name)) !== true);
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
  if (sortBy !== "none" || input.versionSort === true || input.extensionSort === true) {
    entries.sort((a, b) => {
      if (input.extensionSort === true) {
        const extension = path.extname(a.name).localeCompare(path.extname(b.name));
        if (extension !== 0) return extension;
      } else if (input.versionSort === true) {
        return versionCompare(a.name, b.name);
      } else if (sortBy === "size") {
        return num(a.stats.size) - num(b.stats.size);
      } else if (sortBy === "time") {
        return num(a.stats.mtimeMs) - num(b.stats.mtimeMs);
      }
      return a.name.localeCompare(b.name);
    });
  }
  if (input.reverse === true) entries.reverse();
  if (input.groupDirectoriesFirst === true) {
    entries.sort((a, b) => Number(b.stats.isDirectory()) - Number(a.stats.isDirectory()));
  }
  return entries;
}

function versionCompare(left: string, right: string): number {
  /* v8 ignore next -- ls entry names are never empty */
  const leftParts = left.match(/\d+|\D+/g) ?? [];
  /* v8 ignore next -- ls entry names are never empty */
  const rightParts = right.match(/\d+|\D+/g) ?? [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const a = leftParts[index];
    const b = rightParts[index];
    /* v8 ignore next */
    if (a === undefined) return -1;
    /* v8 ignore next */
    if (b === undefined) return 1;
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference;
    } else {
      const result = a.localeCompare(b);
      if (result !== 0) return result;
    }
  }
  /* v8 ignore next -- distinct entry names cannot compare fully equal */
  return 0;
}

async function formatEntries(entries: Entry[], input: Input): Promise<string[]> {
  return Promise.all(entries.map((entry) => formatEntry(entry, input)));
}

async function formatEntry(entry: Entry, input: Input): Promise<string> {
  const name = displayName(entry.name, entry.stats, input);
  const long = input.long === true || input.numericIds === true || input.noOwner === true || input.noGroup === true;
  /* v8 ignore next */
  if (!long) {
    const inode = input.inode === true ? `${num(entry.stats.ino)} ` : "";
    const blocks = input.size === true ? `${blockSize(entry.stats, input)} ` : "";
    return `${inode}${blocks}${name}`;
  }

  const user = input.numericIds === true ? String(num(entry.stats.uid)) : await lookupUser(num(entry.stats.uid));
  const group = input.numericIds === true ? String(num(entry.stats.gid)) : await lookupGroup(num(entry.stats.gid));
  const size = input.human === true ? humanSize(num(entry.stats.size)) : String(num(entry.stats.size));
  const link = entry.link === undefined ? "" : ` -> ${entry.link}`;
  const parts: string[] = [];
  if (input.size === true) parts.push(blockSize(entry.stats, input));
  /* v8 ignore next */
  if (input.inode === true) parts.push(String(num(entry.stats.ino)));
  parts.push(modeString(entry.stats), String(num(entry.stats.nlink)).padStart(2));
  if (input.noOwner !== true) parts.push(user);
  if (input.noGroup !== true) parts.push(group);
  parts.push(size.padStart(8), formatTime(entry.stats.mtime, input));
  return `${parts.join(" ")} ${name}${link}`;
}

function blockSize(stats: Awaited<ReturnType<typeof fs.lstat>>, input: Input): string {
  return input.human === true
    ? humanSize(num(stats.blocks) * 512)
    : String(Math.ceil(num(stats.blocks) / 2));
}

function formatTime(date: Date, input: Input): string {
  if (input.fullTime === true || input.timeStyle === "full-iso") {
    const iso = date.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000000 +0000`;
  }
  if (input.timeStyle === "long-iso") return date.toISOString().slice(0, 16).replace("T", " ");
  if (input.timeStyle === "iso") {
    const iso = date.toISOString();
    return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  }
  return formatDate(date);
}

function displayName(name: string, stats: Awaited<ReturnType<typeof fs.lstat>>, input: Input): string {
  const quoted = input.quote === true ? JSON.stringify(name) : name;
  const classified = classify(quoted, stats, input);
  if (input.slash === true && stats.isDirectory() && !classified.endsWith("/")) return `${classified}/`;
  return classified;
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
