/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { base64Tool } from "../../src/tools/base64.js";
import { fileTool } from "../../src/tools/file.js";
import { odTool } from "../../src/tools/od.js";
import { stringsTool } from "../../src/tools/strings.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-batch1-binary-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

const stdin = (data: Buffer | string) => ({
  stdin: (async function* () {
    yield typeof data === "string" ? Buffer.from(data) : data;
  })(),
});

describe("file identification", () => {
  it("detects common formats and text", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "empty"), "");
    await fs.writeFile(path.join(root, "ascii"), "hello\n");
    await fs.writeFile(path.join(root, "utf8"), "héllo\n");
    await fs.writeFile(path.join(root, "png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));
    await fs.writeFile(path.join(root, "elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]));
    await fs.writeFile(path.join(root, "gzip"), Buffer.from([0x1f, 0x8b, 8]));
    await fs.writeFile(path.join(root, "data"), Buffer.from([0, 1, 2, 0xff]));
    await fs.writeFile(path.join(root, "invalid"), Buffer.from([0xff, 0xfe]));
    const tar = Buffer.alloc(300);
    tar.write("ustar", 257, "latin1");
    await fs.writeFile(path.join(root, "tar"), tar);

    const result = await runSpec(fileTool, {
      paths: ["empty", "ascii", "utf8", "png", "elf", "gzip", "data", "invalid", "tar"],
    }, sb);
    const text = result.result.stdout.toString();
    expect(text).toContain("empty: empty");
    expect(text).toContain("ascii: ASCII text");
    expect(text).toContain("utf8: UTF-8 Unicode text");
    expect(text).toContain("png: PNG image data");
    expect(text).toContain("elf: ELF executable");
    expect(text).toContain("gzip: gzip compressed data");
    expect(text).toContain("data: data");
    expect(text).toContain("invalid: data");
    expect(text).toContain("tar: POSIX tar archive");

    const mime = await runSpec(fileTool, { paths: ["png"], mime: true }, sb);
    expect(mime.result.stdout.toString()).toBe("png: image/png\n");
    await expect(runSpec(fileTool, { paths: ["missing"] }, sb)).rejects.toMatchObject({ code: "not-found" });
    await expect(runSpec(fileTool, { paths: ["."] }, sb)).rejects.toMatchObject({ code: "not-file" });
  });
});

describe("base64 encode and decode", () => {
  it("wraps, decodes, ignores garbage and rejects invalid input", async () => {
    const { sb } = await setup();
    const plain = await runSpec(base64Tool, { wrap: 0 }, sb, stdin("hello"));
    expect(plain.result.stdout.toString()).toBe("aGVsbG8=\n");
    const wrapped = await runSpec(base64Tool, { wrap: 4 }, sb, stdin("hello"));
    expect(wrapped.result.stdout.toString()).toBe("aGVs\nbG8=\n");
    const decoded = await runSpec(base64Tool, { decode: true }, sb, stdin("aGVsbG8=\n"));
    expect(decoded.result.stdout.toString()).toBe("hello");
    const garbage = await runSpec(base64Tool, { decode: true, ignoreGarbage: true }, sb, stdin("aG Vs!bG8="));
    expect(garbage.result.stdout.toString()).toBe("hello");
    const binary = await runSpec(base64Tool, { decode: true }, sb, stdin(Buffer.from([0, 1, 255]).toString("base64")));
    expect([...binary.result.stdout]).toEqual([0, 1, 255]);
    await expect(runSpec(base64Tool, { decode: true }, sb, stdin("!!!!"))).rejects.toMatchObject({ code: "invalid" });
    await expect(runSpec(base64Tool, { decode: true }, sb, stdin("a"))).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("od and strings", () => {
  it("dumps hex with offsets and filters printable runs", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "data"), "hello\n");
    const dump = await runSpec(odTool, { paths: ["data"], width: 4 }, sb);
    const text = dump.result.stdout.toString();
    expect(text).toMatch(/00000000: 6865 6c6c\s+hell/);
    expect(text).toContain("00000004: 6f0a");
    const sliced = await runSpec(odTool, { paths: ["data"], offset: 1, length: 2 }, sb);
    expect(sliced.result.stdout.toString()).toContain("656c");

    const strings = await runSpec(stringsTool, {}, sb, stdin(Buffer.from("abc\0hello world\0xy")));
    expect(strings.result.stdout.toString()).toBe("hello world\n");
    const short = await runSpec(stringsTool, { minLength: 2 }, sb, stdin("abc\0hello\0"));
    expect(short.result.stdout.toString()).toBe("abc\nhello\n");
  });
});
