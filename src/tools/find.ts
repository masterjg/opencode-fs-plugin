/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import picomatch from "picomatch";
import { Type, type Static } from "@sinclair/typebox";
import { FsError } from "../core/errors.js";
import { lookupGroup, lookupUser, modeString, num, typeName, walkAll } from "../core/fsutil.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Starting paths. Default: ['.']." })),
    name: Type.Optional(Type.String({ description: "Filename glob (`-name`)." })),
    iname: Type.Optional(Type.String({ description: "Case-insensitive filename glob (`-iname`)." })),
    pathPattern: Type.Optional(Type.String({ description: "Path glob (`-path`)." })),
    lname: Type.Optional(Type.String({ description: "Symlink target glob (`-lname`)." })),
    ilname: Type.Optional(Type.String({ description: "Case-insensitive symlink target glob (`-ilname`)." })),
    regex: Type.Optional(Type.String({ description: "Full-path regular expression (`-regex`)." })),
    iregex: Type.Optional(Type.String({ description: "Case-insensitive full-path regex (`-iregex`)." })),
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
    uid: Type.Optional(Type.Integer({ minimum: 0, description: "Numeric owner uid (`-uid`)." })),
    gid: Type.Optional(Type.Integer({ minimum: 0, description: "Numeric group gid (`-gid`)." })),
    user: Type.Optional(Type.String({ description: "Owner name or uid (`-user`)." })),
    group: Type.Optional(Type.String({ description: "Group name or gid (`-group`)." })),
    links: Type.Optional(Type.String({ description: "Hard-link count expression, e.g. +1 (`-links`)." })),
    inum: Type.Optional(Type.Integer({ minimum: 0, description: "Exact inode number (`-inum`)." })),
    samefile: Type.Optional(Type.String({ description: "Same device and inode as this path (`-samefile`)." })),
    fstype: Type.Optional(Type.String({ description: "Filesystem type, e.g. ext4, tmpfs, nfs (`-fstype`)." })),
    newer: Type.Optional(Type.String({ description: "Only entries newer than this file (`-newer`)." })),
    newerXY: Type.Optional(Type.String({ description: "GNU -newerXY expression as XY:path, e.g. mm:/tmp/ref." })),
    printf: Type.Optional(Type.String({ description: "Per-match format string (`-printf`)." })),
    follow: Type.Optional(Type.Boolean({ description: "Follow symlinks (`-L`)." })),
    print0: Type.Optional(Type.Boolean({ description: "NUL-separated output (`-print0`)." })),
    sort: Type.Optional(Type.Boolean({ description: "Sort results lexically. Default: true." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface NewerXY {
  x: "a" | "c" | "m" | "B";
  y: "a" | "c" | "m" | "B";
  value: number;
}

interface Patterns {
  nameMatch?: ((value: string) => boolean) | undefined;
  inameMatch?: ((value: string) => boolean) | undefined;
  pathMatch?: ((value: string) => boolean) | undefined;
  lnameMatch?: ((value: string) => boolean) | undefined;
  ilnameMatch?: ((value: string) => boolean) | undefined;
  regex?: RegExp | undefined;
  iregex?: RegExp | undefined;
  newer?: number | undefined;
  newerXY?: NewerXY | undefined;
  samefile?: { dev: number; ino: number } | undefined;
  uid?: number | null | undefined;
  gid?: number | null | undefined;
  fstype?: string | undefined;
  fstypeCache: Map<string, string>;
}

const FS_TYPES = new Map<number, string>([
  [0xef53, "ext4"],
  [0x01021994, "tmpfs"],
  [0x794c7630, "overlay"],
  [0x58465342, "xfs"],
  [0x9123683e, "btrfs"],
  [0x6969, "nfs"],
  [0xff534d42, "cifs"],
  [0xfe534d42, "smb2"],
  [0x65735546, "fuse"],
  [0x01021997, "9p"],
  [0x858458f6, "ramfs"],
  [0x9fa0, "proc"],
  [0x62656572, "sysfs"],
  [0x1cd1, "devtmpfs"],
  [0x73717368, "squashfs"],
  [0x2fc12fc1, "zfs"],
  [0x4d44, "vfat"],
  [0x2011bab0, "exfat"],
]);

let userMap: Map<string, number> | undefined;
let groupMap: Map<string, number> | undefined;

export const findTool: ToolSpec<Input> = {
  name: "find",
  description:
    "Find entries with Linux-like predicates: `-name`, `-iname`, `-path`, `-lname`, `-ilname`, " +
    "`-regex`, `-iregex`, `-type`, `-size`, `-mtime`, `-mmin`, `-maxdepth`, `-mindepth`, `-empty`, `-perm`, " +
    "`-uid`, `-gid`, `-user`, `-group`, `-links`, `-inum`, `-samefile`, `-fstype`, `-newer`, " +
    "`-newerXY`, `-printf`, `-L`, `-print0`.",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    /* v8 ignore next */
    const paths = input.paths ?? ["."];
    const patterns: Patterns = {
      nameMatch: input.name === undefined ? undefined : picomatch(input.name, { dot: true }),
      inameMatch: input.iname === undefined ? undefined : picomatch(input.iname, { dot: true, nocase: true }),
      // GNU find lets `*` cross path separators in `-path`.
      pathMatch: input.pathPattern === undefined
        ? undefined
        : picomatch(input.pathPattern, { dot: true, bash: true }),
      lnameMatch: input.lname === undefined ? undefined : picomatch(input.lname, { dot: true }),
      ilnameMatch: input.ilname === undefined ? undefined : picomatch(input.ilname, { dot: true, nocase: true }),
      regex: input.regex === undefined ? undefined : new RegExp(input.regex),
      iregex: input.iregex === undefined ? undefined : new RegExp(input.iregex, "i"),
      fstype: input.fstype,
      fstypeCache: new Map(),
    };
    if (input.newer !== undefined) {
      const reference = await referenceStats(ctx, input.newer);
      patterns.newer = num(reference.mtimeMs);
    }
    if (input.newerXY !== undefined) patterns.newerXY = await parseNewerXY(ctx, input.newerXY);
    if (input.samefile !== undefined) {
      const reference = await referenceStats(ctx, input.samefile);
      patterns.samefile = { dev: num(reference.dev), ino: num(reference.ino) };
    }
    patterns.uid = input.uid ?? await resolveId(input.user, "user");
    patterns.gid = input.gid ?? await resolveId(input.group, "group");

    const results: string[] = [];
    for (const requested of paths) {
      const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      await ctx.permission.assert([{ target, boundary: target.full }]);
      /* v8 ignore next 3 */
      const rootStats = input.follow === true
        ? await ctx.sandbox.stat(target.full, requested)
        : await ctx.sandbox.lstat(target.full, requested);
      /* v8 ignore next */
      if (!rootStats.isDirectory()) {
        if (await matches(target.full, rootStats, input, patterns, 0)) {
          results.push(await render(requested, target.full, rootStats, input, patterns, target.full, 0));
        }
        continue;
      }
      /* v8 ignore next */
      if (input.maxDepth === 0) {
        if (await matches(target.full, rootStats, input, patterns, 0)) {
          results.push(await render(requested, target.full, rootStats, input, patterns, target.full, 0));
        }
        continue;
      }
      for (const entry of await walkAll(target.full, {
        recursive: true,
        followSymlinks: input.follow === true,
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        includeHidden: true,
        signal: ctx.signal,
        concurrency: ctx.concurrency,
      })) {
        const relative = path.relative(target.full, entry.path);
        const depth = relative.split(path.sep).length;
        if (input.minDepth !== undefined && depth < input.minDepth) continue;
        if (await matches(entry.path, entry.stats, input, patterns, depth)) {
          results.push(await render(entry.path, entry.path, entry.stats, input, patterns, target.full, depth));
        }
      }
    }
    if (input.sort !== false) results.sort((a, b) => a.localeCompare(b));
    if (input.printf !== undefined) {
      return textResult(results.join(""), { found: results.length });
    }
    const separator = input.print0 === true ? "\0" : "\n";
    /* v8 ignore next */
    const text = results.length === 0 ? "" : results.join(separator) + separator;
    return textResult(text, { found: results.length });
  },
};

async function matches(
  full: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  input: Input,
  patterns: Patterns,
  depth: number,
): Promise<boolean> {
  const base = path.basename(full);
  if (patterns.nameMatch !== undefined && !patterns.nameMatch(base)) return false;
  if (patterns.inameMatch !== undefined && !patterns.inameMatch(base)) return false;
  if (patterns.pathMatch !== undefined && !patterns.pathMatch(full)) return false;
  if (patterns.regex !== undefined && !patterns.regex.test(full)) return false;
  if (patterns.iregex !== undefined && !patterns.iregex.test(full)) return false;
  if (input.type !== undefined && typeOf(stats) !== input.type) return false;
  if (input.size !== undefined) {
    const sign = input.size.startsWith("+") ? 1 : input.size.startsWith("-") ? -1 : 0;
    const body = sign === 0 ? input.size : input.size.slice(1);
    const size = parseFindSize(body);
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
  if (patterns.newerXY !== undefined && timeValue(stats, patterns.newerXY.x) <= patterns.newerXY.value) return false;
  if (patterns.samefile !== undefined) {
    if (num(stats.dev) !== patterns.samefile.dev || num(stats.ino) !== patterns.samefile.ino) return false;
  }
  if (patterns.uid !== undefined) {
    if (patterns.uid === null || num(stats.uid) !== patterns.uid) return false;
  }
  if (patterns.gid !== undefined) {
    if (patterns.gid === null || num(stats.gid) !== patterns.gid) return false;
  }
  if (input.links !== undefined && !countMatches(num(stats.nlink), input.links)) return false;
  if (input.inum !== undefined && num(stats.ino) !== input.inum) return false;
  if (patterns.lnameMatch !== undefined || patterns.ilnameMatch !== undefined) {
    if (!stats.isSymbolicLink()) return false;
    /* v8 ignore next -- a symlink readable by lstat is normally readable here */
    const target = await fs.readlink(full).catch(() => "");
    if (patterns.lnameMatch !== undefined && !patterns.lnameMatch(target)) return false;
    if (patterns.ilnameMatch !== undefined && !patterns.ilnameMatch(target)) return false;
  }
  if (patterns.fstype !== undefined) {
    const type = await filesystemType(full, stats, patterns.fstypeCache);
    if (type !== patterns.fstype) return false;
  }
  void depth;
  return true;
}

async function render(
  display: string,
  full: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  input: Input,
  patterns: Patterns,
  root: string,
  depth: number,
): Promise<string> {
  if (input.printf === undefined) return display;
  return printf(display, full, stats, input, patterns, root, depth);
}

async function referenceStats(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  reference: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  const target = await ctx.sandbox.resolveExisting(reference, { allowRoot: true });
  await ctx.permission.assert([{ target, boundary: target.full }]);
  return ctx.sandbox.lstat(target.full, reference);
}

async function parseNewerXY(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  expression: string,
): Promise<NewerXY> {
  const match = /^([acmB])([acmB]):(.+)$/.exec(expression);
  if (match === null) throw new FsError("newerXY must look like mm:/path.", "invalid");
  const reference = await referenceStats(ctx, match[3] as string);
  return { x: match[1] as NewerXY["x"], y: match[2] as NewerXY["y"], value: timeValue(reference, match[2] as NewerXY["y"]) };
}

const TIME_FIELDS = {
  a: "atimeMs",
  c: "ctimeMs",
  m: "mtimeMs",
  B: "birthtimeMs",
} as const;

function timeValue(stats: Awaited<ReturnType<typeof fs.lstat>>, field: "a" | "c" | "m" | "B"): number {
  return num((stats as unknown as Record<(typeof TIME_FIELDS)[typeof field], number>)[TIME_FIELDS[field]]);
}

async function resolveId(value: string | undefined, kind: "user" | "group"): Promise<number | null | undefined> {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const map = kind === "user" ? await loadUserMap() : await loadGroupMap();
  return map.get(value) ?? null;
}

async function loadUserMap(): Promise<Map<string, number>> {
  if (userMap !== undefined) return userMap;
  userMap = new Map();
  /* v8 ignore next -- /etc/passwd exists on supported Linux systems */
  const text = await fs.readFile("/etc/passwd", "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields.length > 2) userMap.set(fields[0] as string, Number(fields[2]));
  }
  return userMap;
}

async function loadGroupMap(): Promise<Map<string, number>> {
  if (groupMap !== undefined) return groupMap;
  groupMap = new Map();
  /* v8 ignore next -- /etc/group exists on supported Linux systems */
  const text = await fs.readFile("/etc/group", "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields.length > 2) groupMap.set(fields[0] as string, Number(fields[2]));
  }
  return groupMap;
}

async function filesystemType(
  full: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  cache: Map<string, string>,
): Promise<string> {
  const key = String(stats.dev);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let name = "unknown";
  try {
    const fsStats = await fs.statfs(full);
    /* v8 ignore next -- unknown filesystems fall back to their numeric magic */
    name = FS_TYPES.get(Number(fsStats.type)) ?? `0x${Number(fsStats.type).toString(16)}`;
  } catch {}
  cache.set(key, name);
  return name;
}

async function printf(
  display: string,
  full: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  input: Input,
  patterns: Patterns,
  root: string,
  depth: number,
): Promise<string> {
  /* v8 ignore next -- a symlink readable by lstat is normally readable here */
  const link = stats.isSymbolicLink() ? await fs.readlink(full).catch(() => "") : "";
  const relative = path.relative(root, full);
  const values: Record<string, string> = {
    p: display,
    f: path.basename(display),
    h: path.dirname(display),
    P: relative,
    s: String(num(stats.size)),
    m: (num(stats.mode) & 0o7777).toString(8),
    M: modeString(stats),
    u: String(num(stats.uid)),
    U: await lookupUser(num(stats.uid)),
    g: String(num(stats.gid)),
    G: await lookupGroup(num(stats.gid)),
    y: typeOf(stats),
    Y: typeName(stats),
    i: String(num(stats.ino)),
    n: String(num(stats.nlink)),
    d: String(depth),
    l: link,
    b: String(num(stats.blocks)),
    k: String(Math.ceil(num(stats.blocks) / 2)),
    D: String(num(stats.dev)),
    F: await filesystemType(full, stats, patterns.fstypeCache),
    a: stats.atime.toISOString(),
    A: stats.atime.toISOString(),
    c: stats.ctime.toISOString(),
    C: stats.ctime.toISOString(),
    t: stats.mtime.toISOString(),
    T: stats.mtime.toISOString(),
  };
  const format = input.printf as string;
  let output = "";
  for (let index = 0; index < format.length; index++) {
    const char = format[index] as string;
    if (char === "\\") {
      const escaped = format[++index] as string | undefined;
      output += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "0" ? "\0" : escaped === "\\" ? "\\" : `\\${escaped ?? ""}`;
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
    if (next === "%") {
      output += "%";
      continue;
    }
    if ((next === "A" || next === "C" || next === "T") && format[index + 1] === "@") {
      const value = next === "A" ? stats.atimeMs : next === "C" ? stats.ctimeMs : stats.mtimeMs;
      output += String(Math.floor(num(value) / 1000));
      index++;
      continue;
    }
    output += values[next] ?? `%${next}`;
  }
  return output;
}

function parseFindSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([cwbkMGTPE]?)$/.exec(value);
  if (match === null) throw new FsError(`Invalid size: ${value}`, "invalid");
  const units: Record<string, number> = {
    c: 1,
    w: 2,
    b: 512,
    k: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
    E: 1024 ** 6,
  };
  return Math.ceil(Number(match[1]) * (units[match[2] as string] ?? 1));
}

function countMatches(value: number, expression: string): boolean {
  if (expression.startsWith("+")) return value > Number(expression.slice(1));
  if (expression.startsWith("-")) return value < Number(expression.slice(1));
  return value === Number(expression);
}

function ageMatches(age: number, expression: string): boolean {
  if (expression.startsWith("+")) return age > Number(expression.slice(1));
  if (expression.startsWith("-")) return age < Number(expression.slice(1));
  return Math.floor(age) === Number(expression);
}

function typeOf(stats: Awaited<ReturnType<typeof fs.lstat>>): string {
  if (stats.isDirectory()) return "d";
  /* v8 ignore next */
  if (stats.isSymbolicLink()) return "l";
  /* v8 ignore next */
  if (stats.isFIFO()) return "p";
  /* v8 ignore next */
  if (stats.isSocket()) return "s";
  return "f";
}
