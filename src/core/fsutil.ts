/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { FsError, fromErrno, isMissing } from "./errors.js";
import { formatMode } from "./mode.js";

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
  for (const dirent of entries) {
    if (!options.includeHidden && dirent.name.startsWith(".")) continue;
    const full = path.join(current, dirent.name);
    let stats;
    try {
      stats = options.followSymlinks ? await fs.stat(full) : await fs.lstat(full);
    } catch (error) {
      if (isMissing(error)) continue;
      throw fromErrno(error, "access");
    }
    yield { path: full, name: dirent.name, stats };
    if (depth + 1 < maxDepth && stats.isDirectory()) {
      yield* walkAt(full, depth + 1, maxDepth, options);
    }
  }
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
      if (destStats.mtimeMs >= stats.mtimeMs) return 0;
    } catch (error) {
      if (!isMissing(error)) throw fromErrno(error, "access");
    }
  }

  if (stats.isSymbolicLink() && options.dereference === false) {
    const target = await fs.readlink(src);
    await ensureParent(dest);
    try {
      await fs.symlink(target, dest);
    } catch (error) {
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
    if (options.noClobber === true && isExists(error)) return 0;
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

async function lookupId(file: string, id: number): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields.length >= 3 && Number(fields[2]) === id) return fields[0] as string;
  }
  return undefined;
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
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character special file";
  if (stats.isBlockDevice()) return "block special file";
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
