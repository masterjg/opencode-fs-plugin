/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { Sandbox } from "../../src/core/sandbox.js";
import { catTool } from "../../src/tools/cat.js";
import { chmodTool } from "../../src/tools/chmod.js";
import { cpTool } from "../../src/tools/cp.js";
import { cutTool } from "../../src/tools/cut.js";
import { dfTool } from "../../src/tools/df.js";
import { diffTool } from "../../src/tools/diff.js";
import { duTool } from "../../src/tools/du.js";
import { findTool } from "../../src/tools/find.js";
import { grepTool } from "../../src/tools/grep.js";
import { gunzipTool, gzipTool } from "../../src/tools/gzip.js";
import { hashTool } from "../../src/tools/hash.js";
import { headTool } from "../../src/tools/head.js";
import { lnTool } from "../../src/tools/ln.js";
import { lsTool } from "../../src/tools/ls.js";
import { mktempTool } from "../../src/tools/mktemp.js";
import { mvTool } from "../../src/tools/mv.js";
import { pipeTool } from "../../src/tools/pipe.js";
import { sedTool } from "../../src/tools/sed.js";
import { sortTool } from "../../src/tools/sort.js";
import { statTool } from "../../src/tools/stat.js";
import { tailTool } from "../../src/tools/tail.js";
import { tarTool } from "../../src/tools/tar.js";
import { teeTool } from "../../src/tools/tee.js";
import { touchTool } from "../../src/tools/touch.js";
import { trTool } from "../../src/tools/tr.js";
import { trashTool } from "../../src/tools/trash.js";
import { truncateTool } from "../../src/tools/truncate.js";
import { uniqTool } from "../../src/tools/uniq.js";
import { wcTool } from "../../src/tools/wc.js";
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

describe("text option coverage", () => {
  it("cat handles tabs, non-printing bytes and missing input", async () => {
    const { sb } = await setup();
    const tabs = await runSpec(catTool, { showTabs: true }, sb, { stdin: bufferStream("a\tb\n") });
    expect(tabs.result.stdout.toString()).toContain("a^Ib");
    const visible = await runSpec(catTool, { showNonPrinting: true }, sb, { stdin: bufferStream("a\u0001b\n") });
    expect(visible.result.stdout.toString()).toContain("^A");
    await expect(runSpec(catTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("head and tail cover quiet, bytes, stdin and option errors", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "1\n2\n3\n");
    const headQuiet = await runSpec(headTool, { paths: ["a", "a"], lines: 1, quiet: true }, sb);
    expect(headQuiet.result.stdout.toString()).not.toContain("==>");
    const headStdin = await runSpec(headTool, { bytes: 2 }, sb, { stdin: bufferStream("abcdef") });
    expect(headStdin.result.stdout.toString()).toBe("ab");
    const headLines = await runSpec(headTool, { lines: 1 }, sb, { stdin: bufferStream("a\nb\n") });
    expect(headLines.result.stdout.toString()).toBe("a\n");
    await expect(runSpec(headTool, { paths: ["a"], lines: 1, bytes: 1 }, sb)).rejects.toMatchObject({ code: "invalid" });
    const tailQuiet = await runSpec(tailTool, { paths: ["a", "a"], lines: 1, quiet: true }, sb);
    expect(tailQuiet.result.stdout.toString()).not.toContain("==>");
    const tailStdin = await runSpec(tailTool, { bytes: 2 }, sb, { stdin: bufferStream("abcdef") });
    expect(tailStdin.result.stdout.toString()).toBe("ef");
    await expect(runSpec(tailTool, { paths: ["a"], lines: 1, bytes: 1 }, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("wc covers every flag and multiple totals", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "one two\nthree\n");
    const result = await runSpec(wcTool, { paths: ["a"], lines: true, words: true, bytes: true, chars: true, maxLineLength: true }, sb);
    expect(result.result.stdout.toString()).toContain("a");
    const total = await runSpec(wcTool, { paths: ["a", "a"], bytes: true }, sb);
    expect(total.result.stdout.toString()).toContain("total");
    const stdin = await runSpec(wcTool, { chars: true }, sb, { stdin: bufferStream("abc") });
    expect(stdin.result.stdout.toString().trim()).toBe("3");
  });

  it("tee reads stdin, appends and rejects empty input", async () => {
    const { root, sb } = await setup();
    const result = await runSpec(teeTool, { paths: ["a"] }, sb, { stdin: bufferStream("stdin") });
    expect(result.result.stdout.toString()).toBe("stdin");
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("stdin");
    await runSpec(teeTool, { paths: ["a"], append: true, content: "!" }, sb);
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("stdin!");
  });

  it("sort covers blanks, fields, numeric fallback and missing stdin", async () => {
    const { sb } = await setup();
    const blanks = await runSpec(sortTool, { ignoreLeadingBlanks: true }, sb, { stdin: bufferStream(" b\n a\n") });
    expect(blanks.result.stdout.toString()).toBe(" a\n b\n");
    const field = await runSpec(sortTool, { field: 2, separator: ":" }, sb, { stdin: bufferStream("x:2\ny:1\n") });
    expect(field.result.stdout.toString()).toBe("y:1\nx:2\n");
    const defaultField = await runSpec(sortTool, { field: 2 }, sb, { stdin: bufferStream("x 2\ny 1\n") });
    expect(defaultField.result.stdout.toString()).toBe("y 1\nx 2\n");
    const numeric = await runSpec(sortTool, { numeric: true }, sb, { stdin: bufferStream("a\n1\n") });
    expect(numeric.result.stdout.toString()).toContain("1");
    await expect(runSpec(sortTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("uniq covers skip options and repeated/unique filters", async () => {
    const { sb } = await setup();
    const skipped = await runSpec(uniqTool, { skipFields: 1 }, sb, { stdin: bufferStream("x a\ny a\nz b\n") });
    expect(skipped.result.stdout.toString()).toBe("x a\nz b\n");
    const chars = await runSpec(uniqTool, { skipChars: 2 }, sb, { stdin: bufferStream("x a\ny a\n") });
    expect(chars.result.stdout.toString()).toBe("x a\n");
    const repeated = await runSpec(uniqTool, { repeated: true }, sb, { stdin: bufferStream("a\na\nb\n") });
    expect(repeated.result.stdout.toString()).toBe("a\n");
  });

  it("cut covers output delimiter and invalid ranges", async () => {
    const { sb } = await setup();
    const output = await runSpec(cutTool, { fields: "1,2", delimiter: ":", outputDelimiter: "-" }, sb, {
      stdin: bufferStream("a:b:c\n"),
    });
    expect(output.result.stdout.toString()).toBe("a-b\n");
    await expect(runSpec(cutTool, { fields: "0" }, sb, { stdin: bufferStream("a") })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(runSpec(cutTool, { fields: "x" }, sb, { stdin: bufferStream("a") })).rejects.toMatchObject({
      code: "invalid",
    });
    const defaults = await runSpec(cutTool, { fields: "1" }, sb, { stdin: bufferStream("a\tb\n") });
    expect(defaults.result.stdout.toString()).toBe("a\n");
    const open = await runSpec(cutTool, { fields: "1-" }, sb, { stdin: bufferStream("a:b:c\n") });
    expect(open.result.stdout.toString()).toBe("a:b:c\n");
  });

  it("tr covers escapes, classes, ranges and invalid input", async () => {
    const { sb } = await setup();
    const escapes = await runSpec(trTool, { set1: "\\t", set2: "X" }, sb, { stdin: bufferStream("a\tb\t\n") });
    expect(escapes.result.stdout.toString()).toBe("aXbX\n");
    const upper = await runSpec(trTool, { set1: "[:upper:]", set2: "x" }, sb, { stdin: bufferStream("Ab\n") });
    expect(upper.result.stdout.toString()).toBe("xb\n");
    const lower = await runSpec(trTool, { set1: "[:lower:]", set2: "x" }, sb, { stdin: bufferStream("ab\n") });
    expect(lower.result.stdout.toString()).toBe("xx\n");
    const space = await runSpec(trTool, { set1: "[:space:]", set2: "_" }, sb, { stdin: bufferStream("a b\n") });
    expect(space.result.stdout.toString()).toBe("a_b\n");
    const alpha = await runSpec(trTool, { set1: "[:alpha:]", set2: "x" }, sb, { stdin: bufferStream("aZ\n") });
    expect(alpha.result.stdout.toString()).toBe("xx\n");
    await expect(runSpec(trTool, { set1: "a-z", set2: "x" }, sb, { stdin: bufferStream("a") })).resolves.toBeTruthy();
    await expect(runSpec(trTool, { set1: "[:nope:]", set2: "x" }, sb, { stdin: bufferStream("a") })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(runSpec(trTool, { set1: "z-a", set2: "x" }, sb, { stdin: bufferStream("a") })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("sed covers print, quiet, flags and in-place errors", async () => {
    const { root, sb } = await setup();
    const print = await runSpec(sedTool, { script: "s/a/b/p", quiet: true }, sb, { stdin: bufferStream("a\nc\n") });
    expect(print.result.stdout.toString()).toBe("b\n");
    const insensitive = await runSpec(sedTool, { script: "s/A/x/gi" }, sb, { stdin: bufferStream("aA\n") });
    expect(insensitive.result.stdout.toString()).toBe("xx\n");
    await expect(runSpec(sedTool, { script: "s/a/b/", paths: ["missing"], inPlace: true }, sb)).rejects.toBeTruthy();
    await fs.writeFile(path.join(root, "a"), "a\n");
    await runSpec(sedTool, { script: "s/a/b/", paths: ["a"], inPlace: true }, sb);
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("b\n");
  });

  it("grep covers include/exclude, binary, max-count and errors", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir"));
    await fs.writeFile(path.join(root, "dir/a.txt"), "hit\nhit\n");
    await fs.writeFile(path.join(root, "dir/b.log"), "hit\n");
    await fs.writeFile(path.join(root, "bin"), Buffer.from([0, 1, 104, 105, 116]));
    await fs.writeFile(path.join(root, "dir/context.txt"), "one\nhit\nthree\n");
    const included = await runSpec(grepTool, { pattern: "hit", paths: ["dir"], recursive: true, include: ["*.txt"] }, sb);
    expect(included.result.stdout.toString()).toContain("a.txt");
    expect(included.result.stdout.toString()).not.toContain("b.log");
    const skippedFile = await runSpec(grepTool, { pattern: "hit", paths: ["dir/b.log"], include: ["*.txt"] }, sb);
    expect(skippedFile.result.stdout.toString()).toBe("");
    const excluded = await runSpec(grepTool, { pattern: "hit", paths: ["dir"], recursive: true, exclude: ["*.log"] }, sb);
    expect(excluded.result.stdout.toString()).not.toContain("b.log");
    const limited = await runSpec(grepTool, { pattern: "hit", paths: ["dir/a.txt"], maxCount: 1, count: true }, sb);
    expect(limited.result.stdout.toString()).toContain("1");
    const binary = await runSpec(grepTool, { pattern: "hit", paths: ["bin"] }, sb);
    expect(binary.result.stdout.toString()).toContain("Binary file");
    const before = await runSpec(grepTool, { pattern: "hit", paths: ["dir/context.txt"], before: 1, lineNumbers: true }, sb);
    expect(before.result.stdout.toString()).toContain("-");
    const after = await runSpec(grepTool, { pattern: "hit", paths: ["dir/context.txt"], after: 1 }, sb);
    expect(after.result.stdout.toString()).toContain("three");
    await expect(runSpec(grepTool, { pattern: "hit", paths: ["dir"] }, sb)).rejects.toMatchObject({
      code: "not-file",
    });
    await expect(runSpec(grepTool, { pattern: "hit", paths: ["missing"], noMessages: true }, sb)).resolves.toBeTruthy();
  });

  it("pipe covers input, sink and append", async () => {
    const { root, sb } = await setup();
    const input = await runSpec(
      pipeTool,
      { input: "b\na\n", stages: [{ tool: "sort" }] },
      sb,
    );
    expect(input.result.stdout.toString()).toBe("a\nb\n");
    const sink = await runSpec(
      pipeTool,
      { input: "abc", stages: [{ tool: "hash", args: { algorithm: "sha256" } }] },
      sb,
    );
    expect(sink.result.stdout.toString()).toMatch(/^ba7816bf/);
    await fs.writeFile(path.join(root, "out"), "old");
    await runSpec(
      pipeTool,
      { input: "new", stages: [{ tool: "cat" }], output: "out", append: true },
      sb,
    );
    expect(await fs.readFile(path.join(root, "out"), "utf8")).toBe("oldnew");
  });
});

describe("filesystem option coverage", () => {
  it("cp and mv cover verbose, noClobber, update and errors", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.writeFile(path.join(root, "b"), "b");
    const copied = await runSpec(cpTool, { sources: ["a"], destination: "c", verbose: true }, sb);
    expect(copied.result.stdout.toString()).toContain("->");
    await expect(runSpec(cpTool, { sources: ["a", "b"], destination: "missing" }, sb)).rejects.toMatchObject({
      code: "not-directory",
    });
    await expect(runSpec(cpTool, { sources: ["a"], destination: "a" }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
    const moved = await runSpec(mvTool, { sources: ["a"], destination: "d", verbose: true }, sb);
    expect(moved.result.stdout.toString()).toContain("->");
    await fs.writeFile(path.join(root, "e"), "e");
    await fs.writeFile(path.join(root, "f"), "f");
    await runSpec(mvTool, { sources: ["e"], destination: "f", noClobber: true }, sb);
    expect(await pathExists(path.join(root, "e"))).toBe(true);
    await expect(runSpec(mvTool, { sources: ["e", "f"], destination: "missing-dest" }, sb)).rejects.toMatchObject({
      code: "not-directory",
    });
    await fs.writeFile(path.join(root, "new"), "new");
    await fs.utimes(path.join(root, "new"), new Date(), new Date(Date.now() + 10_000));
    await runSpec(mvTool, { sources: ["d"], destination: "new", update: true }, sb);
    expect(await pathExists(path.join(root, "d"))).toBe(true);
    await expect(runSpec(mvTool, { sources: ["d"], destination: "d" }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("ls covers hidden, sort, recursive, links and type markers", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.writeFile(path.join(root, ".hidden"), "h");
    await fs.mkdir(path.join(root, "dir"));
    await fs.symlink("a", path.join(root, "link"));
    await fs.writeFile(path.join(root, "run"), "x");
    await fs.chmod(path.join(root, "run"), 0o755);
    const almost = await runSpec(lsTool, { almostAll: true, sortBy: "none" }, sb);
    expect(almost.result.stdout.toString()).toContain(".hidden");
    expect(almost.result.stdout.toString()).not.toContain(" .");
    const classified = await runSpec(lsTool, { classify: true, long: true }, sb);
    expect(classified.result.stdout.toString()).toContain("link@");
    expect(classified.result.stdout.toString()).toContain("dir/");
    expect(classified.result.stdout.toString()).toContain("run*");
    const recursive = await runSpec(lsTool, { recursive: true }, sb);
    expect(recursive.result.stdout.toString()).toContain("dir");
    const directory = await runSpec(lsTool, { paths: ["dir"], directory: true }, sb);
    expect(directory.result.stdout.toString()).toContain("dir");
    const time = await runSpec(lsTool, { sortBy: "time" }, sb);
    expect(time.result.stdout.toString()).toContain("a");
    const inode = await runSpec(lsTool, { inode: true }, sb);
    expect(inode.result.stdout.toString()).toContain("a");
  });

  it("stat covers follow, escapes and filesystem output", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "x");
    await fs.symlink("a", path.join(root, "link"));
    const followed = await runSpec(statTool, { paths: ["link"], follow: true }, sb);
    expect(followed.result.stdout.toString()).toContain("regular file");
    const escapes = await runSpec(statTool, { paths: ["a"], format: "\\n\\t\\\\%n" }, sb);
    expect(escapes.result.stdout.toString()).toContain("\n\t\\a");
    const fsInfo = await runSpec(statTool, { paths: ["a"], filesystem: true }, sb);
    expect(fsInfo.result.stdout.toString()).toContain("Inodes");
  });

  it("touch and truncate cover no-follow, references and no-create", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "12345");
    await fs.symlink("a", path.join(root, "link"));
    await runSpec(touchTool, { paths: ["link"], noDereference: true }, sb);
    await runSpec(touchTool, { paths: ["a"], reference: "a", accessOnly: true }, sb);
    await runSpec(touchTool, { paths: ["a"], timestamp: "01020304" }, sb);
    await runSpec(touchTool, { paths: ["a"], timestamp: "9912312359" }, sb);
    await runSpec(touchTool, { paths: ["missing"], noCreate: true }, sb);
    await runSpec(truncateTool, { paths: ["a"], size: "1", noDereference: true }, sb);
    await fs.writeFile(path.join(root, "ref"), "123");
    await runSpec(truncateTool, { paths: ["a"], reference: "ref" }, sb);
    await runSpec(truncateTool, { paths: ["missing"], size: "1", noCreate: true }, sb);
    await runSpec(truncateTool, { paths: ["a"], size: "+1" }, sb);
  });

  it("ln and chmod cover multi-source, force, relative and no-follow errors", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.writeFile(path.join(root, "b"), "b");
    await fs.mkdir(path.join(root, "dest"));
    await runSpec(lnTool, { sources: ["a", "b"], destination: "dest", symbolic: true }, sb);
    expect(await pathExists(path.join(root, "dest/a"))).toBe(true);
    await expect(runSpec(lnTool, { sources: ["a", "b"], destination: "missing-dest" }, sb)).rejects.toMatchObject({
      code: "not-directory",
    });
    await runSpec(lnTool, { sources: ["a"], destination: "hard", noDereference: true }, sb);
    await runSpec(lnTool, { sources: ["a"], destination: "hard", force: true, noDereference: true }, sb);
    await runSpec(lnTool, { sources: ["a"], destination: "rel", symbolic: true, relative: true }, sb);
    await expect(runSpec(chmodTool, { paths: ["a"], mode: "600", noDereference: true }, sb)).resolves.toBeTruthy();
    await fs.symlink("a", path.join(root, "link"));
    await expect(runSpec(chmodTool, { paths: ["link"], mode: "600", noDereference: true }, sb)).rejects.toMatchObject({
      code: "unsupported",
    });
    await runSpec(chmodTool, { paths: ["a"], mode: "600", silent: true }, sb);
    await runSpec(chmodTool, { paths: ["a"], mode: "600", changes: true }, sb);
    await runSpec(chmodTool, { paths: ["a"], mode: "600", recursive: true }, sb);
  });

  it("hash, du and df cover multiple paths and flags", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.writeFile(path.join(root, "b"), "b");
    const hashes = await runSpec(hashTool, { files: ["a", "b"], algorithm: "sha512" }, sb);
    expect(hashes.result.stdout.toString().split("\n").filter(Boolean)).toHaveLength(2);
    const fileDu = await runSpec(duTool, { paths: ["a"], human: true, total: true }, sb);
    expect(fileDu.result.stdout.toString()).toContain("a");
    await fs.mkdir(path.join(root, "dir"));
    await fs.writeFile(path.join(root, "dir/a"), "a");
    const all = await runSpec(duTool, { paths: ["dir"], all: true, maxDepth: 1, follow: true }, sb);
    expect(all.result.stdout.toString()).toContain("dir");
    const inodes = await runSpec(dfTool, { inodes: true, printType: true }, sb);
    expect(inodes.result.stdout.toString()).toContain("Inodes");
    const plainDf = await runSpec(dfTool, {}, sb);
    expect(plainDf.result.stdout.toString()).toContain("Filesystem");
    const defaultDu = await runSpec(duTool, {}, sb);
    expect(defaultDu.result.stdout.toString().length).toBeGreaterThan(0);
    const oneFs = await runSpec(duTool, { paths: ["."], oneFileSystem: true }, sb);
    expect(oneFs.result.stdout.toString()).toContain(".");
    const emptyDu = await runSpec(duTool, { paths: [] }, sb);
    expect(emptyDu.result.stdout.toString()).toBe("");
  });

  it("find covers hidden, depth, time, print0 and sort controls", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/.hidden"), "x");
    await fs.writeFile(path.join(root, "dir/a"), "x");
    await fs.writeFile(path.join(root, "dir/sub/deep"), "x");
    await fs.mkdir(path.join(root, "dir/empty"));
    const hidden = await runSpec(findTool, { paths: ["dir"], name: ".hidden" }, sb);
    expect(hidden.result.stdout.toString()).toContain(".hidden");
    const depth = await runSpec(findTool, { paths: ["dir"], minDepth: 2, maxDepth: 2 }, sb);
    expect(depth.result.stdout.toString()).toContain("deep");
    expect(depth.result.stdout.toString()).not.toContain("dir/a");
    const minutes = await runSpec(findTool, { paths: ["dir"], mmin: "-1" }, sb);
    expect(minutes.result.stdout.toString()).toContain("a");
    const size = await runSpec(findTool, { paths: ["dir"], size: "1" }, sb);
    expect(size.result.stdout.toString()).toContain("a");
    const print0 = await runSpec(findTool, { paths: ["dir"], print0: true }, sb);
    expect(print0.result.stdout.toString()).toContain("\0");
    const unsorted = await runSpec(findTool, { paths: ["dir"], sort: false }, sb);
    expect(unsorted.result.stdout.toString().length).toBeGreaterThan(0);
    const defaultRoot = await runSpec(findTool, {}, sb);
    expect(defaultRoot.result.stdout.toString()).toContain("dir");
    const iname = await runSpec(findTool, { paths: ["dir"], iname: "A" }, sb);
    expect(iname.result.stdout.toString()).toContain("a");
    const pathPattern = await runSpec(findTool, { paths: ["dir"], pathPattern: "**/sub" }, sb);
    expect(pathPattern.result.stdout.toString()).toContain("sub");
    const zero = await runSpec(findTool, { paths: ["dir"], maxDepth: 0 }, sb);
    expect(zero.result.stdout.toString()).toContain("dir");
    const negativeSize = await runSpec(findTool, { paths: ["dir"], size: "-2" }, sb);
    expect(negativeSize.result.stdout.toString()).toContain("a");
    const exactSize = await runSpec(findTool, { paths: ["dir"], size: "1" }, sb);
    expect(exactSize.result.stdout.toString()).toContain("a");
    const recentMinutes = await runSpec(findTool, { paths: ["dir"], mmin: "-1" }, sb);
    expect(recentMinutes.result.stdout.toString()).toContain("a");
    const emptyDir = await runSpec(findTool, { paths: ["dir"], empty: true }, sb);
    expect(emptyDir.result.stdout.toString()).toContain("empty");
    const noMatch = await runSpec(findTool, { paths: ["dir"], name: "nothing" }, sb);
    expect(noMatch.result.stdout.toString()).toBe("");
    const symlinkType = await runSpec(findTool, { paths: ["dir"], type: "l" }, sb);
    expect(symlinkType.result.stdout.toString()).toBe("");
    const followed = await runSpec(findTool, { paths: ["dir"], follow: true }, sb);
    expect(followed.result.stdout.toString()).toContain("dir");
  });

  it("covers remaining path, format and error branches", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "text"), "b\na\nb\n");
    await fs.writeFile(path.join(root, "exact"), "x");
    const sort = await runSpec(sortTool, { paths: ["text"] }, sb);
    expect(sort.result.stdout.toString()).toBe("a\nb\nb\n");
    const uniq = await runSpec(uniqTool, { paths: ["text"] }, sb);
    expect(uniq.result.stdout.toString()).toBe("b\na\nb\n");
    const tr = await runSpec(trTool, { paths: ["text"], set1: "a", set2: "x" }, sb);
    expect(tr.result.stdout.toString()).toContain("x");
    const literal = await runSpec(trTool, { set1: "[", set2: "x" }, sb, { stdin: bufferStream("[\n") });
    expect(literal.result.stdout.toString()).toBe("x\n");
    await expect(runSpec(trTool, { set1: "[:bad" }, sb, { stdin: bufferStream("x") })).rejects.toMatchObject({
      code: "invalid",
    });
    const carriage = await runSpec(trTool, { set1: "\\r", set2: "X" }, sb, { stdin: new (class { async *[Symbol.asyncIterator]() { yield Buffer.from("a\r"); } })() });
    expect(carriage.result.stdout.toString()).toContain("X");
    await runSpec(touchTool, { paths: ["exact"], date: "@0" }, sb);
    await expect(runSpec(touchTool, { paths: ["exact"], date: "@bad" }, sb)).rejects.toMatchObject({ code: "invalid" });
    const stat = await runSpec(statTool, { paths: ["exact"], format: "%" }, sb);
    expect(stat.result.stdout.toString()).toBe("%");
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.writeFile(path.join(root, "a2"), "a");
    const tail = await runSpec(tailTool, { paths: ["a", "a2"], lines: 1, verbose: true }, sb);
    expect(tail.result.stdout.toString()).toContain("==>");
    const link = path.join(root, "hard");
    await fs.link(path.join(root, "a"), link);
    const du = await runSpec(duTool, { paths: ["a"], all: true }, sb);
    expect(du.result.stdout.toString()).toContain("a");
    const exactAge = await runSpec(findTool, { paths: ["a"], mtime: "0" }, sb);
    expect(exactAge.result.stdout.toString()).toContain("a");
    await expect(runSpec(pipeTool, { stages: [{ tool: "grep", args: { pattern: "x" } }] }, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(pipeTool, { stages: [{ tool: "cp" }] }, sb)).rejects.toMatchObject({ code: "unsupported" });
    await expect(runSpec(hashTool, { files: ["."] }, sb)).rejects.toBeTruthy();
    await expect(runSpec(headTool, { paths: ["."] }, sb)).rejects.toBeTruthy();
    await expect(runSpec(sedTool, { script: "s/a" }, sb, { stdin: bufferStream("a") })).rejects.toMatchObject({ code: "unsupported" });
    await fs.mkdir(path.join(root, "archive"));
    await runSpec(tarTool, { mode: "create", archive: "archive.tar", paths: ["archive"] }, sb);
    await runSpec(tarTool, { mode: "extract", archive: "archive.tar", directory: "newdir" }, sb);
    expect(await pathExists(path.join(root, "newdir/archive"))).toBe(true);
    await expect(runSpec(gzipTool, { paths: ["."] }, sb)).rejects.toBeTruthy();
    await fs.mkdir(path.join(root, "a.gz"));
    await expect(runSpec(gzipTool, { paths: ["a"] }, sb)).rejects.toBeTruthy();
    await fs.writeFile(path.join(root, "bad.gz"), "not gzip");
    await expect(runSpec(gunzipTool, { paths: ["bad.gz"] }, sb)).rejects.toBeTruthy();
  });

  it("gzip, mktemp and trash cover force, suffix and collisions", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await runSpec(gzipTool, { paths: ["a"], keep: true }, sb);
    await runSpec(gzipTool, { paths: ["a"], force: true }, sb);
    await expect(runSpec(gzipTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(gunzipTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });

    const temp = await runSpec(mktempTool, { tmpdir: root, template: "x.XXX", suffix: ".suf" }, sb);
    expect(temp.result.stdout.toString()).toContain(".suf");
    const dir = await runSpec(mktempTool, { tmpdir: root, template: "d.XXX", directory: true }, sb);
    expect(await pathExists(dir.result.stdout.toString().trim())).toBe(true);
    await expect(runSpec(mktempTool, { tmpdir: root, template: "bad" }, sb)).rejects.toMatchObject({ code: "invalid" });

    process.env.XDG_DATA_HOME = path.join(root, "data");
    await fs.mkdir(path.join(root, "one"));
    await fs.mkdir(path.join(root, "two"));
    await fs.writeFile(path.join(root, "one/same"), "1");
    await fs.writeFile(path.join(root, "two/same"), "2");
    await runSpec(trashTool, { paths: ["one/same", "two/same"] }, sb);
    expect((await fs.readdir(path.join(root, "data/Trash/files"))).sort()).toEqual(["same", "same.1"]);
  });
});
