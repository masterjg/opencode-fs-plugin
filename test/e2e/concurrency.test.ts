/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { chmodTool } from "../../src/tools/chmod.ts";
import { duTool } from "../../src/tools/du.ts";
import { findTool } from "../../src/tools/find.ts";
import { grepTool } from "../../src/tools/grep.ts";
import { lsTool } from "../../src/tools/ls.ts";
import { makeRoot, runSpec } from "../helpers.js";
import { Sandbox } from "../../src/core/sandbox.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-concurrency-");
  roots.push(root);
  await fs.mkdir(path.join(root, "g1"));
  await fs.writeFile(path.join(root, "g1/a.log"), "hit a\n");
  await fs.writeFile(path.join(root, "g1/b.log"), "hit b\n");
  await fs.writeFile(path.join(root, "g1/c.log"), "miss\n");
  await fs.mkdir(path.join(root, "tree/sub"), { recursive: true });
  await fs.writeFile(path.join(root, "tree/one.txt"), "1");
  await fs.writeFile(path.join(root, "tree/sub/two.txt"), "2");
  await fs.mkdir(path.join(root, "modes/rec"), { recursive: true });
  await fs.writeFile(path.join(root, "modes/rec/file"), "x");
  return { root, sb: await Sandbox.create(root) };
}

describe("parallel traversal", () => {
  it("keeps explicit grep order under concurrency", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      grepTool,
      { pattern: "hit", paths: ["g1/b.log", "g1/a.log"], withFilename: true },
      sb,
      { concurrency: 4 },
    );
    expect(result.result.stdout.toString()).toBe("g1/b.log:hit b\ng1/a.log:hit a\n");
  });

  it("recursive grep, find and du complete with concurrency", async () => {
    const { root, sb } = await setup();
    const grep = await runSpec(
      grepTool,
      { pattern: "hit", paths: ["g1"], recursive: true },
      sb,
      { concurrency: 4 },
    );
    expect(grep.result.metadata.matched).toBe(true);

    const find = await runSpec(findTool, { paths: ["tree"], type: "f" }, sb, { concurrency: 4 });
    expect(find.result.stdout.toString()).toContain("one.txt");
    expect(find.result.stdout.toString()).toContain("two.txt");

    const du = await runSpec(duTool, { paths: ["tree"], summarize: true }, sb, { concurrency: 4 });
    expect(du.result.metadata.total).toBeGreaterThan(0);

    const chmod = await runSpec(
      chmodTool,
      { paths: ["modes"], mode: "700", recursive: true },
      sb,
      { concurrency: 4 },
    );
    expect((await fs.stat(path.join(root, "modes/rec/file"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(root, "modes/rec"))).mode & 0o777).toBe(0o700);
  });

  it("lists and formats entries with bounded parallelism", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      lsTool,
      { paths: ["g1", "tree"], long: true, numericIds: true },
      sb,
      { concurrency: 2 },
    );
    const text = result.result.stdout.toString();
    expect(text).toContain("a.log");
    expect(text).toContain("sub");
  });
});
