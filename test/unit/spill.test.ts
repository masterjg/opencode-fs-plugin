/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SpillSink, spillDirectory } from "../../src/core/spill.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-spill-test-"));
  dirs.push(dir);
  return dir;
}

describe("SpillSink", () => {
  it("keeps a small result in memory", async () => {
    const dir = await tempDir();
    const sink = new SpillSink(dir, "cat", false, 10, 4);
    await sink.write(Buffer.from("abc"));
    const out = await sink.finish();
    expect(out.path).toBeUndefined();
    expect(out.preview).toEqual(Buffer.from("abc"));
    expect(out.bytes).toBe(3);
  });

  it("spills past the threshold and returns a bounded preview", async () => {
    const dir = await tempDir();
    const sink = new SpillSink(dir, "cat", false, 3, 4);
    await sink.write(Buffer.from("abcdef"));
    await sink.write(Buffer.from("gh"));
    const out = await sink.finish();
    expect(out.preview).toEqual(Buffer.from("abcd"));
    expect(out.bytes).toBe(8);
    expect(out.path).toBeDefined();
    await expect(fs.readFile(out.path as string, "utf8")).resolves.toBe("abcdefgh");
  });

  it("aborts before finish", async () => {
    const dir = await tempDir();
    const sink = new SpillSink(dir, "cat", false, 1, 1);
    await sink.write(Buffer.from("abc"));
    await sink.abort();
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });

  it("keeps the whole stream for pipe stages", async () => {
    const dir = await tempDir();
    const sink = new SpillSink(dir, "cat", true, 3, 4);
    await sink.write(Buffer.from("abcdef"));
    const out = await sink.finish();
    expect(out.path).toBeUndefined();
    expect(out.preview).toEqual(Buffer.from("abcdef"));
    expect(out.bytes).toBe(6);
  });

  it("removes a spilled file on abort", async () => {
    const dir = await tempDir();
    const sink = new SpillSink(dir, "cat", false, 1, 1);
    await sink.write(Buffer.from("abc"));
    const out = await sink.finish();
    const file = out.path as string;
    await expect(fs.stat(file)).resolves.toBeTruthy();
    await sink.abort();
    await expect(fs.stat(file)).rejects.toBeTruthy();
  });

  it("resolves the shared spill directory", () => {
    expect(spillDirectory("/tmp/x")).toBe(path.join("/tmp/x", "opencode", "fs-spill"));
  });
});
