/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { Sandbox } from "../../src/core/sandbox.js";
import { killTool } from "../../src/tools/kill.js";
import { pgrepTool } from "../../src/tools/pgrep.js";
import { psTool } from "../../src/tools/ps.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-batch1-process-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

function sleeper(): ChildProcess {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child);
  return child;
}

describe("ps", () => {
  it("lists the current process as a table and JSON", async () => {
    const { sb } = await setup();
    const table = await runSpec(psTool, { pids: [process.pid], noHeader: true }, sb);
    expect(table.result.stdout.toString()).toContain(String(process.pid));
    expect(table.result.metadata.processes).toBe(1);

    const json = await runSpec(psTool, { pids: [process.pid], format: "json" }, sb);
    const rows = JSON.parse(json.result.stdout.toString()) as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ pid: process.pid });
    expect(String(rows[0]?.command)).toContain("node");
  });

  it("filters by user and command, sorts and limits", async () => {
    const { sb } = await setup();
    const uid = String(process.getuid?.() ?? 0);
    const byUser = await runSpec(psTool, { user: uid, limit: 1, noHeader: true }, sb);
    expect(byUser.result.metadata.processes).toBe(1);
    const byCommand = await runSpec(psTool, { command: "node", pids: [process.pid], noHeader: true }, sb);
    expect(byCommand.result.metadata.processes).toBe(1);
    const byRss = await runSpec(psTool, { pids: [process.pid], sortBy: "rss", noHeader: true }, sb);
    expect(byRss.result.stdout.toString()).toContain(String(process.pid));
    const byStart = await runSpec(psTool, { pids: [process.pid], sortBy: "start", noHeader: true }, sb);
    expect(byStart.result.stdout.toString()).toContain(String(process.pid));
    await expect(runSpec(psTool, { command: "[" }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("pgrep and kill", () => {
  it("finds processes by command line", async () => {
    const { sb } = await setup();
    const child = sleeper();
    const found = await runSpec(pgrepTool, { pattern: "sleep 60", full: true }, sb);
    expect(found.result.stdout.toString().split("\n").filter(Boolean).map(Number)).toContain(child.pid);
    const count = await runSpec(pgrepTool, { pattern: "sleep 60", full: true, count: true }, sb);
    expect(Number(count.result.stdout.toString().trim())).toBeGreaterThanOrEqual(1);
    const newest = await runSpec(pgrepTool, { pattern: "sleep 60", full: true, newest: true }, sb);
    expect(newest.result.metadata.matched).toBe(1);
    const oldest = await runSpec(pgrepTool, { pattern: "sleep 60", full: true, oldest: true }, sb);
    expect(oldest.result.metadata.matched).toBe(1);
    const delimiter = await runSpec(pgrepTool, { pattern: "sleep", full: true, delimiter: " " }, sb);
    expect(delimiter.result.stdout.toString()).toContain(" ");
    const user = await runSpec(pgrepTool, { pattern: "sleep 60", full: true, user: String(process.getuid?.() ?? 0) }, sb);
    expect(user.result.metadata.matched).toBeGreaterThanOrEqual(1);
    const missing = await runSpec(pgrepTool, { pattern: "definitely-not-running-xyz" }, sb);
    expect(missing.result.exitCode).toBe(1);
    await expect(runSpec(pgrepTool, { pattern: "[" }, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(pgrepTool, { pattern: "x", newest: true, oldest: true }, sb)).rejects.toMatchObject({ code: "invalid" });
  });

  it("supports dry runs and real signals", async () => {
    const { sb } = await setup();
    const child = sleeper();
    const dry = await runSpec(killTool, { pids: [child.pid as number], dryRun: true }, sb);
    expect(dry.result.stdout.toString()).toContain(`would signal ${child.pid}`);
    expect(child.exitCode).toBeNull();

    const terminated = await runSpec(killTool, { pids: [child.pid as number], signal: "TERM" }, sb);
    expect(terminated.result.metadata).toMatchObject({ signal: "TERM", dryRun: false });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);

    await expect(runSpec(killTool, { pids: [999_999] }, sb)).rejects.toMatchObject({ code: "not-found" });
    await expect(runSpec(killTool, { pids: [1] }, sb)).rejects.toBeTruthy();
  });
});
