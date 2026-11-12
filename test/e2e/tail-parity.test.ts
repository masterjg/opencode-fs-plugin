/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { tailTool } from "../../src/tools/tail.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-tail-parity-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

describe("bounded tail follow", () => {
  it("returns initial content and appended data", async () => {
    const { root, sb } = await setup();
    const file = path.join(root, "app.log");
    await fs.writeFile(file, "start\n");
    setTimeout(() => void fs.appendFile(file, "later\n"), 100);
    const result = await runSpec(
      tailTool,
      { paths: ["app.log"], follow: true, timeoutMs: 600, intervalMs: 50 },
      sb,
    );
    expect(result.result.stdout.toString()).toContain("start");
    expect(result.result.stdout.toString()).toContain("later");
  });

  it("starts when the followed file appears", async () => {
    const { root, sb } = await setup();
    const file = path.join(root, "late.log");
    setTimeout(() => void fs.writeFile(file, "created\n"), 100);
    const result = await runSpec(
      tailTool,
      { paths: ["late.log"], follow: true, timeoutMs: 600, intervalMs: 50 },
      sb,
    );
    expect(result.result.stdout.toString()).toContain("created");
  });

  it("handles truncation and maxBytes", async () => {
    const { root, sb } = await setup();
    const file = path.join(root, "trunc.log");
    await fs.writeFile(file, "0123456789\n");
    setTimeout(() => void fs.writeFile(file, "new\n"), 100);
    const result = await runSpec(
      tailTool,
      { paths: ["trunc.log"], follow: true, timeoutMs: 600, intervalMs: 50, maxBytes: 3 },
      sb,
    );
    expect(result.result.stdout.toString()).toContain("new");
    expect(result.result.stdout.toString().length).toBeLessThan(30);
  });

  it("rejects follow without exactly one file and aborts promptly", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(tailTool, { paths: [], follow: true, timeoutMs: 100 }, sb),
    ).rejects.toMatchObject({ code: "invalid" });

    await expect(
      runSpec(tailTool, { paths: ["missing.log"] }, sb),
    ).rejects.toMatchObject({ code: "not-found" });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await runSpec(
      tailTool,
      { paths: ["missing.log"], follow: true, timeoutMs: 5_000, intervalMs: 50 },
      sb,
      { signal: controller.signal },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.result.stdout.length).toBe(0);
  });

  it("supports verbose headers and an already-aborted signal", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "verbose.log"), "start\n");
    const verbose = await runSpec(
      tailTool,
      { paths: ["verbose.log"], follow: true, verbose: true, timeoutMs: 100, intervalMs: 50 },
      sb,
    );
    expect(verbose.result.stdout.toString()).toContain("==> verbose.log <==");

    const controller = new AbortController();
    controller.abort();
    const aborted = await runSpec(
      tailTool,
      { paths: ["verbose.log"], follow: true },
      sb,
      { signal: controller.signal },
    );
    expect(aborted.result.stdout.length).toBe(0);
  });
});
