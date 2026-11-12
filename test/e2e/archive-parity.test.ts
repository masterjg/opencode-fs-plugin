/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { pipeTool } from "../../src/tools/pipe.js";
import { tarTool } from "../../src/tools/tar.js";
import { unzipTool, zipTool } from "../../src/tools/zip.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-archive-parity-");
  roots.push(root);
  await fs.writeFile(path.join(root, "data.txt"), "streamed\n");
  return { root, sb: await Sandbox.create(root) };
}

describe("archive stream input", () => {
  it("creates tar and zip archives from text input", async () => {
    const { root, sb } = await setup();
    await runSpec(
      tarTool,
      { mode: "create", archive: "stream.tar", input: "hello", member: "hello.txt" },
      sb,
    );
    const tarList = await runSpec(tarTool, { mode: "list", archive: "stream.tar" }, sb);
    expect(tarList.result.stdout.toString()).toContain("hello.txt");

    await runSpec(
      zipTool,
      { archive: "stream.zip", input: "hello", member: "hello.txt" },
      sb,
    );
    const zipList = await runSpec(unzipTool, { archive: "stream.zip", mode: "list" }, sb);
    expect(zipList.result.stdout.toString()).toContain("hello.txt");

    await expect(
      runSpec(tarTool, { mode: "create", archive: "bad.tar" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(zipTool, { archive: "bad.zip" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(tarTool, { mode: "create", archive: "bad.tar", input: "x", member: "" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(zipTool, { archive: "bad.zip", input: "x", member: "" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });

    const defaultName = await runSpec(
      tarTool,
      { mode: "create", archive: "default.tgz", input: "x", verbose: true },
      sb,
    );
    expect(defaultName.result.stdout.toString()).toContain("stdin");
    const defaultZip = await runSpec(zipTool, { archive: "default.zip", input: "x" }, sb);
    expect(defaultZip.result.metadata.members).toBe(1);
  });

  it("feeds tar and zip from a pipe", async () => {
    const { root, sb } = await setup();
    await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "cat", args: { paths: ["data.txt"] } },
          { tool: "tar", args: { mode: "create", archive: "pipe.tar", member: "data.txt" } },
        ],
      },
      sb,
    );
    const tarList = await runSpec(tarTool, { mode: "list", archive: "pipe.tar" }, sb);
    expect(tarList.result.stdout.toString()).toContain("data.txt");

    await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "cat", args: { paths: ["data.txt"] } },
          { tool: "zip", args: { archive: "pipe.zip", member: "data.txt" } },
        ],
      },
      sb,
    );
    const zipList = await runSpec(unzipTool, { archive: "pipe.zip", mode: "list" }, sb);
    expect(zipList.result.stdout.toString()).toContain("data.txt");
    expect(await fs.readFile(path.join(root, "data.txt"), "utf8")).toBe("streamed\n");
  });
});
