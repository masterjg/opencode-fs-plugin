/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { findTool } from "../../src/tools/find.js";
import { makeRoot, pathExists, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
});

async function setup(): Promise<{ root: string; dir: string; sb: Sandbox }> {
  const root = await makeRoot("fs-find-actions-");
  roots.push(root);
  const dir = path.join(root, "dir");
  await fs.mkdir(path.join(dir, "sub"), { recursive: true });
  await fs.writeFile(path.join(dir, "a.txt"), "a\n");
  await fs.writeFile(path.join(dir, "b.txt"), "b\n");
  await fs.writeFile(path.join(dir, "c.log"), "c\n");
  await fs.writeFile(path.join(dir, "sub", "nested.txt"), "nested\n");
  return { root, dir, sb: await Sandbox.create(root) };
}

describe("find actions", () => {
  it("deletes matching files and asserts fs_rm", async () => {
    const { dir, sb } = await setup();
    const result = await runSpec(findTool, { paths: ["dir"], name: "*.txt", action: "delete" }, sb);
    expect(result.result.metadata).toMatchObject({ found: 3, action: "delete" });
    const removed = result.result.metadata?.removed as string[];
    expect(removed).toHaveLength(3);
    expect(removed.map((entry) => path.basename(entry)).sort()).toEqual(["a.txt", "b.txt", "nested.txt"]);
    expect(await pathExists(path.join(dir, "a.txt"))).toBe(false);
    expect(await pathExists(path.join(dir, "sub", "nested.txt"))).toBe(false);
    expect(await pathExists(path.join(dir, "c.log"))).toBe(true);
    expect(result.requests.some((request) => request.action === "fs_rm")).toBe(true);
  });

  it("requires recursive for a matched directory", async () => {
    const { dir, sb } = await setup();
    await expect(runSpec(findTool, { paths: ["dir"], name: "sub", action: "delete" }, sb)).rejects.toMatchObject({
      code: "not-file",
    });
    expect(await pathExists(path.join(dir, "sub"))).toBe(true);
  });

  it("deletes a matched directory recursively", async () => {
    const { dir, sb } = await setup();
    const result = await runSpec(
      findTool,
      { paths: ["dir"], name: "sub", action: "delete", recursive: true },
      sb,
    );
    expect(result.result.metadata).toMatchObject({ found: 1, action: "delete" });
    expect(await pathExists(path.join(dir, "sub"))).toBe(false);
  });

  it("never deletes the starting directory itself", async () => {
    const { dir, sb } = await setup();
    const result = await runSpec(findTool, { paths: ["dir"], action: "delete", recursive: true }, sb);
    expect(result.result.metadata).toMatchObject({ action: "delete" });
    expect(await pathExists(dir)).toBe(true);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("can delete a starting file", async () => {
    const { root, sb } = await setup();
    const file = path.join(root, "single.txt");
    await fs.writeFile(file, "one\n");
    await runSpec(findTool, { paths: ["single.txt"], name: "single.txt", action: "delete" }, sb);
    expect(await pathExists(file)).toBe(false);
  });

  it("trashes matching files and asserts fs_trash", async () => {
    const { root, dir, sb } = await setup();
    process.env.XDG_DATA_HOME = path.join(root, "data");
    const result = await runSpec(findTool, { paths: ["dir"], name: "a.txt", action: "trash" }, sb);
    expect(result.result.metadata).toMatchObject({ found: 1, action: "trash" });
    const trashed = result.result.metadata?.trashed as string[];
    expect(trashed).toHaveLength(1);
    expect(path.basename(trashed[0]!)).toBe("a.txt");
    expect(await pathExists(path.join(dir, "a.txt"))).toBe(false);
    expect(await fs.readdir(path.join(root, "data/Trash/files"))).toEqual(["a.txt"]);
    expect(result.requests.some((request) => request.action === "fs_trash")).toBe(true);
  });

  it("returns empty success when nothing matches", async () => {
    const { sb } = await setup();
    const deleted = await runSpec(findTool, { paths: ["dir"], name: "none", action: "delete" }, sb);
    expect(deleted.result.metadata).toMatchObject({ found: 0, action: "delete", removed: [] });
    const trashed = await runSpec(findTool, { paths: ["dir"], name: "none", action: "trash" }, sb);
    expect(trashed.result.metadata).toMatchObject({ found: 0, action: "trash", trashed: [] });
  });

  it("rejects incompatible action combinations", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(findTool, { paths: ["dir"], action: "delete", printf: "%p\n" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(findTool, { paths: ["dir"], action: "delete", print0: true }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(findTool, { paths: ["dir"], recursive: true }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});
