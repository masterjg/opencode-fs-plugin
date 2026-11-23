/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { catTool } from "../../src/tools/cat.js";
import { cpTool } from "../../src/tools/cp.js";
import { findTool } from "../../src/tools/find.js";
import { grepTool } from "../../src/tools/grep.js";
import { hashTool } from "../../src/tools/hash.js";
import { lnTool } from "../../src/tools/ln.js";
import { lsTool } from "../../src/tools/ls.js";
import { mkdirTool } from "../../src/tools/mkdir.js";
import { mvTool } from "../../src/tools/mv.js";
import { sedTool } from "../../src/tools/sed.js";
import { statTool } from "../../src/tools/stat.js";
import { teeTool } from "../../src/tools/tee.js";
import { makeRoot, pathExists, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot("fs-alias-");
  roots.push(root);
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  await fs.writeFile(path.join(root, "g.txt"), "one\ntwo\n");
  return { root, sb: await Sandbox.create(root) };
}

describe("singular path aliases", () => {
  it("stat accepts path", async () => {
    const { sb } = await setup();
    const result = await runSpec(statTool, { path: "a.txt" }, sb);
    expect(result.result.stdout.toString()).toContain("a.txt");
    expect(result.result.metadata).toMatchObject({ paths: ["a.txt"] });
  });

  it("stat rejects an empty path list", async () => {
    const { sb } = await setup();
    await expect(runSpec(statTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("ls accepts path", async () => {
    const { sb } = await setup();
    const result = await runSpec(lsTool, { path: "a.txt" }, sb);
    expect(result.result.stdout.toString()).toContain("a.txt");
  });

  it("cat accepts path", async () => {
    const { sb } = await setup();
    const result = await runSpec(catTool, { path: "a.txt" }, sb);
    expect(result.result.stdout.toString()).toBe("hello\n");
  });

  it("find accepts path", async () => {
    const { sb } = await setup();
    const result = await runSpec(findTool, { path: ".", name: "a.txt" }, sb);
    expect(result.result.stdout.toString()).toContain("a.txt");
  });

  it("tee accepts path with content", async () => {
    const { root, sb } = await setup();
    await runSpec(teeTool, { path: "new.txt", content: "new\n" }, sb);
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("new\n");
  });

  it("tee accepts content without paths", async () => {
    const { sb } = await setup();
    const result = await runSpec(teeTool, { content: "pass\n" }, sb);
    expect(result.result.stdout.toString()).toBe("pass\n");
    expect(result.result.metadata).toMatchObject({ files: [] });
  });
});

describe("hash aliases", () => {
  it.each([
    ["paths", { paths: ["a.txt"] }],
    ["path", { path: "a.txt" }],
    ["files", { files: ["a.txt"] }],
  ])("accepts %s", async (_label, input) => {
    const { sb } = await setup();
    const result = await runSpec(hashTool, input, sb);
    expect(result.result.stdout.toString()).toMatch(/[0-9a-f]{64}/);
  });

  it("reads stdin when no files are given", async () => {
    const { sb } = await setup();
    async function* stdin(): AsyncIterable<Buffer> {
      yield Buffer.from("hello\n");
    }
    const result = await runSpec(hashTool, {}, sb, { stdin: stdin() });
    expect(result.result.stdout.toString()).toContain("  -");
  });
});

describe("mkdir paths alias", () => {
  it("creates every paths entry", async () => {
    const { root, sb } = await setup();
    const result = await runSpec(mkdirTool, { paths: ["d1", "d2"] }, sb);
    expect(result.result.metadata).toMatchObject({ created: true, paths: ["d1", "d2"] });
    expect(await pathExists(path.join(root, "d1"))).toBe(true);
    expect(await pathExists(path.join(root, "d2"))).toBe(true);
  });

  it("rejects path combined with paths", async () => {
    const { sb } = await setup();
    await expect(runSpec(mkdirTool, { path: "d1", paths: ["d2"] }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects an empty mkdir request", async () => {
    const { sb } = await setup();
    await expect(runSpec(mkdirTool, {}, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("source aliases", () => {
  it("cp accepts source", async () => {
    const { root, sb } = await setup();
    await runSpec(cpTool, { source: "a.txt", destination: "b.txt" }, sb);
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("hello\n");
  });

  it("cp rejects an empty source list", async () => {
    const { sb } = await setup();
    await expect(runSpec(cpTool, { destination: "b.txt" }, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("mv accepts source", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "c.txt"), "move\n");
    await runSpec(mvTool, { source: "c.txt", destination: "d.txt" }, sb);
    expect(await pathExists(path.join(root, "c.txt"))).toBe(false);
    expect(await fs.readFile(path.join(root, "d.txt"), "utf8")).toBe("move\n");
  });

  it("mv rejects an empty source list", async () => {
    const { sb } = await setup();
    await expect(runSpec(mvTool, { destination: "d.txt" }, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("ln accepts source", async () => {
    const { root, sb } = await setup();
    await runSpec(lnTool, { source: "a.txt", destination: "link", symbolic: true }, sb);
    expect(await fs.readlink(path.join(root, "link"))).toBe("a.txt");
  });

  it("ln rejects an empty source list", async () => {
    const { sb } = await setup();
    await expect(runSpec(lnTool, { destination: "link" }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("sed expression alias", () => {
  it("accepts expression without script", async () => {
    const { sb } = await setup();
    const result = await runSpec(sedTool, { expression: "s/hello/bye/", path: "a.txt" }, sb);
    expect(result.result.stdout.toString()).toBe("bye\n");
  });

  it("rejects a request with no script or expression", async () => {
    const { sb } = await setup();
    await expect(runSpec(sedTool, { paths: ["a.txt"] }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("grep limit alias", () => {
  it("limits matches with limit", async () => {
    const { sb } = await setup();
    const result = await runSpec(grepTool, { pattern: ".+", path: "g.txt", limit: 1 }, sb);
    expect(result.result.stdout.toString().trim()).toBe("one");
  });

  it("stops filesWithMatches at limit", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      grepTool,
      { pattern: ".+", path: "g.txt", limit: 1, filesWithMatches: true },
      sb,
    );
    expect(result.result.stdout.toString()).toContain("g.txt");
  });
});
