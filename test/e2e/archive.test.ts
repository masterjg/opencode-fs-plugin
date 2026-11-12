/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { diffTool } from "../../src/tools/diff.js";
import { gunzipTool, gzipTool } from "../../src/tools/gzip.js";
import { mktempTool } from "../../src/tools/mktemp.js";
import { tarTool } from "../../src/tools/tar.js";
import { trashTool } from "../../src/tools/trash.js";
import { unzipTool, zipTool } from "../../src/tools/zip.js";
import { bufferStream, makeRoot, pathExists, runSpec } from "../helpers.js";

const roots: string[] = [];
const originalDataHome = process.env.XDG_DATA_HOME;

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
});

async function setup(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot();
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

describe("gzip and gunzip", () => {
  it("round-trips files and stdin", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "hello");
    await runSpec(gzipTool, { paths: ["a"] }, sb);
    expect(await pathExists(path.join(root, "a"))).toBe(false);
    expect(await pathExists(path.join(root, "a.gz"))).toBe(true);
    await runSpec(gunzipTool, { paths: ["a.gz"] }, sb);
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("hello");
    expect(await pathExists(path.join(root, "a.gz"))).toBe(false);

    const compressed = await runSpec(gzipTool, { stdout: true }, sb, { stdin: bufferStream("hello") });
    expect(compressed.result.stdout.length).toBeGreaterThan(0);
    const decompressed = await runSpec(gunzipTool, { stdout: true }, sb, { stdin: bufferStream(compressed.result.stdout) });
    expect(decompressed.result.stdout.toString()).toBe("hello");
  });

  it("keeps inputs with keep and refuses existing output", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "hello");
    await runSpec(gzipTool, { paths: ["a"], keep: true }, sb);
    expect(await pathExists(path.join(root, "a"))).toBe(true);
    await expect(runSpec(gzipTool, { paths: ["a"] }, sb)).rejects.toMatchObject({ code: "exists" });
    await runSpec(gzipTool, { paths: ["a"], force: true, stdout: true }, sb);
    await expect(runSpec(gunzipTool, { paths: ["a"] }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("tar", () => {
  it("creates, lists and extracts tar archives", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/a"), "a");
    await fs.writeFile(path.join(root, "dir/sub/b"), "b");
    await runSpec(tarTool, { mode: "create", archive: "a.tar", paths: ["dir"] }, sb);
    const list = await runSpec(tarTool, { mode: "list", archive: "a.tar" }, sb);
    expect(list.result.stdout.toString()).toContain("dir/sub/b");
    await fs.mkdir(path.join(root, "out"));
    await runSpec(tarTool, { mode: "extract", archive: "a.tar", directory: "out" }, sb);
    expect(await fs.readFile(path.join(root, "out/dir/sub/b"), "utf8")).toBe("b");
  });

  it("creates and extracts gzipped archives with strip-components", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await runSpec(tarTool, { mode: "create", archive: "a.tgz", paths: ["a"], gzip: true }, sb);
    const list = await runSpec(tarTool, { mode: "list", archive: "a.tgz" }, sb);
    expect(list.result.stdout.toString()).toContain("a");
    await fs.mkdir(path.join(root, "out"));
    await runSpec(tarTool, { mode: "extract", archive: "a.tgz", directory: "out" }, sb);
    expect(await fs.readFile(path.join(root, "out/a"), "utf8")).toBe("a");
    await expect(runSpec(tarTool, { mode: "create", archive: "x.tar" }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("zip and unzip", () => {
  it("creates, lists and extracts zip archives", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/a"), "a");
    await fs.writeFile(path.join(root, "dir/sub/b"), "b");
    await runSpec(zipTool, { archive: "a.zip", paths: ["dir"] }, sb);
    const list = await runSpec(unzipTool, { archive: "a.zip", mode: "list" }, sb);
    expect(list.result.stdout.toString()).toContain("dir/sub/b");
    await fs.mkdir(path.join(root, "out"));
    await runSpec(unzipTool, { archive: "a.zip", directory: "out" }, sb);
    expect(await fs.readFile(path.join(root, "out/dir/sub/b"), "utf8")).toBe("b");
  });

  it("honors overwrite flags", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await runSpec(zipTool, { archive: "a.zip", paths: ["a"] }, sb);
    await fs.mkdir(path.join(root, "out"));
    await fs.writeFile(path.join(root, "out/a"), "old");
    await expect(runSpec(unzipTool, { archive: "a.zip", directory: "out" }, sb)).rejects.toMatchObject({
      code: "exists",
    });
    await runSpec(unzipTool, { archive: "a.zip", directory: "out", overwrite: true }, sb);
    expect(await fs.readFile(path.join(root, "out/a"), "utf8")).toBe("a");
    await runSpec(unzipTool, { archive: "a.zip", directory: "out", noOverwrite: true }, sb);
  });
});

describe("diff", () => {
  it("compares files and directories", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "one\n");
    await fs.writeFile(path.join(root, "b"), "two\n");
    const diff = await runSpec(diffTool, { left: "a", right: "b" }, sb);
    expect(diff.result.exitCode).toBe(1);
    expect(diff.result.stdout.toString()).toContain("-one");
    expect(diff.result.stdout.toString()).toContain("+two");
    const brief = await runSpec(diffTool, { left: "a", right: "b", brief: true }, sb);
    expect(brief.result.stdout.toString()).toContain("differ");
    await fs.writeFile(path.join(root, "same"), "one\n");
    const same = await runSpec(diffTool, { left: "a", right: "same" }, sb);
    expect(same.result.exitCode).toBe(0);
    await fs.mkdir(path.join(root, "left"));
    await fs.mkdir(path.join(root, "right"));
    await fs.writeFile(path.join(root, "left/x"), "x");
    const dirs = await runSpec(diffTool, { left: "left", right: "right", recursive: true }, sb);
    expect(dirs.result.stdout.toString()).toContain("Only in");
    await expect(runSpec(diffTool, { left: "left", right: "a", recursive: true }, sb)).resolves.toBeTruthy();
  });
});

describe("mktemp and trash", () => {
  it("creates unique files and directories", async () => {
    const { root, sb } = await setup();
    const file = await runSpec(mktempTool, { tmpdir: root, template: "x.XXX" }, sb);
    const filePath = file.result.stdout.toString().trim();
    expect(await pathExists(filePath)).toBe(true);
    const dir = await runSpec(mktempTool, { tmpdir: root, template: "d.XXX", directory: true, suffix: ".suf" }, sb);
    const dirPath = dir.result.stdout.toString().trim();
    expect(dirPath.endsWith(".suf")).toBe(true);
    expect(await pathExists(dirPath)).toBe(true);
    await expect(runSpec(mktempTool, { tmpdir: root, template: "no-x" }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("moves paths to the XDG trash", async () => {
    const { root, sb } = await setup();
    process.env.XDG_DATA_HOME = path.join(root, "data");
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.writeFile(path.join(root, "b"), "b");
    const result = await runSpec(trashTool, { paths: ["a", "b"] }, sb);
    expect(result.result.metadata).toMatchObject({ trashed: ["a", "b"] });
    expect(await pathExists(path.join(root, "a"))).toBe(false);
    const trashFiles = await fs.readdir(path.join(root, "data/Trash/files"));
    expect(trashFiles.sort()).toEqual(["a", "b"]);
    const info = await fs.readdir(path.join(root, "data/Trash/info"));
    expect(info).toHaveLength(2);
  });
});
