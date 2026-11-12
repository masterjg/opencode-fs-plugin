/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { chownTool } from "../../src/tools/chown.js";
import { ddTool } from "../../src/tools/dd.js";
import { syncTool } from "../../src/tools/sync.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-batch1-owner-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

describe("chown", () => {
  it("changes owner and group recursively", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/a"), "a");
    await fs.writeFile(path.join(root, "dir/sub/b"), "b");
    const result = await runSpec(chownTool, { paths: ["dir"], uid, gid, recursive: true }, sb);
    expect(result.result.metadata.changed).toBeGreaterThanOrEqual(4);
    const stats = await fs.stat(path.join(root, "dir/sub/b"));
    expect(Number(stats.uid)).toBe(uid);
    expect(Number(stats.gid)).toBe(gid);
  });

  it("uses names, preserves the missing id and handles symlinks", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "file"), "x");
    await fs.symlink("file", path.join(root, "link"));
    const userOnly = await runSpec(chownTool, { paths: ["file"], user: String(uid) }, sb);
    expect(userOnly.result.metadata).toMatchObject({ uid, gid: null });
    const groupOnly = await runSpec(chownTool, { paths: ["link"], group: String(gid), noDereference: true }, sb);
    expect(groupOnly.result.metadata.changed).toBe(1);
    expect((await fs.lstat(path.join(root, "link"))).isSymbolicLink()).toBe(true);
    await expect(runSpec(chownTool, { paths: ["file"] }, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(chownTool, { paths: ["file"], user: "x", uid: 1 }, sb)).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(chownTool, { paths: ["file"], group: "x", gid: 1 }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("sync and dd", () => {
  it("fsyncs files and directories", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    const result = await runSpec(syncTool, { paths: [".", "a"] }, sb);
    expect(result.result.metadata.synced).toBe(2);
  });

  it("copies blocks with count, skip, seek and status", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "in"), "0123456789");
    const copied = await runSpec(ddTool, { input: "in", output: "out", blockSize: 4, count: 2 }, sb);
    expect(copied.result.metadata).toMatchObject({ bytes: 8, records: 2 });
    expect(await fs.readFile(path.join(root, "out"), "utf8")).toBe("01234567");

    await runSpec(ddTool, { input: "in", output: "skip", blockSize: 4, skip: 1, count: 1 }, sb);
    expect(await fs.readFile(path.join(root, "skip"), "utf8")).toBe("4567");

    await runSpec(ddTool, { input: "in", output: "seek", blockSize: 2, count: 1, seek: 1 }, sb);
    expect((await fs.readFile(path.join(root, "seek"))).subarray(0, 2)).toEqual(Buffer.alloc(2));

    const status = await runSpec(ddTool, { input: "in", blockSize: 4, count: 1, status: true }, sb);
    expect(status.result.stdout.toString()).toContain("bytes copied");
    const stdout = await runSpec(ddTool, { blockSize: 2 }, sb, {
      stdin: (async function* () {
        yield Buffer.from("abcdef");
      })(),
    });
    expect(stdout.result.stdout.toString()).toBe("abcdef");
    await expect(runSpec(ddTool, { blockSize: 2 }, sb)).rejects.toMatchObject({ code: "invalid" });
  });
});
