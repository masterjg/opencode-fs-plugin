/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { base64Tool } from "../../src/tools/base64.js";
import { chownTool } from "../../src/tools/chown.js";
import { cpioTool } from "../../src/tools/cpio.js";
import { dateTool } from "../../src/tools/date.js";
import { ddTool } from "../../src/tools/dd.js";
import { findmntTool } from "../../src/tools/findmnt.js";
import { foldTool } from "../../src/tools/fold.js";
import { mountpointTool } from "../../src/tools/mountpoint.js";
import { nlTool } from "../../src/tools/nl.js";
import { odTool } from "../../src/tools/od.js";
import { pasteTool } from "../../src/tools/paste.js";
import { psTool } from "../../src/tools/ps.js";
import { revTool } from "../../src/tools/rev.js";
import { shufTool } from "../../src/tools/shuf.js";
import { splitTool } from "../../src/tools/split.js";
import { stringsTool } from "../../src/tools/strings.js";
import { syncTool } from "../../src/tools/sync.js";
import { tacTool } from "../../src/tools/tac.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-batch1-cov-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

const stdin = (text: string) => ({
  stdin: (async function* () {
    yield Buffer.from(text);
  })(),
});

describe("path inputs for filters", () => {
  it("reads files for tac, rev, nl, fold, shuf and strings", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "aa\nbb\n");
    await fs.writeFile(path.join(root, "bin"), Buffer.from("hello\0world"));
    expect((await runSpec(tacTool, { paths: ["a"] }, sb)).result.stdout.toString()).toBe("bb\naa\n");
    expect((await runSpec(revTool, { paths: ["a"] }, sb)).result.stdout.toString()).toBe("aa\nbb\n");
    expect((await runSpec(nlTool, { paths: ["a"], width: 2 }, sb)).result.stdout.toString()).toContain(" 1\taa");
    expect((await runSpec(foldTool, { paths: ["a"], width: 1 }, sb)).result.stdout.toString()).toBe("a\na\nb\nb\n");
    const shuffled = await runSpec(shufTool, { paths: ["a"] }, sb);
    expect(shuffled.result.stdout.toString().trim().split("\n").sort()).toEqual(["aa", "bb"]);
    const strings = await runSpec(stringsTool, { paths: ["bin"] }, sb);
    expect(strings.result.stdout.toString()).toBe("hello\nworld\n");
  });

  it("encodes and decodes base64 files with the default wrap", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "long"), "x".repeat(80));
    const encoded = await runSpec(base64Tool, { paths: ["long"] }, sb);
    expect(encoded.result.stdout.toString().split("\n").filter(Boolean)).toHaveLength(2);
    await fs.writeFile(path.join(root, "b64"), "aGVsbG8=");
    const decoded = await runSpec(base64Tool, { paths: ["b64"], decode: true }, sb);
    expect(decoded.result.stdout.toString()).toBe("hello");
  });

  it("handles empty od output and default paste delimiters", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "empty"), "");
    const dump = await runSpec(odTool, { paths: ["empty"] }, sb);
    expect(dump.result.stdout.toString()).toBe("");
    await fs.writeFile(path.join(root, "a"), "a\n");
    await fs.writeFile(path.join(root, "b"), "b\n");
    const pasted = await runSpec(pasteTool, { paths: ["a", "b"] }, sb);
    expect(pasted.result.stdout.toString()).toBe("a\tb\n");
    const serial = await runSpec(pasteTool, { paths: ["a", "b"], serial: true }, sb);
    expect(serial.result.stdout.toString()).toBe("a\nb\n");
  });
});

describe("option and error branches", () => {
  it("covers date styles, ps misses and chown non-directories", async () => {
    const { root, sb } = await setup();
    const utcDate = await runSpec(dateTool, { value: "@0", utc: true, format: "date" }, sb);
    expect(utcDate.result.stdout.toString()).toContain("1970");
    const localDate = await runSpec(dateTool, { value: "@0", format: "date" }, sb);
    expect(localDate.result.stdout.toString().length).toBeGreaterThan(0);
    const missing = await runSpec(psTool, { command: "definitely-not-running-xyz" }, sb);
    expect(missing.result.metadata.processes).toBe(0);

    await fs.writeFile(path.join(root, "file"), "x");
    const rec = await runSpec(chownTool, { paths: ["file"], uid: process.getuid?.() ?? 0, recursive: true }, sb);
    expect(rec.result.metadata.changed).toBe(1);
  });

  it("covers mount, split and dd edge paths", async () => {
    const { root, sb } = await setup();
    const mounted = await runSpec(mountpointTool, { paths: ["/"], quiet: true }, sb);
    expect(mounted.result.exitCode).toBe(0);
    const fstype = await runSpec(findmntTool, { paths: ["/tmp"], noHeader: true }, sb);
    expect(fstype.result.metadata.mounts).toBeGreaterThanOrEqual(0);

    await fs.writeFile(path.join(root, "data"), "a\nb\n");
    const defaultPrefix = await runSpec(splitTool, { input: "data", lines: 1 }, sb);
    expect(defaultPrefix.result.metadata.files).toEqual(["xaa", "xab"]);
    const piped = await runSpec(splitTool, { prefix: "p", lines: 1 }, sb, stdin("1\n2\n"));
    expect(piped.result.metadata.chunks).toBe(2);

    const seek = await runSpec(ddTool, { input: "data", blockSize: 2, seek: 1, count: 1 }, sb);
    expect(seek.result.stdout.subarray(0, 2)).toEqual(Buffer.alloc(2));
    const beyond = await runSpec(ddTool, { input: "data", blockSize: 4, skip: 10 }, sb);
    expect(beyond.result.metadata.bytes).toBe(0);
    await expect(runSpec(ddTool, { input: "missing" }, sb)).rejects.toMatchObject({ code: "not-found" });
  });

  it("covers default sync and verbose cpio extraction", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "seed"), "x");
    const synced = await runSpec(syncTool, {}, sb);
    expect(synced.result.metadata.synced).toBe(1);
    await runSpec(cpioTool, { mode: "create", archive: "a.cpio", input: "x", member: "m" }, sb);
    const verbose = await runSpec(cpioTool, { mode: "extract", archive: "a.cpio", directory: "out", verbose: true }, sb);
    expect(verbose.result.stdout.toString()).toBe("m\n");
  });
});
