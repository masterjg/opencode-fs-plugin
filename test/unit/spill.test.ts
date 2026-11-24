/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SPILL_THRESHOLD, SpillSink, spillDirectory, spillResult } from "../../src/core/spill.js";

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

  it("resolves the shared spill directory", () => {
    expect(spillDirectory("/tmp/x")).toBe(path.join("/tmp/x", "opencode", "fs-spill"));
  });
});

describe("spillResult", () => {
  it("spills a large finished result", async () => {
    const dir = await tempDir();
    const data = Buffer.alloc(SPILL_THRESHOLD + 1, 120);
    const result = await spillResult({ stdout: data, metadata: { ok: true } }, "tool", dir);
    const metadata = result.metadata as Record<string, unknown>;
    expect(result.stdout.length).toBe(64 * 1024);
    expect(metadata.spilled).toBe(true);
    expect(metadata.bytes).toBe(data.length);
    await expect(fs.readFile(metadata.outputPath as string)).resolves.toHaveLength(data.length);
    await fs.rm(metadata.outputPath as string, { force: true });
  });

  it("passes small and already spilled results through", async () => {
    const dir = await tempDir();
    const small = await spillResult({ stdout: Buffer.from("ok") }, "tool", dir);
    expect(small.stdout.toString()).toBe("ok");
    const already = await spillResult(
      { stdout: Buffer.alloc(SPILL_THRESHOLD + 1), metadata: { outputPath: "/tmp/kept" } },
      "tool",
      dir,
    );
    expect(already.stdout.length).toBe(SPILL_THRESHOLD + 1);
  });

  it("reports a spill failure", async () => {
    await expect(
      spillResult({ stdout: Buffer.alloc(SPILL_THRESHOLD + 1) }, "tool", "/dev/null"),
    ).rejects.toBeTruthy();
  });
});
