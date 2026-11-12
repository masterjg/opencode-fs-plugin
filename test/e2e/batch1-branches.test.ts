/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { arTool } from "../../src/tools/ar.js";
import { commTool } from "../../src/tools/comm.js";
import { cpioTool } from "../../src/tools/cpio.js";
import { dateTool, localIso } from "../../src/tools/date.js";
import { ddTool } from "../../src/tools/dd.js";
import { findmntTool } from "../../src/tools/findmnt.js";
import { foldTool } from "../../src/tools/fold.js";
import { nlTool } from "../../src/tools/nl.js";
import { pasteTool } from "../../src/tools/paste.js";
import { pgrepTool } from "../../src/tools/pgrep.js";
import { psTool } from "../../src/tools/ps.js";
import { shufTool } from "../../src/tools/shuf.js";
import { splitTool } from "../../src/tools/split.js";
import { stringsTool } from "../../src/tools/strings.js";
import { tacTool } from "../../src/tools/tac.js";
import { pretty } from "../../src/tools/uptime.js";
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
  const root = await makeRoot("fs-batch1-branches-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

const stdin = (text: string) => ({
  stdin: (async function* () {
    yield Buffer.from(text);
  })(),
});

function sleeper(): ChildProcess {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child);
  return child;
}

function arHeader(name: string, size: number, fields: { mtime?: string; uid?: string; gid?: string; mode?: string } = {}): string {
  return [
    `${name}/`.padEnd(16, " "),
    (fields.mtime ?? "0").padStart(12, " ").slice(-12),
    (fields.uid ?? "0").padStart(6, " ").slice(-6),
    (fields.gid ?? "0").padStart(6, " ").slice(-6),
    (fields.mode ?? "100644").padStart(8, " ").slice(-8),
    String(size).padStart(10, " ").slice(-10),
    "`\n",
  ].join("");
}

function cpioEntry(name: string, size = 0, mode = 0o100644): Buffer {
  const fields = [1, mode, 0, 0, 1, 0, size, 0, 0, 0, 0, Buffer.byteLength(name) + 1, 0]
    .map((value) => value.toString(8).padStart(8, "0"))
    .join("");
  const header = Buffer.from(`070701${fields}`, "ascii");
  const nameBuffer = Buffer.from(`${name}\0`, "utf8");
  const namePad = Buffer.alloc((4 - (nameBuffer.length % 4)) % 4);
  return Buffer.concat([header, nameBuffer, namePad, Buffer.alloc(size), Buffer.alloc((4 - (size % 4)) % 4)]);
}

describe("empty and error paths", () => {
  it("handles empty inputs and missing-newline records", async () => {
    const { root, sb } = await setup();
    expect((await runSpec(tacTool, {}, sb, stdin(""))).result.stdout.toString()).toBe("");
    expect((await runSpec(shufTool, {}, sb, stdin(""))).result.stdout.toString()).toBe("");
    expect((await runSpec(pasteTool, { serial: true }, sb, stdin(""))).result.stdout.toString()).toBe("");
    expect((await runSpec(nlTool, {}, sb, stdin("a"))).result.stdout.toString()).toBe("     1\ta");
    expect((await runSpec(stringsTool, { minLength: 10 }, sb, stdin("short"))).result.stdout.toString()).toBe("");
    expect((await runSpec(foldTool, {}, sb, stdin(`${"x".repeat(90)}\n`))).result.stdout.toString().split("\n").filter(Boolean)).toHaveLength(2);
    expect((await runSpec(foldTool, { width: 3, spaces: true }, sb, stdin("abcdefgh ij\n"))).result.stdout.toString()).toBe("abc\ndef\ngh \nij\n");

    await fs.writeFile(path.join(root, "empty"), "");
    const byteEmpty = await runSpec(splitTool, { input: "empty", prefix: "b", bytes: 4 }, sb);
    expect(byteEmpty.result.metadata.chunks).toBe(1);
    const lineEmpty = await runSpec(splitTool, { input: "empty", prefix: "l", lines: 2 }, sb);
    expect(lineEmpty.result.metadata.chunks).toBe(1);
    await fs.writeFile(path.join(root, "noeol"), "a\nb");
    const noeol = await runSpec(splitTool, { input: "noeol", prefix: "n", lines: 1 }, sb);
    expect(noeol.result.metadata.chunks).toBe(2);
  });

  it("covers dd limits and comm read failures", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "data"), "0123456789");
    const limited = await runSpec(ddTool, { input: "data", blockSize: 2, count: 1 }, sb);
    expect(limited.result.metadata.bytes).toBe(2);
    const emptyOutput = await runSpec(ddTool, { input: "data", output: "empty-out", blockSize: 4, skip: 5 }, sb);
    expect(emptyOutput.result.metadata.bytes).toBe(0);
    await fs.mkdir(path.join(root, "dir"));
    await expect(runSpec(commTool, { left: "dir", right: "data" }, sb)).rejects.toMatchObject({ code: "not-file" });
    await fs.writeFile(path.join(root, "empty1"), "");
    await fs.writeFile(path.join(root, "empty2"), "");
    const empty = await runSpec(commTool, { left: "empty1", right: "empty2" }, sb);
    expect(empty.result.stdout.toString()).toBe("");
  });

  it("covers date defaults, findmnt headers and uptime durations", async () => {
    const { sb } = await setup();
    const now = await runSpec(dateTool, {}, sb);
    expect(now.result.stdout.toString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const fake = {
      getTimezoneOffset: () => 120,
      getFullYear: () => 2020,
      getMonth: () => 0,
      getDate: () => 2,
      getHours: () => 3,
      getMinutes: () => 4,
      getSeconds: () => 5,
    } as unknown as Date;
    expect(localIso(fake)).toBe("2020-01-02T03:04:05-02:00");
    const defaultHeader = await runSpec(findmntTool, {}, sb);
    expect(defaultHeader.result.stdout.toString()).toContain("TARGET SOURCE FSTYPE OPTIONS");
    expect(pretty(0)).toBe("up 0 minutes");
    expect(pretty(90_000)).toBe("up 1 day, 1 hour, 0 minutes");
    expect(pretty(172_800 + 7_200 + 120)).toBe("up 2 days, 2 hours, 2 minutes");
    expect(pretty(86_460)).toBe("up 1 day, 1 minute");
  });
});

describe("process branch coverage", () => {
  it("sorts multiple processes and filters case-insensitively", async () => {
    const { sb } = await setup();
    const first = sleeper();
    const second = sleeper();
    const newest = await runSpec(pgrepTool, { pattern: "sleep 60", full: true, newest: true }, sb);
    expect(newest.result.metadata.matched).toBe(1);
    expect([first.pid, second.pid]).toContain(Number(newest.result.stdout.toString().trim()));
    const oldest = await runSpec(pgrepTool, { pattern: "SLEEP 60", full: true, ignoreCase: true, oldest: true }, sb);
    expect(oldest.result.metadata.matched).toBe(1);

    const sorted = await runSpec(psTool, {
      pids: [process.pid, first.pid as number],
      sortBy: "rss",
      noHeader: true,
    }, sb);
    expect(sorted.result.metadata.processes).toBe(2);
    const byStart = await runSpec(psTool, {
      pids: [process.pid, first.pid as number],
      sortBy: "start",
      noHeader: true,
    }, sb);
    expect(byStart.result.metadata.processes).toBe(2);
    const none = await runSpec(psTool, { command: "no-such-process-xyz", noHeader: true }, sb);
    expect(none.result.stdout.toString()).toBe("");
  });
});

describe("archive decoder branches", () => {
  it("skips symbol tables and defaults blank ar fields", async () => {
    const { root, sb } = await setup();
    const archive = Buffer.concat([
      Buffer.from("!<arch>\n", "ascii"),
      Buffer.from(arHeader("/", 0), "ascii"),
      Buffer.from(arHeader("b.txt", 0, { mtime: "", uid: "", gid: "", mode: "" }), "ascii"),
    ]);
    await fs.writeFile(path.join(root, "blank.a"), archive);
    const list = await runSpec(arTool, { mode: "list", archive: "blank.a" }, sb);
    expect(list.result.stdout.toString()).toBe("b.txt\n");
    const extracted = await runSpec(arTool, { mode: "extract", archive: "blank.a" }, sb);
    expect(extracted.result.metadata.extracted).toBe(1);
  });

  it("rejects truncated and unsafe ar archives", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "trunc.a"), `!<arch>\n${arHeader("a", 99)}`);
    await expect(runSpec(arTool, { mode: "list", archive: "trunc.a" }, sb)).rejects.toMatchObject({ code: "archive" });
    await fs.writeFile(path.join(root, "evil.a"), Buffer.concat([
      Buffer.from("!<arch>\n", "ascii"),
      Buffer.from(arHeader("../evil", 0), "ascii"),
    ]));
    await expect(runSpec(arTool, { mode: "extract", archive: "evil.a" }, sb)).rejects.toMatchObject({ code: "archive" });
  });

  it("handles cpio truncation, bad magic and unsafe members", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "short.cpio"), "070701");
    await expect(runSpec(cpioTool, { mode: "list", archive: "short.cpio" }, sb)).rejects.toMatchObject({ code: "archive" });
    await fs.writeFile(path.join(root, "bad.cpio"), Buffer.alloc(110, 0x20));
    await expect(runSpec(cpioTool, { mode: "list", archive: "bad.cpio" }, sb)).rejects.toMatchObject({ code: "archive" });

    const trailer = cpioEntry("TRAILER!!!");
    await fs.writeFile(path.join(root, "evil.cpio"), Buffer.concat([cpioEntry("../evil"), trailer]));
    await expect(runSpec(cpioTool, { mode: "extract", archive: "evil.cpio", directory: "out" }, sb)).rejects.toMatchObject({ code: "archive" });

    await runSpec(cpioTool, { mode: "create", archive: "stdin.cpio", input: "x" }, sb);
    const stdinList = await runSpec(cpioTool, { mode: "list", archive: "stdin.cpio" }, sb);
    expect(stdinList.result.stdout.toString()).toBe("stdin\n");

    await fs.writeFile(path.join(root, "file"), "x");
    await runSpec(cpioTool, { mode: "create", archive: "plain.cpio", paths: ["file"] }, sb);
    const list = await runSpec(cpioTool, { mode: "list", archive: "plain.cpio" }, sb);
    expect(list.result.stdout.toString()).toBe("file\n");
    const extracted = await runSpec(cpioTool, { mode: "extract", archive: "plain.cpio" }, sb);
    expect(extracted.result.metadata.extracted).toBe(1);
  });
});
