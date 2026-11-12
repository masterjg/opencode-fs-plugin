/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FsError } from "../../src/core/errors.js";
import {
  copyTree,
  ensureParent,
  formatDate,
  isExists,
  isSubpath,
  lookupGroup,
  lookupUser,
  modeString,
  num,
  preserve,
  typeName,
  walk,
} from "../../src/core/fsutil.js";
import { makeRoot } from "../helpers.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<string> {
  const root = await makeRoot();
  roots.push(root);
  return root;
}

describe("fsutil walk and copy", () => {
  it("walks recursively with hidden and depth controls", async () => {
    const root = await setup();
    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/a"), "a");
    await fs.writeFile(path.join(root, "dir/.hidden"), "h");
    await fs.writeFile(path.join(root, "dir/sub/deep"), "d");
    const names: string[] = [];
    for await (const entry of walk(path.join(root, "dir"), { recursive: true, includeHidden: true })) names.push(entry.name);
    expect(names).toEqual(expect.arrayContaining(["a", ".hidden", "sub"]));
    const shallow: string[] = [];
    for await (const entry of walk(path.join(root, "dir"), { recursive: true, maxDepth: 1 })) shallow.push(entry.name);
    expect(shallow).toContain("sub");
    expect(shallow).not.toContain("deep");
    const hidden: string[] = [];
    for await (const entry of walk(path.join(root, "dir"), { recursive: true })) hidden.push(entry.name);
    expect(hidden).not.toContain(".hidden");
    const flat: string[] = [];
    for await (const entry of walk(path.join(root, "dir"), { recursive: false, includeHidden: true })) flat.push(entry.name);
    expect(flat).toContain("a");
    expect(flat).not.toContain("deep");
    await expect(collectWalk(path.join(root, "missing"))).rejects.toBeInstanceOf(FsError);
  });

  it("walks symlinks when requested and stops on abort", async () => {
    const root = await setup();
    await fs.mkdir(path.join(root, "dir"));
    await fs.mkdir(path.join(root, "target"));
    await fs.writeFile(path.join(root, "target/a"), "a");
    await fs.symlink(path.join(root, "target"), path.join(root, "dir/link"));
    const names: string[] = [];
    for await (const entry of walk(path.join(root, "dir"), { recursive: true, followSymlinks: true })) names.push(entry.name);
    expect(names).toContain("a");
    const controller = new AbortController();
    controller.abort();
    await expect(collectWalk(path.join(root, "dir"), controller.signal)).rejects.toMatchObject({ code: "interrupted" });
  });

  it("copies files, directories, symlinks and skips newer targets", async () => {
    const root = await setup();
    const src = path.join(root, "src");
    const dest = path.join(root, "dest");
    await fs.mkdir(path.join(src, "sub"), { recursive: true });
    await fs.writeFile(path.join(src, "sub/a"), "a");
    await fs.symlink("sub/a", path.join(src, "link"));
    const copied = await copyTree(src, dest, { recursive: true, concurrency: 2, dereference: false, preserve: true });
    expect(copied).toBeGreaterThan(0);
    expect((await fs.lstat(path.join(dest, "link"))).isSymbolicLink()).toBe(true);
    await fs.writeFile(path.join(root, "newer"), "new");
    await fs.utimes(path.join(root, "newer"), new Date(), new Date(Date.now() + 10_000));
    expect(await copyTree(path.join(src, "sub/a"), path.join(root, "newer"), { concurrency: 1, update: true })).toBe(0);
    expect(await copyTree(path.join(src, "sub/a"), path.join(root, "existing"), { concurrency: 1 })).toBe(1);
    expect(await copyTree(path.join(src, "sub/a"), path.join(root, "existing"), { concurrency: 1, noClobber: true })).toBe(0);
    await expect(copyTree(src, path.join(root, "x"), { concurrency: 1 })).rejects.toMatchObject({ code: "not-file" });
    const controller = new AbortController();
    controller.abort();
    await expect(copyTree(path.join(src, "sub/a"), path.join(root, "aborted"), { concurrency: 1, signal: controller.signal })).rejects.toMatchObject({ code: "interrupted" });
    await fs.writeFile(path.join(root, "symlink-source"), "x");
    await fs.unlink(path.join(root, "existing"));
    await fs.symlink(path.join(root, "symlink-source"), path.join(root, "existing"));
    expect(await copyTree(path.join(src, "link"), path.join(root, "existing"), { concurrency: 1, dereference: false })).toBe(1);
    expect((await fs.lstat(path.join(root, "existing"))).isSymbolicLink()).toBe(true);
  });

  it("rejects special files and reports parent errors", async () => {
    const root = await setup();
    const fifo = path.join(root, "fifo");
    await execFileAsync("mkfifo", [fifo]);
    await expect(copyTree(fifo, path.join(root, "copy"), { concurrency: 1 })).rejects.toMatchObject({
      code: "unsupported",
    });
    await fs.writeFile(path.join(root, "file"), "x");
    await expect(ensureParent(path.join(root, "file/child"))).rejects.toBeInstanceOf(FsError);
    await expect(preserve(path.join(root, "missing"), await fs.lstat(path.join(root, "file")))).rejects.toBeInstanceOf(FsError);
  });
});

describe("fsutil metadata helpers", () => {
  it("looks up users, groups and names", async () => {
    expect(await lookupUser(process.getuid?.() ?? 0)).toBeTruthy();
    expect(await lookupUser(999999)).toBe("999999");
    expect(await lookupGroup(process.getgid?.() ?? 0)).toBeTruthy();
    expect(await lookupGroup(999999)).toBe("999999");
  });

  it("formats dates, types and modes", async () => {
    const root = await setup();
    const file = path.join(root, "a");
    await fs.writeFile(file, "x");
    expect(formatDate(new Date())).toMatch(/\w{3} \d{2} \d{2}:\d{2}/);
    expect(formatDate(new Date("2000-01-01T00:00:00Z"))).toContain("2000");
    expect(typeName(await fs.lstat(file))).toBe("regular file");
    expect(typeName(await fs.lstat(root))).toBe("directory");
    await fs.symlink(file, path.join(root, "link"));
    expect(typeName(await fs.lstat(path.join(root, "link")))).toBe("symbolic link");
    expect(modeString(await fs.lstat(file))).toMatch(/^-/);
    expect(num(5)).toBe(5);
    expect(num(5n)).toBe(5);
  });

  it("detects sockets, fifos and subpaths", async () => {
    const root = await setup();
    const fifo = path.join(root, "fifo-type");
    await execFileAsync("mkfifo", [fifo]);
    expect(typeName(await fs.lstat(fifo))).toBe("fifo");
    const socketPath = path.join(root, "sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    expect(typeName(await fs.lstat(socketPath))).toBe("socket");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(isSubpath(root, path.join(root, "a"))).toBe(true);
    expect(isSubpath(root, path.join(root, "../a"))).toBe(false);
    expect(isExists(Object.assign(new Error("x"), { code: "EEXIST" }))).toBe(true);
    expect(isExists(new Error("x"))).toBe(false);
  });
});

async function collectWalk(root: string, signal?: AbortSignal): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of walk(root, { recursive: true, ...(signal === undefined ? {} : { signal }) })) names.push(entry.name);
  return names;
}
