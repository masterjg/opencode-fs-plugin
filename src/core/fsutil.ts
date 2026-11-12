/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { FsError, fromErrno, isMissing } from "./errors.js";
import { formatMode } from "./mode.js";
import { createLimiter, mapLimit } from "./parallel.js";

export interface WalkEntry {
  readonly path: string;
  readonly name: string;
  readonly stats: Awaited<ReturnType<typeof fs.lstat>>;
}

export interface WalkOptions {
  readonly recursive?: boolean;
  readonly followSymlinks?: boolean;
  readonly maxDepth?: number;
  readonly includeHidden?: boolean;
  readonly signal?: AbortSignal;
  /** Parallel entry stats per directory. Default: 1 (sequential). */
  readonly concurrency?: number;
}

export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<WalkEntry> {
  const maxDepth = options.maxDepth ?? (options.recursive === false ? 0 : Infinity);
  yield* walkAt(root, 0, maxDepth, options);
}

async function* walkAt(
  current: string,
  depth: number,
  maxDepth: number,
  options: WalkOptions,
): AsyncGenerator<WalkEntry> {
  if (options.signal?.aborted) throw new FsError("Operation interrupted.", "interrupted");
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    throw fromErrno(error, "access");
  }
  const visible = options.includeHidden ? entries : entries.filter((dirent) => !dirent.name.startsWith("."));
  const resolved = await mapLimit(
    visible,
    Math.max(1, options.concurrency ?? 1),
    async (dirent): Promise<WalkEntry | undefined> => {
      const full = path.join(current, dirent.name);
      try {
        const stats = options.followSymlinks ? await fs.stat(full) : await fs.lstat(full);
        return { path: full, name: dirent.name, stats };
      } catch (error) {
        /* v8 ignore next 3 */
        if (isMissing(error)) return undefined;
        /* v8 ignore next */
        throw fromErrno(error, "access");
      }
    },
    options.signal,
  );

  for (const entry of resolved) {
    /* v8 ignore next */
    if (entry === undefined) continue;
    yield entry;
    if (depth + 1 < maxDepth && entry.stats.isDirectory()) {
      yield* walkAt(entry.path, depth + 1, maxDepth, options);
    }
  }
}

/**
 * Collect a tree with directory stats and subtree recursion running
 * concurrently. Syscalls share one limit, and results keep depth-first order.
 */
export async function walkAll(root: string, options: WalkOptions = {}): Promise<WalkEntry[]> {
  const maxDepth = options.maxDepth ?? (options.recursive === false ? 0 : Infinity);
  const gate = createLimiter(Math.max(1, options.concurrency ?? 1));
  return walkDir(root, 0, maxDepth, options, gate);
}

async function walkDir(
  current: string,
  depth: number,
  maxDepth: number,
  options: WalkOptions,
  gate: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<WalkEntry[]> {
  if (options.signal?.aborted) throw new FsError("Operation interrupted.", "interrupted");
  let entries;
  try {
    entries = await gate(() => fs.readdir(current, { withFileTypes: true }));
  } catch (error) {
    throw fromErrno(error, "access");
  }
  const visible = options.includeHidden ? entries : entries.filter((dirent) => !dirent.name.startsWith("."));
  const resolved = await Promise.all(
    visible.map(async (dirent): Promise<WalkEntry | undefined> => {
      const full = path.join(current, dirent.name);
      try {
        const stats = await gate(() => (options.followSymlinks ? fs.stat(full) : fs.lstat(full)));
        return { path: full, name: dirent.name, stats };
      } catch (error) {
        /* v8 ignore next 3 */
        if (isMissing(error)) return undefined;
        /* v8 ignore next */
        throw fromErrno(error, "access");
      }
    }),
  );
  const subtrees = await Promise.all(
    resolved.map((entry) =>
      entry === undefined || depth + 1 >= maxDepth || !entry.stats.isDirectory()
        ? Promise.resolve(undefined)
        : walkDir(entry.path, depth + 1, maxDepth, options, gate),
    ),
  );

  const output: WalkEntry[] = [];
  for (let index = 0; index < resolved.length; index++) {
    const entry = resolved[index];
    /* v8 ignore next */
    if (entry === undefined) continue;
    output.push(entry);
    const subtree = subtrees[index];
    /* v8 ignore next */
    if (subtree !== undefined) output.push(...subtree);
  }
  return output;
}

export interface CopyOptions {
  readonly recursive?: boolean;
  readonly dereference?: boolean;
  readonly preserve?: boolean;
  readonly noClobber?: boolean;
  readonly update?: boolean;
  readonly signal?: AbortSignal;
  readonly concurrency: number;
}

export async function copyTree(src: string, dest: string, options: CopyOptions): Promise<number> {
  if (options.signal?.aborted) throw new FsError("Operation interrupted.", "interrupted");
  const stats = options.dereference === false ? await fs.lstat(src) : await fs.stat(src);
  if (options.update === true) {
    try {
      const destStats = await fs.lstat(dest);
      /* v8 ignore next */
      if (destStats.mtimeMs >= stats.mtimeMs) return 0;
    } catch (error) {
      /* v8 ignore next 2 */
      if (!isMissing(error)) throw fromErrno(error, "access");
    }
  }

  if (stats.isSymbolicLink() && options.dereference === false) {
    const target = await fs.readlink(src);
    await ensureParent(dest);
    try {
      await fs.symlink(target, dest);
    } catch (error) {
      /* v8 ignore next */
      if (isExists(error) && options.noClobber !== true) {
        await fs.unlink(dest);
        await fs.symlink(target, dest);
      } else {
        throw fromErrno(error);
      }
    }
    return 1;
  }

  if (stats.isDirectory()) {
    if (options.recursive !== true) {
      throw new FsError(`"${src}" is a directory; recursive is required.`, "not-file");
    }
    try {
      await fs.mkdir(dest, { recursive: true });
    } catch (error) {
      /* v8 ignore next */
      throw fromErrno(error);
    }
    const entries = await fs.readdir(src);
    let copied = 1;
    const limit = Math.max(1, options.concurrency);
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, entries.length) }, async () => {
      for (;;) {
        const current = index++;
        if (current >= entries.length) return;
        const name = entries[current] as string;
        copied += await copyTree(path.join(src, name), path.join(dest, name), options);
      }
    });
    await Promise.all(workers);
    if (options.preserve === true) await preserve(dest, stats);
    return copied;
  }

  if (!stats.isFile()) {
    throw new FsError(`"${src}" is not a regular file or directory.`, "unsupported");
  }
  await ensureParent(dest);
  try {
    await fs.copyFile(src, dest, options.noClobber === true ? constants.COPYFILE_EXCL : 0);
  } catch (error) {
    /* v8 ignore next */
    if (options.noClobber === true && isExists(error)) return 0;
    /* v8 ignore next */
    throw fromErrno(error);
  }
  if (options.preserve === true) await preserve(dest, stats);
  return 1;
}

export async function ensureParent(dest: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
  } catch (error) {
    throw fromErrno(error);
  }
}

export function num(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

export async function preserve(dest: string, stats: Awaited<ReturnType<typeof fs.stat>>): Promise<void> {
  try {
    await fs.chmod(dest, num(stats.mode) & 0o7777);
    await fs.utimes(dest, stats.atime, stats.mtime);
  } catch (error) {
    throw fromErrno(error, "io");
  }
}

export async function lookupUser(uid: number): Promise<string> {
  return (await lookupId("/etc/passwd", uid)) ?? String(uid);
}

export async function lookupGroup(gid: number): Promise<string> {
  return (await lookupId("/etc/group", gid)) ?? String(gid);
}

const idCaches = new Map<string, Map<number, string>>();

async function lookupId(file: string, id: number): Promise<string | undefined> {
  let cache = idCaches.get(file);
  if (cache === undefined) {
    cache = new Map();
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      /* v8 ignore next */
      return undefined;
    }
    for (const line of text.split("\n")) {
      const fields = line.split(":");
      if (fields.length >= 3) cache.set(Number(fields[2]), fields[0] as string);
    }
    idCaches.set(file, cache);
  }
  return cache.get(id);
}

export function formatDate(date: Date, now = new Date()): string {
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = String(date.getDate()).padStart(2, " ");
  const sixMonths = 183 * 24 * 60 * 60 * 1000;
  const recent = Math.abs(now.getTime() - date.getTime()) < sixMonths;
  const time = recent
    ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : String(date.getFullYear());
  return `${month} ${day} ${recent ? time : ` ${time}`}`;
}

export function typeName(stats: Awaited<ReturnType<typeof fs.lstat>>): string {
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symbolic link";
  if (stats.isFile()) return "regular file";
  if (stats.isFIFO()) return "fifo";
  /* v8 ignore next */
  if (stats.isSocket()) return "socket";
  /* v8 ignore next */
  if (stats.isCharacterDevice()) return "character special file";
  /* v8 ignore next */
  if (stats.isBlockDevice()) return "block special file";
  /* v8 ignore next */
  return "unknown";
}

export function modeString(stats: Awaited<ReturnType<typeof fs.lstat>>): string {
  return formatMode(num(stats.mode));
}

export function isSubpath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}
