/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { cpTool } from "../../src/tools/cp.js";
import { mvTool } from "../../src/tools/mv.js";
import { lsTool } from "../../src/tools/ls.js";
import { statTool } from "../../src/tools/stat.js";
import { touchTool } from "../../src/tools/touch.js";
import { truncateTool } from "../../src/tools/truncate.js";
import { lnTool } from "../../src/tools/ln.js";
import { readlinkTool } from "../../src/tools/readlink.js";
import { chmodTool } from "../../src/tools/chmod.js";
import { hashTool } from "../../src/tools/hash.js";
import { duTool } from "../../src/tools/du.js";
import { dfTool } from "../../src/tools/df.js";
import { findTool } from "../../src/tools/find.js";
import { bufferStream, makeRoot, pathExists, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; sb: Sandbox; outside: string }> {
  const root = await makeRoot();
  const outside = await makeRoot("fs-plugin-outside-");
  roots.push(root, outside);
  return { root, sb: await Sandbox.create(root), outside };
}

describe("cp and mv", () => {
  it("copies files and directories, preserving mode", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a.txt"), "alpha");
    await fs.chmod(path.join(root, "a.txt"), 0o640);
    await runSpec(cpTool, { sources: ["a.txt"], destination: "b.txt", preserve: true }, sb);
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("alpha");
    expect((await fs.stat(path.join(root, "b.txt"))).mode & 0o777).toBe(0o640);

    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/sub/file"), "x");
    await runSpec(cpTool, { sources: ["dir"], destination: "copy", recursive: true }, sb);
    expect(await fs.readFile(path.join(root, "copy/sub/file"), "utf8")).toBe("x");
  });

  it("copies multiple sources into a directory", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.writeFile(path.join(root, "b"), "b");
    await fs.mkdir(path.join(root, "dest"));
    await runSpec(cpTool, { sources: ["a", "b"], destination: "dest" }, sb);
    expect(await pathExists(path.join(root, "dest/a"))).toBe(true);
    expect(await pathExists(path.join(root, "dest/b"))).toBe(true);
  });

  it("rejects directory copies without recursion and self-copy", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir"));
    await expect(runSpec(cpTool, { sources: ["dir"], destination: "x" }, sb)).rejects.toMatchObject({
      code: "not-file",
    });
    await expect(
      runSpec(cpTool, { sources: ["dir"], destination: "dir/inner", recursive: true }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("honors noClobber and archive symlinks", async () => {
    const { root, sb, outside } = await setup();
    await fs.writeFile(path.join(root, "a"), "new");
    await fs.writeFile(path.join(root, "b"), "old");
    await runSpec(cpTool, { sources: ["a"], destination: "b", noClobber: true }, sb);
    expect(await fs.readFile(path.join(root, "b"), "utf8")).toBe("old");
    await fs.symlink(outside, path.join(root, "link"));
    await runSpec(cpTool, { sources: ["link"], destination: "link-copy", archive: true }, sb);
    expect((await fs.lstat(path.join(root, "link-copy"))).isSymbolicLink()).toBe(true);
  });

  it("moves files and directories, including multiple sources", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.mkdir(path.join(root, "dir"));
    await runSpec(mvTool, { sources: ["a"], destination: "b" }, sb);
    expect(await pathExists(path.join(root, "a"))).toBe(false);
    expect(await fs.readFile(path.join(root, "b"), "utf8")).toBe("a");
    await fs.mkdir(path.join(root, "dest"));
    await fs.writeFile(path.join(root, "c"), "c");
    await runSpec(mvTool, { sources: ["b", "c"], destination: "dest" }, sb);
    expect(await pathExists(path.join(root, "dest/b"))).toBe(true);
    expect(await pathExists(path.join(root, "dest/c"))).toBe(true);
    await runSpec(mvTool, { sources: ["dir"], destination: "renamed" }, sb);
    expect(await pathExists(path.join(root, "renamed"))).toBe(true);
  });

  it("refuses moving the sandbox root", async () => {
    const { sb } = await setup();
    await expect(runSpec(mvTool, { sources: ["."], destination: "x" }, sb)).rejects.toMatchObject({
      code: "outside",
    });
  });
});

describe("ls and stat", () => {
  it("lists names, hidden entries, long form and recursive output", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "visible"), "x");
    await fs.writeFile(path.join(root, ".hidden"), "x");
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "sub/child"), "x");

    const plain = await runSpec(lsTool, {}, sb);
    expect(plain.result.stdout.toString()).toContain("visible");
    expect(plain.result.stdout.toString()).not.toContain(".hidden");

    const all = await runSpec(lsTool, { all: true, long: true, human: true, classify: true }, sb);
    expect(all.result.stdout.toString()).toContain(".hidden");
    expect(all.result.stdout.toString()).toContain("total");
    expect(all.result.stdout.toString()).toContain("sub/");

    const recursive = await runSpec(lsTool, { recursive: true }, sb);
    expect(recursive.result.stdout.toString()).toContain("child");
  });

  it("supports directory, inode, sort and one-per-line options", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "big"), Buffer.alloc(100));
    await fs.writeFile(path.join(root, "small"), "x");
    const bySize = await runSpec(lsTool, { sortBy: "size", reverse: true, inode: true, onePerLine: true }, sb);
    expect(bySize.result.stdout.toString().split("\n")[0]).toContain("big");
    const directory = await runSpec(lsTool, { paths: ["."], directory: true, long: true }, sb);
    expect(directory.result.stdout.toString()).toContain(".");
    const file = await runSpec(lsTool, { paths: ["big"], long: true }, sb);
    expect(file.result.stdout.toString()).toContain("big");
  });

  it("formats default and custom stat output", async () => {
    const { root, sb } = await setup();
    const file = path.join(root, "a");
    await fs.writeFile(file, "hello");
    const normal = await runSpec(statTool, { paths: ["a"] }, sb);
    expect(normal.result.stdout.toString()).toContain("regular file");
    expect(normal.result.stdout.toString()).toContain("Size: 5");
    const custom = await runSpec(statTool, { paths: ["a"], format: "%n|%s|%F|%a|%U|%G|%i|%h|%x|%X|%y|%Y|%z|%Z|%t|%T|%L|%%|%n|%t|%\\" }, sb);
    expect(custom.result.stdout.toString()).toContain("a|5|regular file");
    expect(custom.result.stdout.toString()).toContain("%");
    const fsInfo = await runSpec(statTool, { paths: ["a"], filesystem: true }, sb);
    expect(fsInfo.result.stdout.toString()).toContain("Block size");
  });
});

describe("touch and truncate", () => {
  it("creates files and updates times", async () => {
    const { root, sb } = await setup();
    await runSpec(touchTool, { paths: ["new"], date: "2020-01-02T03:04:05Z" }, sb);
    const stats = await fs.stat(path.join(root, "new"));
    expect(stats.mtime.toISOString()).toBe("2020-01-02T03:04:05.000Z");
    await runSpec(touchTool, { paths: ["new"], accessOnly: true }, sb);
    await runSpec(touchTool, { paths: ["new"], modifyOnly: true, reference: "new" }, sb);
    await runSpec(touchTool, { paths: ["missing"], noCreate: true }, sb);
    expect(await pathExists(path.join(root, "missing"))).toBe(false);
    await runSpec(touchTool, { paths: ["new"], timestamp: "200102030405.06" }, sb);
    await expect(runSpec(touchTool, { paths: ["x"], date: "nope" }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(runSpec(touchTool, { paths: ["x"], timestamp: "bad" }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("resizes files absolutely, relatively and by reference", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "12345");
    await runSpec(truncateTool, { paths: ["a"], size: "2" }, sb);
    expect((await fs.stat(path.join(root, "a"))).size).toBe(2);
    await runSpec(truncateTool, { paths: ["a"], size: "+3" }, sb);
    expect((await fs.stat(path.join(root, "a"))).size).toBe(5);
    await runSpec(truncateTool, { paths: ["a"], size: "-2" }, sb);
    expect((await fs.stat(path.join(root, "a"))).size).toBe(3);
    await fs.writeFile(path.join(root, "ref"), "1234567890");
    await runSpec(truncateTool, { paths: ["a"], reference: "ref" }, sb);
    expect((await fs.stat(path.join(root, "a"))).size).toBe(10);
    await runSpec(truncateTool, { paths: ["missing"], noCreate: true, size: "1" }, sb);
    expect(await pathExists(path.join(root, "missing"))).toBe(false);
    await expect(runSpec(truncateTool, { paths: ["a"] }, sb)).rejects.toMatchObject({ code: "invalid" });
    await fs.writeFile(path.join(root, "small"), "x");
    await expect(runSpec(truncateTool, { paths: ["small"], size: "-2" }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("links and chmod", () => {
  it("creates and reads symbolic and hard links", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "target"), "x");
    await runSpec(lnTool, { sources: ["target"], destination: "sym", symbolic: true }, sb);
    expect((await fs.lstat(path.join(root, "sym"))).isSymbolicLink()).toBe(true);
    const raw = await runSpec(readlinkTool, { paths: ["sym"] }, sb);
    expect(raw.result.stdout.toString()).toContain("target");
    const canonical = await runSpec(readlinkTool, { paths: ["sym"], mode: "canonical" }, sb);
    expect(canonical.result.stdout.toString()).toContain(path.join(root, "sym"));
    const existing = await runSpec(readlinkTool, { paths: ["sym"], mode: "existing", noNewline: true }, sb);
    expect(existing.result.stdout.toString()).toBe(path.join(root, "target"));
    const missing = await runSpec(readlinkTool, { paths: ["nope"], mode: "missing" }, sb);
    expect(missing.result.stdout.toString()).toContain("nope");
    await runSpec(lnTool, { sources: ["target"], destination: "hard" }, sb);
    expect((await fs.lstat(path.join(root, "hard"))).ino).toBe((await fs.lstat(path.join(root, "target"))).ino);
    await runSpec(lnTool, { sources: ["target"], destination: "rel", symbolic: true, relative: true }, sb);
    expect((await fs.readlink(path.join(root, "rel")))).toBe("target");
    await runSpec(lnTool, { sources: ["target"], destination: "rel", symbolic: true, force: true }, sb);
    await expect(runSpec(readlinkTool, { paths: ["target"] }, sb)).rejects.toMatchObject({ code: "not-file" });
  });

  it("changes modes recursively and by reference", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "x");
    await fs.mkdir(path.join(root, "dir"));
    await fs.writeFile(path.join(root, "dir/b"), "x");
    await runSpec(chmodTool, { paths: ["a"], mode: "600", changes: true }, sb);
    expect((await fs.stat(path.join(root, "a"))).mode & 0o777).toBe(0o600);
    await runSpec(chmodTool, { paths: ["dir"], mode: "u=rwx,go=rx", recursive: true, verbose: true }, sb);
    expect((await fs.stat(path.join(root, "dir/b"))).mode & 0o777).toBe(0o755);
    await runSpec(chmodTool, { paths: ["dir/b"], reference: "a" }, sb);
    expect((await fs.stat(path.join(root, "dir/b"))).mode & 0o777).toBe(0o600);
    await expect(runSpec(chmodTool, { paths: ["a"] }, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(chmodTool, { paths: ["a"], mode: "bad" }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("hash, du, df and find", () => {
  it("hashes files, multiple files and stdin", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "hello");
    const single = await runSpec(hashTool, { files: ["a"] }, sb);
    expect(single.result.stdout.toString()).toMatch(/^2cf24dba/);
    const tagged = await runSpec(hashTool, { files: ["a"], algorithm: "md5", tag: true }, sb);
    expect(tagged.result.stdout.toString()).toContain("MD5 (a) =");
    const stdin = await runSpec(hashTool, { algorithm: "sha1" }, sb, { stdin: bufferStream("hello") });
    expect(stdin.result.stdout.toString()).toContain(" -");
    await expect(runSpec(hashTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("reports disk usage and filesystem space", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir"));
    await fs.writeFile(path.join(root, "dir/a"), "12345");
    await fs.writeFile(path.join(root, "dir/b"), "12345");
    const summary = await runSpec(duTool, { paths: ["dir"], summarize: true, human: true }, sb);
    expect(summary.result.stdout.toString()).toContain("dir");
    const all = await runSpec(duTool, { paths: ["dir"], all: true, total: true }, sb);
    expect(all.result.stdout.toString()).toContain("total");
    const df = await runSpec(dfTool, { human: true, printType: true }, sb);
    expect(df.result.stdout.toString()).toContain("Filesystem");
    const inodes = await runSpec(dfTool, { inodes: true }, sb);
    expect(inodes.result.stdout.toString()).toContain("Inodes");
  });

  it("finds by name, type, size, time, depth, perm and newer", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/a.txt"), "12345");
    await fs.writeFile(path.join(root, "dir/b.log"), "x");
    const old = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(path.join(root, "dir/a.txt"), old, old);
    const byName = await runSpec(findTool, { paths: ["dir"], name: "*.txt" }, sb);
    expect(byName.result.stdout.toString()).toContain("a.txt");
    const byType = await runSpec(findTool, { paths: ["dir"], type: "d" }, sb);
    expect(byType.result.stdout.toString()).toContain("dir/sub");
    const bySize = await runSpec(findTool, { paths: ["dir"], size: "+1" }, sb);
    expect(bySize.result.stdout.toString()).toContain("a.txt");
    const byTime = await runSpec(findTool, { paths: ["dir"], mtime: "+1" }, sb);
    expect(byTime.result.stdout.toString()).toContain("a.txt");
    const byDepth = await runSpec(findTool, { paths: ["dir"], maxDepth: 0 }, sb);
    expect(byDepth.result.stdout.toString()).not.toContain("a.txt");
    const byPerm = await runSpec(findTool, { paths: ["dir"], perm: "644" }, sb);
    expect(byPerm.result.stdout.toString()).toContain("a.txt");
    const byNewer = await runSpec(findTool, { paths: ["dir"], newer: "dir/a.txt" }, sb);
    expect(byNewer.result.stdout.toString()).toContain("b.log");
    const print0 = await runSpec(findTool, { paths: ["dir"], name: "*.txt", print0: true }, sb);
    expect(print0.result.stdout.toString()).toContain("\0");
    const empty = await runSpec(findTool, { paths: ["dir"], empty: true }, sb);
    expect(empty.result.stdout.toString()).toContain("sub");
  });
});
