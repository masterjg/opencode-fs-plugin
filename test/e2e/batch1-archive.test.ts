/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { arTool } from "../../src/tools/ar.js";
import { cpioTool } from "../../src/tools/cpio.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-batch1-archive-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

describe("cpio", () => {
  it("creates, lists and extracts trees", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "tree/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "tree/a"), "a\n");
    await fs.writeFile(path.join(root, "tree/sub/b"), "b\n");
    await fs.symlink("a", path.join(root, "tree/link"));

    const created = await runSpec(cpioTool, {
      mode: "create",
      archive: "tree.cpio",
      paths: ["tree"],
      directory: root,
      verbose: true,
    }, sb);
    expect(created.result.stdout.toString()).toContain("tree/a");

    const listed = await runSpec(cpioTool, { mode: "list", archive: "tree.cpio" }, sb);
    expect(listed.result.stdout.toString()).toContain("tree/sub/b");

    const extracted = await runSpec(cpioTool, { mode: "extract", archive: "tree.cpio", directory: "out" }, sb);
    expect(extracted.result.metadata.extracted).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(root, "out/tree/a"), "utf8")).toBe("a\n");
    expect((await fs.lstat(path.join(root, "out/tree/link"))).isSymbolicLink()).toBe(true);

    const filtered = await runSpec(cpioTool, { mode: "list", archive: "tree.cpio", members: ["tree/a"] }, sb);
    expect(filtered.result.stdout.toString()).toBe("tree/a\n");
  });

  it("accepts stream input and rejects unsafe or corrupt archives", async () => {
    const { sb } = await setup();
    const stream = await runSpec(cpioTool, {
      mode: "create",
      archive: "stream.cpio",
      input: "hello",
      member: "hello.txt",
      verbose: true,
    }, sb);
    expect(stream.result.stdout.toString()).toContain("hello.txt");
    const list = await runSpec(cpioTool, { mode: "list", archive: "stream.cpio" }, sb);
    expect(list.result.stdout.toString()).toBe("hello.txt\n");

    await expect(runSpec(cpioTool, { mode: "create", archive: "bad.cpio" }, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(cpioTool, { mode: "create", archive: "bad.cpio", input: "x", member: "../evil" }, sb)).rejects.toMatchObject({ code: "archive" });
  });
});

describe("ar", () => {
  it("creates, lists and extracts members", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a.txt"), "alpha\n");
    await fs.writeFile(path.join(root, "b.txt"), "beta\n");
    await runSpec(arTool, { mode: "create", archive: "lib.a", paths: ["a.txt", "b.txt"] }, sb);
    const list = await runSpec(arTool, { mode: "list", archive: "lib.a" }, sb);
    expect(list.result.stdout.toString()).toBe("a.txt\nb.txt\n");
    const extracted = await runSpec(arTool, { mode: "extract", archive: "lib.a", directory: "out" }, sb);
    expect(extracted.result.metadata.extracted).toBe(2);
    expect(await fs.readFile(path.join(root, "out/a.txt"), "utf8")).toBe("alpha\n");
    const filtered = await runSpec(arTool, { mode: "list", archive: "lib.a", members: ["b.txt"] }, sb);
    expect(filtered.result.stdout.toString()).toBe("b.txt\n");
    const filteredExtract = await runSpec(arTool, { mode: "extract", archive: "lib.a", directory: "one", members: ["a.txt"] }, sb);
    expect(filteredExtract.result.metadata.extracted).toBe(1);
  });

  it("rejects long names, directories and corrupt archives", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "this-name-is-way-too-long-for-ar.txt"), "x");
    await expect(runSpec(arTool, {
      mode: "create",
      archive: "bad.a",
      paths: ["this-name-is-way-too-long-for-ar.txt"],
    }, sb)).rejects.toMatchObject({ code: "invalid" });
    await fs.mkdir(path.join(root, "dir"));
    await expect(runSpec(arTool, { mode: "create", archive: "bad.a", paths: ["dir"] }, sb)).rejects.toMatchObject({ code: "not-file" });
    await expect(runSpec(arTool, { mode: "create", archive: "bad.a" }, sb)).rejects.toMatchObject({ code: "invalid" });

    await fs.writeFile(path.join(root, "plain"), "not an ar");
    await expect(runSpec(arTool, { mode: "list", archive: "plain" }, sb)).rejects.toMatchObject({ code: "archive" });
    await fs.writeFile(path.join(root, "corrupt"), `!<arch>\n${"x".repeat(60)}`);
    await expect(runSpec(arTool, { mode: "list", archive: "corrupt" }, sb)).rejects.toMatchObject({ code: "archive" });
  });
});
