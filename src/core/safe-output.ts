/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { FsError, errnoCode, fromErrno, isMissing } from "./errors.js";
import type { PermissionGate } from "./permissions.js";
import type { ResolvedTarget, Sandbox } from "./sandbox.js";

/**
 * Resolve the path a following write actually reaches. Existing final
 * symlinks (including a dangling link's would-be target) are followed so the
 * permission gate sees the real destination, not only the link path.
 */
export async function resolveOutputTarget(sandbox: Sandbox, target: string): Promise<ResolvedTarget> {
  return sandbox.resolveForWrite(target);
}

/** Permission boundary for a file output is its containing directory. */
export function outputBoundary(full: string): string {
  return path.dirname(full);
}

/**
 * Open a file for a direct write without following a final symlink. The caller
 * resolves and gates the canonical target first; `O_NOFOLLOW` closes the gap
 * where the final component is swapped for a link after that check.
 */
export async function openOutput(
  full: string,
  append = false,
  mode = 0o666,
): Promise<fs.FileHandle> {
  const flags = append
    ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  try {
    return await fs.open(full, flags, mode);
  } catch (error) {
    throw fromErrno(error);
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new FsError("Operation interrupted.", "interrupted");
}

/**
 * Write every byte of a buffer, retrying partial writes. A zero-progress write
 * is a hard I/O error, never a silent truncation.
 */
export async function writeFully(
  handle: fs.FileHandle,
  data: Buffer,
  position?: number,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    throwIfAborted(signal);
    let bytesWritten: number;
    try {
      ({ bytesWritten } = await handle.write(
        data,
        offset,
        data.length - offset,
        position === undefined ? undefined : position + offset,
      ));
    } catch (error) {
      throw fromErrno(error);
    }
    if (bytesWritten <= 0) throw new FsError("Short write: no bytes written.", "io");
    offset += bytesWritten;
  }
}

/** Write a buffer or stream to an already-resolved output path. */
export async function writeOutput(
  full: string,
  data: Buffer | AsyncIterable<Buffer>,
  append = false,
  mode = 0o666,
  signal?: AbortSignal,
  finalMode?: number,
): Promise<void> {
  throwIfAborted(signal);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await openOutput(full, append, mode);
    if (Buffer.isBuffer(data)) {
      await writeFully(handle, data, undefined, signal);
    } else {
      for await (const chunk of data) await writeFully(handle, chunk, undefined, signal);
    }
    if (finalMode !== undefined) await handle.chmod(finalMode);
  } catch (error) {
    if (error instanceof FsError) throw error;
    throw fromErrno(error);
  } finally {
    await handle?.close();
  }
}

/**
 * Change a directory mode through an O_DIRECTORY|O_NOFOLLOW handle. An
 * unreadable directory (EACCES on O_RDONLY) falls back to path chmod only
 * after lstat confirms a real, non-symlink directory. That narrow fallback
 * retains the final-component swap race; ordinary readable directories stay
 * on the handle path.
 */
export async function chmodDirectoryNoFollow(full: string, mode: number): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      full,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await handle.chmod(mode);
    return;
  } catch (error) {
    if (errnoCode(error) !== "EACCES") throw fromErrno(error);
    try {
      const stats = await fs.lstat(full);
      /* v8 ignore next 3 -- final-component swap guard cannot be made deterministic */
      if (!stats.isDirectory()) {
        throw new FsError(`Blocked directory mode: "${full}" is not a directory.`, "archive");
      }
      await fs.chmod(full, mode);
    } catch (fallbackError) {
      /* v8 ignore next 2 -- fallback OS errors are environment-dependent */
      if (fallbackError instanceof FsError) throw fallbackError;
      /* v8 ignore next -- fallback OS errors are environment-dependent */
      throw fromErrno(fallbackError);
    }
  } finally {
    await handle?.close();
  }
}

export type ArchiveEntryKind = "file" | "directory" | "symlink";

/** File bits safe to apply: strip suid/sgid/sticky, then respect umask. */
export function safeMode(mode: number, umask = process.umask()): number {
  return (mode & 0o777) & ~umask;
}

/** Directory bits: strip suid/sgid, preserve sticky, then respect umask. */
export function safeDirectoryMode(mode: number, umask = process.umask()): number {
  return (mode & 0o1000) | ((mode & 0o777) & ~umask);
}

/**
 * Resolve an archive extraction destination in its canonical parent, refusing
 * an existing final symlink. A target that leaves the sandbox is allowed only
 * through the later bulk `external_directory` gate; one that stays inside the
 * sandbox but escapes the extraction root is refused here.
 */
export async function resolveArchiveTarget(
  sandbox: Sandbox,
  root: string,
  destination: string,
  kind: ArchiveEntryKind,
): Promise<ResolvedTarget> {
  const target = await sandbox.resolveForCreate(destination);
  let stats: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    stats = await fs.lstat(target.full);
  } catch (error) {
    /* v8 ignore next */
    if (!isMissing(error)) throw fromErrno(error, "access");
  }
  if (stats !== undefined) {
    if (stats.isSymbolicLink()) {
      throw new FsError(`Blocked archive path: "${destination}" is a symbolic link.`, "archive");
    }
    if (kind === "symlink") {
      throw new FsError(`Blocked archive path: "${destination}" already exists.`, "archive");
    }
  }
  if (!isWithinRoot(root, target.full) && !target.outside) {
    throw new FsError(`Blocked archive path: "${destination}" escapes the extraction root.`, "archive");
  }
  return target;
}

export interface ArchivePlan {
  readonly target: ResolvedTarget;
  readonly kind: ArchiveEntryKind;
}

/** Assert one bulk permission request for all planned extraction targets. */
export async function assertArchivePlan(
  gate: PermissionGate,
  plans: readonly ArchivePlan[],
  root: { target: ResolvedTarget; boundary: string },
): Promise<void> {
  const entries = plans.map(({ target, kind }) => ({
    target,
    boundary: kind === "directory" ? target.full : outputBoundary(target.full),
  }));
  entries.push(root);
  await gate.assert(entries);
}

/**
 * Directory plans to apply modes for: canonical target deduplicated with the
 * last archive entry winning, deepest path first.
 */
export function finalDirectoryPlans<T extends { target: ResolvedTarget; kind: ArchiveEntryKind }>(
  plans: readonly T[],
): T[] {
  const last = new Map<string, T>();
  for (const plan of plans) {
    if (plan.kind === "directory") last.set(plan.target.full, plan);
  }
  return [...last.values()].sort(
    (a, b) => b.target.full.split(path.sep).length - a.target.full.split(path.sep).length,
  );
}

/**
 * Reject members that collide with, or live beneath, an archive-created
 * symlink. Such descendants would otherwise be written through the newly
 * created link during extraction.
 */
export function assertArchiveSymlinkPlan(plans: readonly ArchivePlan[]): void {
  const links = new Set(
    plans.filter((plan) => plan.kind === "symlink").map((plan) => plan.target.full),
  );
  if (links.size === 0) return;
  const seenLinks = new Set<string>();
  for (const plan of plans) {
    const full = plan.target.full;
    if (links.has(full)) {
      if (plan.kind !== "symlink" || seenLinks.has(full)) {
        throw new FsError(`Blocked archive path: "${full}" collides with a symlink member.`, "archive");
      }
      seenLinks.add(full);
    }
    for (let parent = path.dirname(full); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      if (links.has(parent)) {
        throw new FsError(`Blocked archive path: "${full}" is beneath a symlink member.`, "archive");
      }
    }
  }
}

/**
 * Safe member name for archive creation. Relative sources keep their safe
 * relative layout; absolute sources are named relative to the base first, then
 * the project root; unsafe or external sources fall back to the basename.
 */
export function archiveSourceName(requested: string, full: string, base: string, root: string): string {
  if (!path.isAbsolute(requested)) {
    const normalized = path.normalize(requested);
    if (!path.isAbsolute(normalized) && !normalized.split(path.sep).includes("..")) {
      return normalized;
    }
  } else {
    const fromBase = relativeMember(base, full);
    if (fromBase !== undefined) return fromBase;
    const fromRoot = relativeMember(root, full);
    if (fromRoot !== undefined) return fromRoot;
  }
  return path.basename(full);
}

function relativeMember(parent: string, child: string): string | undefined {
  if (!isWithinRoot(parent, child)) return undefined;
  const relative = path.relative(parent, child);
  return relative === "" ? undefined : relative;
}

/** Reject archived symlink targets that are absolute, empty, or traversing. */
export function assertSafeLinkTarget(linkname: string): void {
  if (linkname.length === 0 || linkname.includes("\0")) {
    throw new FsError(`Blocked symlink target: ${JSON.stringify(linkname)}`, "archive");
  }
  if (path.isAbsolute(linkname) || linkname.split("/").includes("..")) {
    throw new FsError(`Blocked symlink target: ${linkname}`, "archive");
  }
}

export function isWithinRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
