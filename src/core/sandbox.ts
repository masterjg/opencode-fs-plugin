/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FsError, fromErrno, isMissing } from "./errors.js";

export interface ResolvedTarget {
  /** Absolute path to operate on. */
  full: string;
  /** True when the real location escapes the sandbox root. */
  outside: boolean;
  /** Path as requested by the caller, useful in error messages. */
  requested: string;
  /** Realpath of the deepest existing ancestor, or the target itself. */
  realAncestor: string;
}

export interface ResolveOptions {
  /** Allow the sandbox root itself as a target. */
  allowRoot?: boolean;
}

const CRITICAL_PATHS = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
]);

/**
 * An asynchronous, symlink-aware filesystem sandbox.
 *
 * The root is canonicalized once. Every public resolver follows symlinks for
 * *traversed* components and reports whether the real target escapes the root.
 * Outside targets are not rejected here; callers gate them with the
 * external_directory permission, exactly like OpenCode's built-ins.
 */
export class Sandbox {
  readonly root: string;
  readonly lexicalRoot: string;
  private readonly rootSep: string;

  private constructor(root: string, lexicalRoot: string) {
    this.root = root;
    this.lexicalRoot = lexicalRoot;
    this.rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  }

  static async create(rawRoot: string): Promise<Sandbox> {
    if (typeof rawRoot !== "string" || rawRoot.length === 0) {
      throw new FsError("Sandbox root is empty.", "empty");
    }
    const lexicalRoot = path.resolve(rawRoot);
    let root: string;
    try {
      root = await fs.realpath(lexicalRoot);
    } catch {
      root = lexicalRoot;
    }
    return new Sandbox(root, lexicalRoot);
  }

  isWithin(candidate: string): boolean {
    return candidate === this.root || candidate.startsWith(this.rootSep);
  }

  /** Convert an absolute path to the permission resource form. */
  resource(full: string): string {
    const rel = path.relative(this.lexicalRoot, full);
    return (rel === "" ? "." : rel).split(path.sep).join("/");
  }

  /** Resolve a path that is about to be created. */
  async resolveForCreate(target: string): Promise<ResolvedTarget> {
    this.assertTarget(target);
    const abs = path.resolve(this.root, target);
    const { real, tail } = await this.deepestExistingAncestor(abs);
    const full = tail.length > 0 ? path.join(real, ...tail) : real;
    return {
      full,
      outside: !this.isWithin(real),
      requested: target,
      realAncestor: real,
    };
  }

  /**
   * Resolve an existing target without following its final component. Used by
   * deletion, rename, lstat-style metadata, and symlink operations.
   */
  async resolveExisting(target: string, options: ResolveOptions = {}): Promise<ResolvedTarget> {
    this.assertTarget(target);
    const abs = path.resolve(this.root, target);
    if (!options.allowRoot && abs === this.root) {
      throw new FsError(`Blocked: the sandbox root itself (${this.root}) is a hard stop.`, "outside");
    }
    await this.lstat(abs, target);
    const parentAbs = path.dirname(abs);
    const { real: parentReal, tail } = await this.deepestExistingAncestor(parentAbs);
    return {
      full: abs,
      outside: tail.length > 0 || !this.isWithin(parentReal),
      requested: target,
      realAncestor: parentReal,
    };
  }

  /** Resolve an existing target, following a final symlink. */
  async resolveFollow(target: string): Promise<ResolvedTarget> {
    this.assertTarget(target);
    const abs = path.resolve(this.root, target);
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch (error) {
      if (isMissing(error)) throw new FsError(`Not found: "${target}"`, "not-found");
      throw fromErrno(error, "access");
    }
    return {
      full: real,
      outside: !this.isWithin(real),
      requested: target,
      realAncestor: real,
    };
  }

  /** Resolve the parent of a target that may be created or replaced. */
  async resolveParent(target: string): Promise<ResolvedTarget> {
    this.assertTarget(target);
    const abs = path.resolve(this.root, target);
    const parentAbs = path.dirname(abs);
    const { real, tail } = await this.deepestExistingAncestor(parentAbs);
    const parent = tail.length > 0 ? path.join(real, ...tail) : real;
    return {
      full: parent,
      outside: !this.isWithin(real),
      requested: target,
      realAncestor: real,
    };
  }

  async lstat(full: string, label = full): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
    try {
      return await fs.lstat(full);
    } catch (error) {
      if (isMissing(error)) throw new FsError(`Not found: "${label}"`, "not-found");
      throw fromErrno(error, "access");
    }
  }

  async stat(full: string, label = full): Promise<Awaited<ReturnType<typeof fs.stat>>> {
    try {
      return await fs.stat(full);
    } catch (error) {
      if (isMissing(error)) throw new FsError(`Not found: "${label}"`, "not-found");
      throw fromErrno(error, "access");
    }
  }

  async readdir(full: string): Promise<import("node:fs").Dirent[]> {
    try {
      return await fs.readdir(full, { withFileTypes: true });
    } catch (error) {
      throw fromErrno(error, "access");
    }
  }

  async exists(full: string): Promise<boolean> {
    try {
      await fs.lstat(full);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw fromErrno(error, "access");
    }
  }

  /** Refuse destructive operations on the root, its ancestors, and core paths. */
  assertSafeToDelete(full: string): void {
    const resolved = path.resolve(full);
    if (resolved === this.root) {
      throw new FsError(`Blocked: the sandbox root itself (${this.root}) cannot be removed.`, "outside");
    }
    if (this.root.startsWith(resolved + path.sep) || resolved === path.parse(resolved).root) {
      throw new FsError(`Blocked: "${resolved}" is an ancestor of the sandbox root.`, "outside");
    }
    if (CRITICAL_PATHS.has(resolved)) {
      throw new FsError(`Blocked: refusing a destructive operation on "${resolved}".`, "outside");
    }
  }

  /** Boundary directory used for the external_directory permission. */
  boundaryFor(full: string, kind: "file" | "directory"): string {
    return kind === "directory" ? full : path.dirname(full);
  }

  private assertTarget(target: string): void {
    if (typeof target !== "string" || target.length === 0) {
      throw new FsError("Target path is empty.", "empty");
    }
    if (target.includes("\0")) {
      throw new FsError("Target path contains a NUL byte.", "invalid");
    }
  }

  private async deepestExistingAncestor(abs: string): Promise<{ real: string; tail: string[] }> {
    let node = abs;
    const tail: string[] = [];
    for (;;) {
      try {
        await fs.lstat(node);
        break;
      } catch (error) {
        if (isMissing(error)) {
          const base = path.basename(node);
          const parent = path.dirname(node);
          if (base === "" || parent === node) break;
          tail.unshift(base);
          node = parent;
          continue;
        }
        throw fromErrno(error, "access");
      }
    }
    let real: string;
    try {
      real = await fs.realpath(node);
    } catch (error) {
      throw fromErrno(error, "access");
    }
    return { real, tail };
  }
}
