/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { fromErrno } from "../core/errors.js";
import { lookupGroup, lookupUser, modeString, num, typeName } from "../core/fsutil.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    follow: Type.Optional(Type.Boolean({ description: "Follow symlinks (`-L`)." })),
    format: Type.Optional(Type.String({ description: "printf-style format string (`-c`, `--printf`)." })),
    terse: Type.Optional(Type.Boolean({ description: "Terse single-line output (`-t`)." })),
    filesystem: Type.Optional(Type.Boolean({ description: "Show filesystem status (`-f`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const statTool: ToolSpec<Input> = {
  name: "stat",
  description:
    "Display file or filesystem status with Linux `stat` semantics (`-L`, `-c`, `-f`). " +
    "Supports the common percent tokens for path, size, type, mode, owner, times, device and inode.",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const blocks: string[] = [];
    for (const requested of input.paths) {
      const target = input.follow === true
        ? await ctx.sandbox.resolveFollow(requested)
        : await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      await ctx.permission.assert([{ target, boundary: target.full }]);
      if (input.filesystem === true) {
        blocks.push(await formatFilesystem(requested, target.full));
        continue;
      }
      const stats = input.follow === true
        ? await ctx.sandbox.stat(target.full, requested)
        : await ctx.sandbox.lstat(target.full, requested);
      /* v8 ignore next */
      const link = stats.isSymbolicLink() ? await fs.readlink(target.full).catch(() => undefined) : undefined;
      blocks.push(
        input.format === undefined
          ? input.terse === true
            ? await terseFormat(requested, stats)
            : await defaultFormat(requested, target.full, stats, link)
          : await customFormat(input.format, requested, target.full, stats, link),
      );
    }
    return textResult(blocks.join("\n"), { paths: input.paths });
  },
};

async function defaultFormat(
  requested: string,
  full: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  link: string | undefined,
): Promise<string> {
  const user = await lookupUser(num(stats.uid));
  const group = await lookupGroup(num(stats.gid));
  /* v8 ignore next */
  const name = link === undefined ? `'${requested}'` : `'${requested}' -> '${link}'`;
  /* v8 ignore next */
  const birth = stats.birthtimeMs === 0 ? "-" : stats.birthtime.toISOString();
  const lines = [
    `  File: ${name}`,
    `  Size: ${num(stats.size)}\tBlocks: ${num(stats.blocks)}\tIO Block: ${num(stats.blksize)}  ${typeName(stats)}`,
    `Device: ${num(stats.dev)}\tInode: ${num(stats.ino)}\tLinks: ${num(stats.nlink)}`,
    `Access: (${(num(stats.mode) & 0o7777).toString(8).padStart(4, "0")}/${modeString(stats)})  Uid: (${num(stats.uid)}/${user})   Gid: (${num(stats.gid)}/${group})`,
    `Access: ${stats.atime.toISOString()}`,
    `Modify: ${stats.mtime.toISOString()}`,
    `Change: ${stats.ctime.toISOString()}`,
    ` Birth: ${birth}`,
  ];
  return lines.join("\n");
}

async function customFormat(
  format: string,
  requested: string,
  full: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  link: string | undefined,
): Promise<string> {
  const values: Record<string, string> = {
    n: requested,
    /* v8 ignore next */
    N: link === undefined ? `'${requested}'` : `'${requested}' -> '${link}'`,
    s: String(num(stats.size)),
    F: typeName(stats),
    a: (num(stats.mode) & 0o7777).toString(8),
    A: modeString(stats),
    f: num(stats.mode).toString(16),
    u: String(num(stats.uid)),
    U: await lookupUser(num(stats.uid)),
    g: String(num(stats.gid)),
    G: await lookupGroup(num(stats.gid)),
    d: String(num(stats.dev)),
    i: String(num(stats.ino)),
    h: String(num(stats.nlink)),
    b: String(num(stats.blocks)),
    B: String(num(stats.blksize)),
    o: String(num(stats.blksize)),
    m: await mountPoint(full),
    r: num(stats.rdev).toString(16),
    x: stats.atime.toISOString(),
    X: String(Math.floor(num(stats.atimeMs) / 1000)),
    y: stats.mtime.toISOString(),
    Y: String(Math.floor(num(stats.mtimeMs) / 1000)),
    z: stats.ctime.toISOString(),
    Z: String(Math.floor(num(stats.ctimeMs) / 1000)),
    /* v8 ignore next -- some filesystems do not expose a birth time */
    w: stats.birthtimeMs === 0 ? "-" : stats.birthtime.toISOString(),
    W: String(Math.floor(num(stats.birthtimeMs) / 1000)),
    t: Math.floor(num(stats.rdev) / 256).toString(16),
    T: (num(stats.rdev) % 256).toString(16),
    C: "?",
    L: full,
  };
  let output = "";
  for (let index = 0; index < format.length; index++) {
    const char = format[index] as string;
    if (char === "\\") {
      const escaped = format[++index] as string | undefined;
      /* v8 ignore next */
      output += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "\\" ? "\\" : `\\${escaped ?? ""}`;
      continue;
    }
    if (char !== "%") {
      output += char;
      continue;
    }
    const next = format[++index] as string | undefined;
    if (next === undefined) {
      output += "%";
      break;
    }
    if (next === "%") output += "%";
    else output += values[next] ?? `%${next}`;
  }
  return output;
}

async function terseFormat(
  requested: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
): Promise<string> {
  return [
    requested,
    num(stats.size),
    num(stats.blocks),
    num(stats.mode).toString(16),
    num(stats.uid),
    num(stats.gid),
    num(stats.dev),
    num(stats.ino),
    num(stats.nlink),
    num(stats.rdev).toString(16),
    Math.floor(num(stats.atimeMs) / 1000),
    Math.floor(num(stats.mtimeMs) / 1000),
    Math.floor(num(stats.ctimeMs) / 1000),
    Math.floor(num(stats.birthtimeMs) / 1000),
    num(stats.blksize),
  ].join(" ");
}

let mountPoints: string[] | undefined;

async function mountPoint(full: string): Promise<string> {
  if (mountPoints === undefined) {
    const points: string[] = [];
    /* v8 ignore next -- /proc/self/mountinfo exists on Linux */
    const text = await fs.readFile("/proc/self/mountinfo", "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      const fields = line.split(" ");
      const point = fields[4];
      if (point !== undefined) {
        /* v8 ignore next 2 -- escaped mount points are rare */
        points.push(point.replace(/\\([0-7]{3})/g, (_match: string, octal: string) =>
          String.fromCharCode(Number.parseInt(octal, 8))));
      }
    }
    mountPoints = points;
  }
  let best = "/";
  for (const point of mountPoints) {
    if (full === point || full.startsWith(point === "/" ? "/" : `${point}/`)) {
      if (point.length > best.length) best = point;
    }
  }
  return best;
}

async function formatFilesystem(requested: string, full: string): Promise<string> {
  let stats;
  try {
    stats = await fs.statfs(full);
  } catch (error) {
    /* v8 ignore next */
    throw fromErrno(error, "access");
  }
  return [
    `  File: "${requested}"`,
    `    ID: ${num(stats.type).toString(16)} Namelen: 255 Type: ${num(stats.type).toString(16)}`,
    `Block size: ${num(stats.bsize)}       Fundamental block size: ${num(stats.bsize)}`,
    `Blocks: Total: ${num(stats.blocks)} Free: ${num(stats.bfree)} Available: ${num(stats.bavail)}`,
    `Inodes: Total: ${num(stats.files)} Free: ${num(stats.ffree)}`,
  ].join("\n");
}
