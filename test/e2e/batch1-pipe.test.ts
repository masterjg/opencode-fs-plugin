/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { cpioTool } from "../../src/tools/cpio.js";
import { pipeTool } from "../../src/tools/pipe.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-batch1-pipe-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

describe("new pipe stages", () => {
  it("chains text filters", async () => {
    const { sb } = await setup();
    const tac = await runSpec(pipeTool, {
      input: "a\nb\n",
      stages: [{ tool: "rev" }, { tool: "tac" }],
    }, sb);
    expect(tac.result.stdout.toString()).toBe("b\na\n");

    const numbered = await runSpec(pipeTool, {
      input: "a\nb\n",
      stages: [{ tool: "nl", args: { width: 2, separator: ":" } }, { tool: "fold", args: { width: 4 } }],
    }, sb);
    expect(numbered.result.stdout.toString()).toContain(" 1:a");
    expect(numbered.result.stdout.toString()).toContain(":b");
  });

  it("encodes and decodes base64 in a pipeline", async () => {
    const { sb } = await setup();
    const encoded = await runSpec(pipeTool, {
      input: "hello",
      stages: [{ tool: "base64", args: { wrap: 0 } }],
    }, sb);
    expect(encoded.result.stdout.toString()).toBe("aGVsbG8=\n");
    const decoded = await runSpec(pipeTool, {
      input: "aGVsbG8=",
      stages: [{ tool: "base64", args: { decode: true } }],
    }, sb);
    expect(decoded.result.stdout.toString()).toBe("hello");
  });

  it("dumps and extracts binary text through a pipe", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "data"), Buffer.from("hello\0world\n"));
    const dump = await runSpec(pipeTool, {
      stages: [
        { tool: "cat", args: { paths: ["data"] } },
        { tool: "od", args: { width: 8 } },
        { tool: "grep", args: { pattern: "hello" } },
      ],
    }, sb);
    expect(dump.result.stdout.toString()).toContain("hello");

    const strings = await runSpec(pipeTool, {
      stages: [
        { tool: "cat", args: { paths: ["data"] } },
        { tool: "strings", args: { minLength: 5 } },
      ],
    }, sb);
    expect(strings.result.stdout.toString()).toBe("hello\nworld\n");
  });

  it("feeds cpio and dd", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "source"), "0123456789");
    const dd = await runSpec(pipeTool, {
      stages: [
        { tool: "cat", args: { paths: ["source"] } },
        { tool: "dd", args: { blockSize: 4, count: 1 } },
      ],
    }, sb);
    expect(dd.result.stdout.toString()).toBe("0123");

    await fs.writeFile(path.join(root, "log"), "data\n");
    await runSpec(pipeTool, {
      stages: [
        { tool: "cat", args: { paths: ["log"] } },
        { tool: "cpio", args: { mode: "create", archive: "stream.cpio", member: "log" } },
      ],
    }, sb);
    const list = await runSpec(cpioTool, { mode: "list", archive: "stream.cpio" }, sb);
    expect(list.result.stdout.toString()).toBe("log\n");
  });
});
