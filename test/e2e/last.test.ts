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
import { diffTool } from "../../src/tools/diff.js";
import { findTool } from "../../src/tools/find.js";
import { grepTool } from "../../src/tools/grep.js";
import { lnTool } from "../../src/tools/ln.js";
import { sortTool } from "../../src/tools/sort.js";
import { tailTool } from "../../src/tools/tail.js";
import { trTool } from "../../src/tools/tr.js";
import { uniqTool } from "../../src/tools/uniq.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot();
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

describe("remaining option branches", () => {
  it("covers cat delete marker and cut file paths", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "cut"), "a:b:c");
    const cat = await runSpec(catTool, { showNonPrinting: true }, sb, { stdin: new (class { async *[Symbol.asyncIterator]() { yield Buffer.from([127, 10]); } })() });
    expect(cat.result.stdout.toString()).toContain("^?");
    const cut = await runSpec(cutTool, { paths: ["cut"], fields: "2", delimiter: ":" }, sb);
    expect(cut.result.stdout.toString()).toBe("b\n");
  });

  it("covers diff file-versus-directory and directory recursion", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir"));
    await fs.writeFile(path.join(root, "file"), "x");
    const mixed = await runSpec(diffTool, { left: "dir", right: "file", recursive: true }, sb);
    expect(mixed.result.stdout.toString()).toContain("directory");
    await fs.mkdir(path.join(root, "dir/sub"));
    await fs.writeFile(path.join(root, "dir/sub/a"), "a");
    await fs.mkdir(path.join(root, "dir2"));
    await fs.mkdir(path.join(root, "dir2/sub"));
    await fs.writeFile(path.join(root, "dir2/sub/a"), "b");
    const recursive = await runSpec(diffTool, { left: "dir", right: "dir2", recursive: true }, sb);
    expect(recursive.result.exitCode).toBe(1);
  });

  it("covers find with a file root", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "x");
    const result = await runSpec(findTool, { paths: ["a"], type: "f" }, sb);
    expect(result.result.stdout.toString()).toContain("a");
  });

  it("covers grep missing stdin and no-match outcomes", async () => {
    const { sb } = await setup();
    await expect(runSpec(grepTool, { pattern: "x" }, sb)).rejects.toMatchObject({ code: "invalid" });
    const noMatch = await runSpec(grepTool, { pattern: "zzz" }, sb, { stdin: new (class { async *[Symbol.asyncIterator]() { yield Buffer.from("a\n"); } })() });
    expect(noMatch.result.exitCode).toBe(1);
  });

  it("covers ln verbose and sort/uniq/tail no-input errors", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    const ln = await runSpec(lnTool, { sources: ["a"], destination: "b", symbolic: true, verbose: true }, sb);
    expect(ln.result.stdout.toString()).toContain("created");
    await expect(runSpec(sortTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(uniqTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(tailTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("covers tr backslash escapes and invalid ranges", async () => {
    const { sb } = await setup();
    const result = await runSpec(trTool, { set1: "\\\\", set2: "x" }, sb, { stdin: new (class { async *[Symbol.asyncIterator]() { yield Buffer.from("a\\b\n"); } })() });
    expect(result.result.stdout.toString()).toContain("axb");
    await expect(runSpec(trTool, { set1: "a-", set2: "x" }, sb, { stdin: new (class { async *[Symbol.asyncIterator]() { yield Buffer.from("a"); } })() })).resolves.toBeTruthy();
  });
});
