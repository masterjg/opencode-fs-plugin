/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createTwoFilesPatch } from "diff";
import * as tar from "tar-stream";
import { Sandbox } from "../../src/core/sandbox.js";
import { cutTool } from "../../src/tools/cut.js";
import { diffTool } from "../../src/tools/diff.js";
import { duTool } from "../../src/tools/du.js";
import { findTool } from "../../src/tools/find.js";
import { gzipTool } from "../../src/tools/gzip.js";
import { lnTool } from "../../src/tools/ln.js";
import { mvTool } from "../../src/tools/mv.js";
import { pipeTool } from "../../src/tools/pipe.js";
import { readlinkTool } from "../../src/tools/readlink.js";
import { sedTool } from "../../src/tools/sed.js";
import { statTool } from "../../src/tools/stat.js";
import { tarTool } from "../../src/tools/tar.js";
import { touchTool } from "../../src/tools/touch.js";
import { trTool } from "../../src/tools/tr.js";
import { trashTool } from "../../src/tools/trash.js";
import { uniqTool } from "../../src/tools/uniq.js";
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

describe("diff edge cases", () => {
  it("covers directories, ignores, binary and brief modes", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "left/sub"), { recursive: true });
    await fs.mkdir(path.join(root, "right/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "left/sub/a"), "one\n");
    await fs.writeFile(path.join(root, "right/sub/a"), "two\n");
    await fs.mkdir(path.join(root, "left/sub/mixed"));
    await fs.writeFile(path.join(root, "right/sub/mixed"), "not a dir");
    const recursive = await runSpec(diffTool, { left: "left", right: "right", recursive: true }, sb);
    expect(recursive.result.stdout.toString()).toContain("left/sub/a");
    expect(recursive.result.stdout.toString()).toContain("directory");
    await expect(runSpec(diffTool, { left: "left", right: "right" }, sb)).resolves.toBeTruthy();
    const ignored = await runSpec(
      diffTool,
      { left: "left/sub/a", right: "right/sub/a", ignoreWhitespace: true },
      sb,
    );
    expect(ignored.result.exitCode).toBe(1);
    await fs.writeFile(path.join(root, "case1"), "ABC");
    await fs.writeFile(path.join(root, "case2"), "abc");
    const folded = await runSpec(diffTool, { left: "case1", right: "case2", ignoreCase: true }, sb);
    expect(folded.result.exitCode).toBe(0);
    await fs.writeFile(path.join(root, "bin1"), Buffer.from([0, 1]));
    await fs.writeFile(path.join(root, "bin2"), Buffer.from([0, 2]));
    const binary = await runSpec(diffTool, { left: "bin1", right: "bin2" }, sb);
    expect(binary.result.stdout.toString()).toContain("Binary files");
    await fs.writeFile(path.join(root, "single"), "x");
    const mixed = await runSpec(diffTool, { left: "left", right: "single", recursive: true }, sb);
    expect(mixed.result.stdout.toString()).toContain("directory");
  });

  it("covers excluded directory names", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "a"));
    await fs.mkdir(path.join(root, "b"));
    await fs.writeFile(path.join(root, "a/skip.log"), "a");
    await fs.writeFile(path.join(root, "b/skip.log"), "b");
    const result = await runSpec(diffTool, { left: "a", right: "b", recursive: true, exclude: ["*.log"] }, sb);
    expect(result.result.stdout.toString()).toBe("");
  });
});

describe("mv and trash cross-device paths", () => {
  it("falls back to copy-and-remove across filesystems", async () => {
    const shm = await fs.mkdtemp("/dev/shm/fs-plugin-test-");
    roots.push(shm);
    const sb = await Sandbox.create(shm);
    await fs.writeFile(path.join(shm, "a"), "a");
    const destination = path.join(os.tmpdir(), `fs-plugin-moved-${Date.now()}`);
    roots.push(destination);
    await runSpec(mvTool, { sources: ["a"], destination }, sb);
    expect(await pathExists(path.join(shm, "a"))).toBe(false);
    expect(await fs.readFile(destination, "utf8")).toBe("a");
    await fs.rm(destination, { force: true });
  });

  it("reports cross-device trash failures", async () => {
    const shm = await fs.mkdtemp("/dev/shm/fs-plugin-test-");
    roots.push(shm);
    const sb = await Sandbox.create(shm);
    process.env.XDG_DATA_HOME = path.join(os.tmpdir(), `fs-plugin-trash-${Date.now()}`);
    roots.push(process.env.XDG_DATA_HOME);
    await fs.writeFile(path.join(shm, "a"), "a");
    await expect(runSpec(trashTool, { paths: ["a"] }, sb)).rejects.toMatchObject({
      code: "cross-device",
    });
  });
});

describe("archive edge cases", () => {
  it("covers tar verbose, exclude, strip and symlinks", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/sub/a"), "a");
    await fs.writeFile(path.join(root, "dir/sub/skip.log"), "x");
    await fs.symlink("sub/a", path.join(root, "dir/link"));
    const created = await runSpec(
      tarTool,
      { mode: "create", archive: "a.tar", paths: ["dir"], exclude: ["*.log"], verbose: true },
      sb,
    );
    expect(created.result.stdout.toString()).toContain("dir/sub/a");
    const list = await runSpec(tarTool, { mode: "list", archive: "a.tar" }, sb);
    expect(list.result.stdout.toString()).not.toContain("skip.log");
    await fs.mkdir(path.join(root, "out"));
    await runSpec(
      tarTool,
      { mode: "extract", archive: "a.tar", directory: "out", stripComponents: 1 },
      sb,
    );
    expect(await pathExists(path.join(root, "out/sub/a"))).toBe(true);
    expect((await fs.lstat(path.join(root, "out/link"))).isSymbolicLink()).toBe(true);
  });

  it("rejects tar path traversal and symlink escapes", async () => {
    const { root, sb } = await setup();
    const pack = tar.pack();
    pack.entry({ name: "../evil" }, "x");
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of pack as AsyncIterable<Buffer>) chunks.push(chunk);
    await fs.writeFile(path.join(root, "evil.tar"), Buffer.concat(chunks));
    await expect(runSpec(tarTool, { mode: "extract", archive: "evil.tar" }, sb)).rejects.toMatchObject({
      code: "archive",
    });

    const linkPack = tar.pack();
    linkPack.entry({ name: "link", type: "symlink", linkname: "/etc/passwd" });
    linkPack.finalize();
    const linkChunks: Buffer[] = [];
    for await (const chunk of linkPack as AsyncIterable<Buffer>) linkChunks.push(chunk);
    await fs.writeFile(path.join(root, "link.tar"), Buffer.concat(linkChunks));
    await expect(runSpec(tarTool, { mode: "extract", archive: "link.tar" }, sb)).rejects.toMatchObject({
      code: "archive",
    });
  });

  it("covers zip symlinks and lazy list extraction", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir"));
    await fs.writeFile(path.join(root, "dir/a"), "a");
    await fs.symlink("a", path.join(root, "dir/link"));
    await runSpec(zipTool, { archive: "a.zip", paths: ["dir"] }, sb);
    const list = await runSpec(unzipTool, { archive: "a.zip", mode: "list" }, sb);
    expect(list.result.stdout.toString()).toContain("dir/link");
    await fs.mkdir(path.join(root, "out"));
    await runSpec(unzipTool, { archive: "a.zip", directory: "out" }, sb);
    expect((await fs.lstat(path.join(root, "out/dir/link"))).isSymbolicLink()).toBe(true);
    await fs.writeFile(path.join(root, "bad.zip"), "not zip");
    await expect(runSpec(unzipTool, { archive: "bad.zip", mode: "list" }, sb)).rejects.toBeTruthy();
  });
});

describe("misc edge cases", () => {
  it("covers touch timestamp variants and stat unknown tokens", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await runSpec(touchTool, { paths: ["a"], timestamp: "0102030405" }, sb);
    await runSpec(touchTool, { paths: ["a"], timestamp: "200102030405.06" }, sb);
    const stat = await runSpec(statTool, { paths: ["a"], format: "%q" }, sb);
    expect(stat.result.stdout.toString()).toContain("%q");
  });

  it("covers mv, ln, readlink, pipe, sed and uniq errors", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await expect(runSpec(lnTool, { sources: ["a"], destination: "a" }, sb)).rejects.toMatchObject({
      code: "exists",
    });
    await expect(runSpec(lnTool, { sources: ["missing"], destination: "x" }, sb)).rejects.toMatchObject({
      code: "not-found",
    });
    await fs.symlink("missing", path.join(root, "broken"));
    await expect(runSpec(readlinkTool, { paths: ["broken"], mode: "existing" }, sb)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(runSpec(pipeTool, { stages: [{ tool: "hash" }] }, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(sedTool, { script: "s/a/b" }, sb)).rejects.toBeTruthy();
    await expect(runSpec(uniqTool, { repeated: true }, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("covers cut, tr, gzip and du branches", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await expect(runSpec(cutTool, { fields: "" }, sb, { stdin: bufferStream("x") })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(runSpec(trTool, { set1: "\\" }, sb, { stdin: bufferStream("x") })).rejects.toMatchObject({
      code: "invalid",
    });
    await runSpec(gzipTool, { paths: ["a"], stdout: true, force: true }, sb);
    const du = await runSpec(duTool, { paths: ["a"], total: true, all: true }, sb);
    expect(du.result.stdout.toString()).toContain("total");
    const find = await runSpec(findTool, { paths: ["a"], type: "f" }, sb);
    expect(find.result.stdout.toString()).toContain("a");
  });
});
