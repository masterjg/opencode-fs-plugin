/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FsError } from "../../src/core/errors.js";
import {
  collect,
  inputStream,
  lines,
  readFiles,
  toBuffer,
  writeAll,
} from "../../src/core/stream.js";
import { bufferStream, makeRoot } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("stream helpers", () => {
  it("reads files and stdin", async () => {
    const root = await makeRoot();
    roots.push(root);
    const file = path.join(root, "a");
    await fs.writeFile(file, "hello");
    expect((await collect(readFiles([file]))).toString()).toBe("hello");
    expect((await collect(inputStream([file], undefined))).toString()).toBe("hello");
    expect((await collect(inputStream([], bufferStream("stdin")))).toString()).toBe("stdin");
    await expect(collect(inputStream([], undefined))).rejects.toBeInstanceOf(FsError);
  });

  it("reports file read errors", async () => {
    const root = await makeRoot();
    roots.push(root);
    await expect(collect(readFiles([path.join(root, "missing")]))).rejects.toBeInstanceOf(FsError);
  });

  it("collects with a byte limit", async () => {
    expect((await collect(bufferStream("abcdef"), 3)).toString()).toBe("abc");
    expect((await collect(bufferStream(""))).length).toBe(0);
  });

  it("splits lines and preserves missing trailing newlines", async () => {
    const output: Array<{ text: string; newline: boolean }> = [];
    for await (const line of lines(bufferStream("a\nb"))) output.push(line);
    expect(output).toEqual([
      { text: "a", newline: true },
      { text: "b", newline: false },
    ]);
  });

  it("writes buffers and appends", async () => {
    const root = await makeRoot();
    roots.push(root);
    const file = path.join(root, "a");
    await writeAll(file, toBuffer("one"));
    await writeAll(file, toBuffer("two"), true);
    expect(await fs.readFile(file, "utf8")).toBe("onetwo");
    await writeAll(file, bufferStream("three"));
    expect(await fs.readFile(file, "utf8")).toBe("three");
  });

  it("reports write errors", async () => {
    const root = await makeRoot();
    roots.push(root);
    await expect(writeAll(root, toBuffer("x"))).rejects.toBeInstanceOf(FsError);
  });
});
