/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { catTool } from "../../src/tools/cat.js";
import { cutTool } from "../../src/tools/cut.js";
import { grepTool } from "../../src/tools/grep.js";
import { headTool } from "../../src/tools/head.js";
import { pipeTool } from "../../src/tools/pipe.js";
import { sedTool } from "../../src/tools/sed.js";
import { sortTool } from "../../src/tools/sort.js";
import { tailTool } from "../../src/tools/tail.js";
import { teeTool } from "../../src/tools/tee.js";
import { trTool } from "../../src/tools/tr.js";
import { uniqTool } from "../../src/tools/uniq.js";
import { wcTool } from "../../src/tools/wc.js";
import { bufferStream, makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot();
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

describe("cat, head, tail, wc and tee", () => {
  it("concatenates files and stdin with numbering", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "one\n\nthree\n");
    const plain = await runSpec(catTool, { paths: ["a"] }, sb);
    expect(plain.result.stdout.toString()).toBe("one\n\nthree\n");
    const numbered = await runSpec(catTool, { paths: ["a"], number: true, squeezeBlank: true, showEnds: true }, sb);
    expect(numbered.result.stdout.toString()).toContain("1  one$");
    expect(numbered.result.stdout.toString()).not.toContain("\n\n");
    const stdin = await runSpec(catTool, { numberNonBlank: true }, sb, { stdin: bufferStream("a\n\nb") });
    expect(stdin.result.stdout.toString()).toContain("2  b");
  });

  it("takes heads and tails by lines and bytes", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "1\n2\n3\n4\n5\n");
    const head = await runSpec(headTool, { paths: ["a"], lines: 2 }, sb);
    expect(head.result.stdout.toString()).toBe("1\n2\n");
    const headBytes = await runSpec(headTool, { paths: ["a"], bytes: 3 }, sb);
    expect(headBytes.result.stdout.toString()).toBe("1\n2");
    const tail = await runSpec(tailTool, { paths: ["a"], lines: 2 }, sb);
    expect(tail.result.stdout.toString()).toBe("4\n5\n");
    const tailFrom = await runSpec(tailTool, { paths: ["a"], lines: 3, fromStart: true }, sb);
    expect(tailFrom.result.stdout.toString()).toBe("3\n4\n5\n");
    const tailBytes = await runSpec(tailTool, { paths: ["a"], bytes: 2 }, sb);
    expect(tailBytes.result.stdout.toString()).toBe("5\n");
    const multiple = await runSpec(headTool, { paths: ["a", "a"], lines: 1, verbose: true }, sb);
    expect(multiple.result.stdout.toString()).toContain("==> a <==");
    const stdin = await runSpec(tailTool, { lines: 2 }, sb, { stdin: bufferStream("1\n2\n3") });
    expect(stdin.result.stdout.toString()).toBe("2\n3");
  });

  it("counts lines, words, bytes, chars and max line length", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "one two\nthree\n");
    const counts = await runSpec(wcTool, { paths: ["a"] }, sb);
    expect(counts.result.stdout.toString()).toContain("2");
    const selected = await runSpec(wcTool, { paths: ["a"], lines: true, chars: true, maxLineLength: true }, sb);
    expect(selected.result.stdout.toString()).toContain("a");
    const total = await runSpec(wcTool, { paths: ["a", "a"], lines: true }, sb);
    expect(total.result.stdout.toString()).toContain("total");
    const stdin = await runSpec(wcTool, { words: true }, sb, { stdin: bufferStream("a b") });
    expect(stdin.result.stdout.toString().trim()).toBe("2");
  });

  it("tees stdin to files and stdout", async () => {
    const { root, sb } = await setup();
    const result = await runSpec(teeTool, { paths: ["a", "b"], content: "hello" }, sb);
    expect(result.result.stdout.toString()).toBe("hello");
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("hello");
    await runSpec(teeTool, { paths: ["a"], append: true, content: "!" }, sb);
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("hello!");
    await expect(runSpec(teeTool, { paths: [] }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("sort, uniq, cut and tr", () => {
  it("sorts numerically, uniquely and by field", async () => {
    const { sb } = await setup();
    const data = bufferStream("10 b\n2 a\n2 a\n");
    const numeric = await runSpec(sortTool, { numeric: true, unique: true }, sb, { stdin: data });
    expect(numeric.result.stdout.toString()).toBe("2 a\n10 b\n");
    const reverse = await runSpec(sortTool, { reverse: true }, sb, { stdin: bufferStream("a\nb\n") });
    expect(reverse.result.stdout.toString()).toBe("b\na\n");
    const field = await runSpec(sortTool, { field: 2, separator: " ", ignoreCase: true }, sb, {
      stdin: bufferStream("x B\ny a\n"),
    });
    expect(field.result.stdout.toString()).toBe("y a\nx B\n");
  });

  it("filters adjacent duplicates and reports counts", async () => {
    const { sb } = await setup();
    const result = await runSpec(uniqTool, { count: true }, sb, { stdin: bufferStream("a\na\nb\n") });
    expect(result.result.stdout.toString()).toContain("2 a");
    const repeated = await runSpec(uniqTool, { repeated: true }, sb, { stdin: bufferStream("a\na\nb\n") });
    expect(repeated.result.stdout.toString()).toBe("a\n");
    const unique = await runSpec(uniqTool, { uniqueOnly: true, ignoreCase: true }, sb, {
      stdin: bufferStream("a\nA\nb\n"),
    });
    expect(unique.result.stdout.toString()).toBe("b\n");
    const skipped = await runSpec(uniqTool, { skipFields: 1, skipChars: 0 }, sb, {
      stdin: bufferStream("x a\ny a\n"),
    });
    expect(skipped.result.stdout.toString()).toBe("x a\n");
  });

  it("cuts fields, characters and bytes", async () => {
    const { sb } = await setup();
    const fields = await runSpec(cutTool, { fields: "1,3", delimiter: ":" }, sb, {
      stdin: bufferStream("a:b:c:d\n"),
    });
    expect(fields.result.stdout.toString()).toBe("a:c\n");
    const complement = await runSpec(cutTool, { fields: "2", delimiter: ":", complement: true }, sb, {
      stdin: bufferStream("a:b:c\n"),
    });
    expect(complement.result.stdout.toString()).toBe("a:c\n");
    const chars = await runSpec(cutTool, { characters: "1-2" }, sb, { stdin: bufferStream("abcd\n") });
    expect(chars.result.stdout.toString()).toBe("ab\n");
    const bytes = await runSpec(cutTool, { bytes: "2" }, sb, { stdin: bufferStream("abc\n") });
    expect(bytes.result.stdout.toString()).toBe("b\n");
    const onlyDelimited = await runSpec(cutTool, { fields: "1", delimiter: ":", onlyDelimited: true }, sb, {
      stdin: bufferStream("plain\na:b\n"),
    });
    expect(onlyDelimited.result.stdout.toString()).toBe("plain\na\n");
    await expect(runSpec(cutTool, {}, sb, { stdin: bufferStream("x") })).rejects.toMatchObject({ code: "invalid" });
  });

  it("translates, deletes and squeezes characters", async () => {
    const { sb } = await setup();
    const translate = await runSpec(trTool, { set1: "a-z", set2: "A-Z" }, sb, { stdin: bufferStream("abc\n") });
    expect(translate.result.stdout.toString()).toBe("ABC\n");
    const remove = await runSpec(trTool, { set1: "0-9", delete: true }, sb, { stdin: bufferStream("a1b2\n") });
    expect(remove.result.stdout.toString()).toBe("ab\n");
    const squeeze = await runSpec(trTool, { set1: "a", squeeze: true }, sb, { stdin: bufferStream("aaab\n") });
    expect(squeeze.result.stdout.toString()).toBe("ab\n");
    const complement = await runSpec(trTool, { set1: "a-z", complement: true, delete: true }, sb, {
      stdin: bufferStream("a1b!\n"),
    });
    expect(complement.result.stdout.toString()).toBe("ab\n");
    const classes = await runSpec(trTool, { set1: "[:digit:]", set2: "x" }, sb, { stdin: bufferStream("a1b2\n") });
    expect(classes.result.stdout.toString()).toBe("axbx\n");
    await expect(runSpec(trTool, { set1: "\\" }, sb, { stdin: bufferStream("x") })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("sed and grep", () => {
  it("substitutes in streams and in place", async () => {
    const { root, sb } = await setup();
    const stream = await runSpec(sedTool, { script: "s/foo/bar/g" }, sb, { stdin: bufferStream("foo foo\n") });
    expect(stream.result.stdout.toString()).toBe("bar bar\n");
    await fs.writeFile(path.join(root, "a"), "foo\n");
    await runSpec(sedTool, { script: "s/foo/bar/", paths: ["a"], inPlace: true }, sb);
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("bar\n");
    const expression = await runSpec(sedTool, { script: "s/a/b/", expressions: ["s/b/c/"] }, sb, {
      stdin: bufferStream("a\n"),
    });
    expect(expression.result.stdout.toString()).toBe("c\n");
    await expect(runSpec(sedTool, { script: "d" }, sb, { stdin: bufferStream("x") })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(runSpec(sedTool, { script: "s/a/b/", inPlace: true }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("greps files and stdin with common flags", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "one\nError two\nthree\n");
    await fs.writeFile(path.join(root, "b"), "error\n");
    const simple = await runSpec(grepTool, { pattern: "Error", paths: ["a"] }, sb);
    expect(simple.result.stdout.toString()).toContain("Error two");
    const ignoreCase = await runSpec(grepTool, { pattern: "error", paths: ["a", "b"], ignoreCase: true, lineNumbers: true }, sb);
    expect(ignoreCase.result.stdout.toString()).toContain("a:2");
    const invert = await runSpec(grepTool, { pattern: "Error", paths: ["a"], invert: true }, sb);
    expect(invert.result.stdout.toString()).toContain("one");
    const count = await runSpec(grepTool, { pattern: "e", paths: ["a"], count: true, ignoreCase: true }, sb);
    expect(count.result.stdout.toString()).toContain("3");
    const files = await runSpec(grepTool, { pattern: "error", paths: ["a", "b"], filesWithMatches: true, ignoreCase: true }, sb);
    expect(files.result.stdout.toString()).toContain("b");
    const without = await runSpec(grepTool, { pattern: "zzz", paths: ["a", "b"], filesWithoutMatch: true }, sb);
    expect(without.result.stdout.toString()).toContain("a");
    const only = await runSpec(grepTool, { pattern: "Error", paths: ["a"], onlyMatching: true }, sb);
    expect(only.result.stdout.toString()).toContain("Error");
    const word = await runSpec(grepTool, { pattern: "one", paths: ["a"], word: true }, sb);
    expect(word.result.stdout.toString()).toContain("one");
    const line = await runSpec(grepTool, { pattern: "one", paths: ["a"], line: true }, sb);
    expect(line.result.stdout.toString()).toContain("one");
    const fixed = await runSpec(grepTool, { pattern: "Error t", paths: ["a"], fixed: true }, sb);
    expect(fixed.result.stdout.toString()).toContain("Error two");
    const context = await runSpec(grepTool, { pattern: "Error", paths: ["a"], context: 1 }, sb);
    expect(context.result.stdout.toString()).toContain("one");
    const recursive = await runSpec(grepTool, { pattern: "error", paths: ["."], recursive: true, ignoreCase: true }, sb);
    expect(recursive.result.stdout.toString()).toContain("b");
    const stdin = await runSpec(grepTool, { pattern: "x" }, sb, { stdin: bufferStream("x\ny\n") });
    expect(stdin.result.stdout.toString()).toBe("x\n");
    await expect(runSpec(grepTool, { pattern: "[", paths: ["a"] }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("pipe", () => {
  it("composes stages and writes output", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "log"), "b\na\nb\nERROR\n");
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "cat", args: { paths: ["log"] } },
          { tool: "grep", args: { pattern: "ERROR", invert: true } },
          { tool: "sort", args: { unique: true } },
        ],
        output: "out",
      },
      sb,
    );
    expect(result.result.stdout.toString()).toBe("a\nb\n");
    expect(await fs.readFile(path.join(root, "out"), "utf8")).toBe("a\nb\n");
    expect(result.result.metadata).toMatchObject({ output: "out" });
  });

  it("rejects unknown, non-pipeable and empty stages", async () => {
    const { sb } = await setup();
    await expect(runSpec(pipeTool, { stages: [{ tool: "nope" }] }, sb)).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(runSpec(pipeTool, { stages: [{ tool: "cp" }] }, sb)).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(runSpec(pipeTool, { stages: [{ tool: "grep", args: { pattern: "x" } }] }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
  });
});
