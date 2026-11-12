/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { statTool } from "../../src/tools/stat.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-stat-parity-");
  roots.push(root);
  await fs.writeFile(path.join(root, "a"), "hello");
  return { root, sb: await Sandbox.create(root) };
}

describe("stat parity tokens", () => {
  it("formats mount point, raw mode, device and birth-time tokens", async () => {
    const { root, sb } = await setup();
    const result = await runSpec(
      statTool,
      { paths: ["a", "a"], format: "%n|%m|%r|%f|%w|%W|%C|%L" },
      sb,
    );
    const text = result.result.stdout.toString();
    expect(text).toContain(path.join(root, "a"));
    expect(text).toContain("|?|");
    expect(text.split("\n")).toHaveLength(2);
  });

  it("supports terse output", async () => {
    const { sb } = await setup();
    const result = await runSpec(statTool, { paths: ["a"], terse: true }, sb);
    const fields = result.result.stdout.toString().trim().split(" ");
    expect(fields[0]).toBe("a");
    expect(fields.length).toBe(15);
  });
});
