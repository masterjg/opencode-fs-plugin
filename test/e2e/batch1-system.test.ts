/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { dateTool } from "../../src/tools/date.js";
import { findmntTool } from "../../src/tools/findmnt.js";
import { idTool } from "../../src/tools/id.js";
import { mountpointTool } from "../../src/tools/mountpoint.js";
import { unameTool } from "../../src/tools/uname.js";
import { uptimeTool } from "../../src/tools/uptime.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-batch1-system-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

describe("id, uname and uptime", () => {
  it("prints identity fields", async () => {
    const { sb } = await setup();
    const full = await runSpec(idTool, {}, sb);
    expect(full.result.stdout.toString()).toContain(`uid=${process.getuid?.() ?? 0}`);
    const user = await runSpec(idTool, { only: "user" }, sb);
    expect(user.result.stdout.toString().trim()).toBe(String(process.getuid?.() ?? 0));
    const group = await runSpec(idTool, { only: "group" }, sb);
    expect(group.result.stdout.toString().trim()).toBe(String(process.getgid?.() ?? 0));
    const groups = await runSpec(idTool, { only: "groups" }, sb);
    expect(groups.result.stdout.toString().trim().split(" ").length).toBeGreaterThan(0);
  });

  it("prints uname and uptime fields", async () => {
    const { sb } = await setup();
    const all = await runSpec(unameTool, {}, sb);
    expect(all.result.stdout.toString()).toContain(os.hostname());
    const kernel = await runSpec(unameTool, { kernel: true }, sb);
    expect(kernel.result.stdout.toString().trim()).toBe(os.type());
    const machine = await runSpec(unameTool, { machine: true }, sb);
    expect(machine.result.stdout.toString().trim()).toBe(os.machine());

    const seconds = await runSpec(uptimeTool, {}, sb);
    expect(seconds.result.stdout.toString()).toMatch(/^\d+\.\d{2} seconds/);
    const pretty = await runSpec(uptimeTool, { pretty: true, loadAverage: true }, sb);
    expect(pretty.result.stdout.toString()).toMatch(/^up .*load average: /);
  });
});

describe("date", () => {
  it("formats parsed dates", async () => {
    const { sb } = await setup();
    const iso = await runSpec(dateTool, { value: "@0", utc: true }, sb);
    expect(iso.result.stdout.toString()).toBe("1970-01-01T00:00:00.000Z\n");
    const unix = await runSpec(dateTool, { value: "@0", format: "unix" }, sb);
    expect(unix.result.stdout.toString()).toBe("0\n");
    const rfc = await runSpec(dateTool, { value: "@0", format: "rfc" }, sb);
    expect(rfc.result.stdout.toString()).toContain("Thu, 01 Jan 1970");
    const date = await runSpec(dateTool, { value: "@0", format: "date" }, sb);
    expect(date.result.stdout.toString().length).toBeGreaterThan(0);
    const local = await runSpec(dateTool, { value: "2020-01-02T03:04:05Z" }, sb);
    expect(local.result.stdout.toString()).toMatch(/^2020-01-0[12]T/);
    await expect(runSpec(dateTool, { value: "not-a-date" }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("findmnt and mountpoint", () => {
  it("lists mounts with filters", async () => {
    const { sb } = await setup();
    const all = await runSpec(findmntTool, { noHeader: true }, sb);
    expect(all.result.metadata.mounts).toBeGreaterThan(0);
    const rootOnly = await runSpec(findmntTool, { paths: ["/"], noHeader: true }, sb);
    expect(rootOnly.result.stdout.toString()).toContain("/");
    const proc = await runSpec(findmntTool, { fsType: "proc", noHeader: true }, sb);
    expect(proc.result.metadata.mounts).toBeGreaterThan(0);
    const none = await runSpec(findmntTool, { fsType: "definitely-not-a-fs", noHeader: true }, sb);
    expect(none.result.stdout.toString()).toBe("");
  });

  it("detects mount points and quiet failures", async () => {
    const { root, sb } = await setup();
    const mounted = await runSpec(mountpointTool, { paths: ["/"] }, sb);
    expect(mounted.result.stdout.toString()).toContain("/ is a mountpoint");
    const plain = await runSpec(mountpointTool, { paths: [root] }, sb);
    expect(plain.result.stdout.toString()).toContain("is not a mountpoint");
    expect(plain.result.exitCode).toBe(1);
    const quiet = await runSpec(mountpointTool, { paths: [root], quiet: true }, sb);
    expect(quiet.result.stdout.toString()).toBe("");
    expect(quiet.result.exitCode).toBe(1);
    await expect(runSpec(mountpointTool, { paths: ["missing"] }, sb)).rejects.toMatchObject({ code: "not-found" });
  });
});
