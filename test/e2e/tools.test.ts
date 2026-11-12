/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FsError } from "../../src/core/errors.js";
import { Sandbox } from "../../src/core/sandbox.js";
import { mkdirTool } from "../../src/tools/mkdir.js";
import { rmdirTool } from "../../src/tools/rmdir.js";
import { rmTool } from "../../src/tools/rm.js";
import { makeRoot, pathExists, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot();
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

describe("mkdir", () => {
  it("creates a directory and defaults to non-recursive", async () => {
    const { root, sb } = await setup();
    const result = await runSpec(mkdirTool, { path: "one" }, sb);
    expect(result.result.exitCode).toBe(0);
    expect(await pathExists(path.join(root, "one"))).toBe(true);
  });

  it("refuses missing parents without parents: true", async () => {
    const { sb } = await setup();
    await expect(runSpec(mkdirTool, { path: "a/b" }, sb)).rejects.toBeInstanceOf(FsError);
  });

  it("creates parents, applies mode and reports verbose output", async () => {
    const { root, sb } = await setup();
    const result = await runSpec(
      mkdirTool,
      { path: "a/b", parents: true, mode: "700", verbose: true },
      sb,
    );
    expect(result.result.stdout.toString()).toContain("Directory created");
    const stats = await fs.stat(path.join(root, "a/b"));
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it("treats existing directories as a no-op with parents", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "one"));
    const result = await runSpec(mkdirTool, { path: "one", parents: true }, sb);
    expect(result.result.metadata).toMatchObject({ created: false });
  });

  it("rejects existing non-directories and existing directories without parents", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "file"), "x");
    await expect(runSpec(mkdirTool, { path: "file" }, sb)).rejects.toMatchObject({ code: "exists" });
    await fs.mkdir(path.join(root, "dir"));
    await expect(runSpec(mkdirTool, { path: "dir" }, sb)).rejects.toMatchObject({ code: "exists" });
  });

  it("asks for permission before creating", async () => {
    const { sb } = await setup();
    const result = await runSpec(mkdirTool, { path: "one" }, sb);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ action: "fs_mkdir", resources: ["one"] });
  });
});

describe("rmdir", () => {
  it("removes empty directories and reports verbose output", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "empty"));
    const result = await runSpec(rmdirTool, { paths: ["empty"], verbose: true }, sb);
    expect(result.result.stdout.toString()).toContain("Directory removed");
    expect(await pathExists(path.join(root, "empty"))).toBe(false);
  });

  it("rejects files and symlinks", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "file"), "x");
    await fs.symlink(path.join(root, "file"), path.join(root, "link"));
    await expect(runSpec(rmdirTool, { paths: ["file"] }, sb)).rejects.toMatchObject({
      code: "not-directory",
    });
    await expect(runSpec(rmdirTool, { paths: ["link"] }, sb)).rejects.toMatchObject({
      code: "not-directory",
    });
  });

  it("handles non-empty directories and the ignore option", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "full"));
    await fs.writeFile(path.join(root, "full/file"), "x");
    await expect(runSpec(rmdirTool, { paths: ["full"] }, sb)).rejects.toMatchObject({
      code: "not-empty",
    });
    const ignored = await runSpec(rmdirTool, { paths: ["full"], ignoreNonEmpty: true }, sb);
    expect(ignored.result.metadata).toMatchObject({ removed: [] });
  });

  it("removes parents up to the sandbox root", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "a/b/c"), { recursive: true });
    const result = await runSpec(rmdirTool, { paths: ["a/b/c"], parents: true }, sb);
    expect(result.result.metadata).toMatchObject({ removed: ["a/b/c", "a/b", "a"] });
    expect(await pathExists(path.join(root, "a"))).toBe(false);
  });

  it("stops parent removal at a non-empty parent", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "a/b"), { recursive: true });
    await fs.writeFile(path.join(root, "a/keep"), "x");
    const result = await runSpec(rmdirTool, { paths: ["a/b"], parents: true }, sb);
    expect(result.result.metadata).toMatchObject({ removed: ["a/b"] });
  });
});

describe("rm", () => {
  it("removes files and symlinks without touching link targets", async () => {
    const { root, sb } = await setup();
    const outside = await makeRoot();
    roots.push(outside);
    const target = path.join(outside, "target");
    await fs.writeFile(target, "x");
    await fs.writeFile(path.join(root, "file"), "x");
    await fs.symlink(target, path.join(root, "link"));
    await runSpec(rmTool, { paths: ["file", "link"], verbose: true }, sb);
    expect(await pathExists(path.join(root, "file"))).toBe(false);
    expect(await pathExists(path.join(root, "link"))).toBe(false);
    expect(await pathExists(target)).toBe(true);
  });

  it("requires recursion for directories but supports -d", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir"));
    await expect(runSpec(rmTool, { paths: ["dir"] }, sb)).rejects.toMatchObject({
      code: "not-file",
    });
    await runSpec(rmTool, { paths: ["dir"], dir: true }, sb);
    expect(await pathExists(path.join(root, "dir"))).toBe(false);
  });

  it("removes directory trees recursively", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "tree/nested"), { recursive: true });
    await fs.writeFile(path.join(root, "tree/nested/file"), "x");
    await runSpec(rmTool, { paths: ["tree"], recursive: true }, sb);
    expect(await pathExists(path.join(root, "tree"))).toBe(false);
  });

  it("ignores missing paths with force", async () => {
    const { sb } = await setup();
    const result = await runSpec(rmTool, { paths: ["missing"], force: true }, sb);
    expect(result.result.metadata).toMatchObject({ removed: [] });
  });

  it("reports missing paths without force", async () => {
    const { sb } = await setup();
    await expect(runSpec(rmTool, { paths: ["missing"] }, sb)).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("blocks the sandbox root even with force", async () => {
    const { sb } = await setup();
    await expect(runSpec(rmTool, { paths: ["."], recursive: true, force: true }, sb)).rejects.toMatchObject({
      code: "outside",
    });
  });
});
