/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { commTool } from "../../src/tools/comm.js";
import { foldTool, wrap } from "../../src/tools/fold.js";
import { nlTool } from "../../src/tools/nl.js";
import { pasteTool } from "../../src/tools/paste.js";
import { revTool } from "../../src/tools/rev.js";
import { shufTool } from "../../src/tools/shuf.js";
import { splitTool } from "../../src/tools/split.js";
import { tacTool } from "../../src/tools/tac.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-batch1-text-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

const stdin = (text: string) => ({
  stdin: (async function* () {
    yield Buffer.from(text);
  })(),
});

describe("tac, rev and nl", () => {
  it("reverses lines and characters", async () => {
    const { sb } = await setup();
    const tac = await runSpec(tacTool, {}, sb, stdin("a\nb\n"));
    expect(tac.result.stdout.toString()).toBe("b\na\n");
    const noNewline = await runSpec(tacTool, {}, sb, stdin("a\nb"));
    expect(noNewline.result.stdout.toString()).toBe("b\na\n");

    const rev = await runSpec(revTool, {}, sb, stdin("ab\ncd"));
    expect(rev.result.stdout.toString()).toBe("ba\ndc");
  });

  it("numbers lines with width, start and separator", async () => {
    const { sb } = await setup();
    const plain = await runSpec(nlTool, {}, sb, stdin("a\n\nb\n"));
    expect(plain.result.stdout.toString()).toBe("     1\ta\n       \n     2\tb\n");
    const all = await runSpec(nlTool, { all: true, start: 5, width: 3, separator: ":" }, sb, stdin("a\n\nb\n"));
    expect(all.result.stdout.toString()).toBe("  5:a\n  6:\n  7:b\n");
  });
});

describe("paste and comm", () => {
  it("merges files in parallel and serial mode", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a\nb\n");
    await fs.writeFile(path.join(root, "b"), "1\n2\n3\n");
    const parallel = await runSpec(pasteTool, { paths: ["a", "b"], delimiters: ":" }, sb);
    expect(parallel.result.stdout.toString()).toBe("a:1\nb:2\n:3\n");
    const serial = await runSpec(pasteTool, { paths: ["a"], serial: true, delimiters: ":-" }, sb);
    expect(serial.result.stdout.toString()).toBe("a:b\n");
    const piped = await runSpec(pasteTool, { serial: true }, sb, stdin("x\ny\n"));
    expect(piped.result.stdout.toString()).toBe("x\ty\n");
  });

  it("compares sorted files with column suppression", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "left"), "a\nc\ne\n");
    await fs.writeFile(path.join(root, "right"), "b\nc\nd\n");
    const all = await runSpec(commTool, { left: "left", right: "right" }, sb);
    expect(all.result.stdout.toString()).toBe("a\n\tb\n\t\tc\n\td\ne\n");
    const onlyRight = await runSpec(commTool, { left: "left", right: "right", suppress1: true, suppress3: true }, sb);
    expect(onlyRight.result.stdout.toString()).toBe("b\nd\n");
    const onlyLeft = await runSpec(commTool, { left: "left", right: "right", suppress2: true, suppress3: true }, sb);
    expect(onlyLeft.result.stdout.toString()).toBe("a\ne\n");
    const custom = await runSpec(commTool, { left: "left", right: "right", outputDelimiter: "|" }, sb);
    expect(custom.result.stdout.toString()).toContain("||c");
    const keepCommon = await runSpec(commTool, { left: "left", right: "right", suppress1: true }, sb);
    expect(keepCommon.result.stdout.toString()).toContain("b");
    expect(keepCommon.result.stdout.toString()).toContain("c");
    const suppressGroups = await runSpec(commTool, { left: "left", right: "right", suppress2: true }, sb);
    expect(suppressGroups.result.stdout.toString()).toContain("a");
  });
});

describe("split, shuf and fold", () => {
  it("splits by lines and bytes with suffixes", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "data"), "a\nb\nc\n");
    const lines = await runSpec(splitTool, { input: "data", prefix: "part", lines: 2 }, sb);
    expect(lines.result.metadata.files).toEqual(["partaa", "partab"]);
    expect(await fs.readFile(path.join(root, "partaa"), "utf8")).toBe("a\nb\n");
    expect(await fs.readFile(path.join(root, "partab"), "utf8")).toBe("c\n");

    const bytes = await runSpec(splitTool, { input: "data", prefix: "b", bytes: 3, numeric: true, suffixLength: 2, additionalSuffix: ".chunk" }, sb);
    expect(bytes.result.metadata.chunks).toBe(2);
    expect(await fs.readFile(path.join(root, "b00.chunk"), "utf8")).toBe("a\nb");
    await expect(runSpec(splitTool, { input: "data" }, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(splitTool, { lines: 1, bytes: 2 }, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("shuffles records and honors headCount", async () => {
    const { sb } = await setup();
    const shuffled = await runSpec(shufTool, {}, sb, stdin("a\nb\nc\n"));
    expect(shuffled.result.stdout.toString().trim().split("\n").sort()).toEqual(["a", "b", "c"]);
    const head = await runSpec(shufTool, { headCount: 2 }, sb, stdin("a\nb\nc\n"));
    expect(head.result.stdout.toString().trim().split("\n")).toHaveLength(2);
    const zero = await runSpec(shufTool, { zeroTerminated: true }, sb, stdin("a\0b\0"));
    expect(zero.result.stdout.toString().replaceAll("\0", "").trim().split("").sort()).toEqual(["a", "b"]);
  });

  it("folds lines by width and spaces", async () => {
    const { sb } = await setup();
    const hard = await runSpec(foldTool, { width: 5 }, sb, stdin("abcdefg\n"));
    expect(hard.result.stdout.toString()).toBe("abcde\nfg\n");
    const spaces = await runSpec(foldTool, { width: 5, spaces: true }, sb, stdin("hello world\n"));
    expect(spaces.result.stdout.toString()).toBe("hello \nworld\n");
    expect(wrap("", 4, false)).toEqual([""]);
  });
});
