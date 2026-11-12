/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FsError } from "../../src/core/errors.js";
import { Sandbox } from "../../src/core/sandbox.js";
import { makeOutside, makeRoot, pathExists } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function sandbox(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot();
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

describe("Sandbox", () => {
  it("rejects empty roots", async () => {
    await expect(Sandbox.create("")).rejects.toMatchObject({ code: "empty" });
  });

  it("falls back to the lexical root when it does not exist", async () => {
    const root = path.join(await makeRoot(), "missing");
    roots.push(root);
    const sb = await Sandbox.create(root);
    expect(sb.root).toBe(root);
  });

  it("resolves create targets and reports containment", async () => {
    const { root, sb } = await sandbox();
    const target = await sb.resolveForCreate("build/nested");
    expect(target.full).toBe(path.join(root, "build/nested"));
    expect(target.outside).toBe(false);
    expect(sb.resource(target.full)).toBe("build/nested");
    expect(sb.resource(sb.root)).toBe(".");
  });

  it("detects lexical and symlink escapes", async () => {
    const { root, sb } = await sandbox();
    const outside = await makeOutside();
    roots.push(outside.dir);
    await fs.symlink(outside.dir, path.join(root, "somedir"), "dir");

    const lexical = await sb.resolveForCreate(path.join("..", path.basename(outside.dir), "new"));
    expect(lexical.outside).toBe(true);

    const viaLink = await sb.resolveForCreate("somedir/new");
    expect(viaLink.outside).toBe(true);
    expect(viaLink.full).toBe(path.join(outside.dir, "new"));
  });

  it("resolves existing targets without following the final link", async () => {
    const { root, sb } = await sandbox();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const link = path.join(root, "filelink");
    await fs.symlink(outside.file, link);

    const target = await sb.resolveExisting("filelink");
    expect(target.full).toBe(link);
    expect(target.outside).toBe(false);

    const followed = await sb.resolveFollow("filelink");
    expect(followed.full).toBe(outside.file);
    expect(followed.outside).toBe(true);
  });

  it("refuses the root and missing targets", async () => {
    const { sb } = await sandbox();
    await expect(sb.resolveExisting(".")).rejects.toMatchObject({ code: "outside" });
    await expect(sb.resolveExisting("missing")).rejects.toMatchObject({ code: "not-found" });
  });

  it("resolves parents for replacement targets", async () => {
    const { root, sb } = await sandbox();
    const parent = await sb.resolveParent("a/b/c");
    expect(parent.full).toBe(path.join(root, "a/b"));
    expect(parent.outside).toBe(false);
  });

  it("supports metadata helpers", async () => {
    const { root, sb } = await sandbox();
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "hello");
    expect((await sb.lstat(file)).isFile()).toBe(true);
    expect((await sb.stat(file)).size).toBe(5);
    expect((await sb.readdir(root)).map((entry) => entry.name)).toContain("a.txt");
    expect(await sb.exists(file)).toBe(true);
    expect(await sb.exists(path.join(root, "no"))).toBe(false);
    expect(sb.boundaryFor(file, "file")).toBe(root);
    expect(sb.boundaryFor(root, "directory")).toBe(root);
  });

  it("maps missing and permission errors", async () => {
    const { sb } = await sandbox();
    await expect(sb.lstat(path.join(sb.root, "nope"))).rejects.toMatchObject({ code: "not-found" });
    await expect(sb.stat(path.join(sb.root, "nope"))).rejects.toMatchObject({ code: "not-found" });
    await expect(sb.resolveFollow(path.join(sb.root, "nope"))).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("blocks destructive operations on hard stops", async () => {
    const { sb } = await sandbox();
    expect(() => sb.assertSafeToDelete(sb.root)).toThrow(FsError);
    expect(() => sb.assertSafeToDelete(path.dirname(sb.root))).toThrow(FsError);
    expect(() => sb.assertSafeToDelete("/")).toThrow(FsError);
    expect(() => sb.assertSafeToDelete("/etc")).toThrow(FsError);
    expect(() => sb.assertSafeToDelete(path.join(sb.root, "ok"))).not.toThrow();
  });

  it("rejects empty and NUL paths", async () => {
    const { sb } = await sandbox();
    await expect(sb.resolveForCreate("")).rejects.toMatchObject({ code: "empty" });
    await expect(sb.resolveForCreate("a\0b")).rejects.toMatchObject({ code: "invalid" });
    await expect(sb.resolveExisting("")).rejects.toMatchObject({ code: "empty" });
  });

  it("creates nested targets whose ancestors do not exist", async () => {
    const { root, sb } = await sandbox();
    const target = await sb.resolveForCreate("a/b/c/d");
    expect(target.full).toBe(path.join(root, "a/b/c/d"));
    expect(target.outside).toBe(false);
  });

  it("reports existing files through links and rejects broken links", async () => {
    const { root, sb } = await sandbox();
    const link = path.join(root, "broken");
    await fs.symlink(path.join(root, "missing"), link);
    await expect(sb.resolveFollow("broken")).rejects.toMatchObject({ code: "not-found" });
    expect(await sb.exists(link)).toBe(true);
  });
});
