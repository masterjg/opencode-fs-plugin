/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar-stream";
import { ZipFile as ZipWriter } from "yazl";
import { PermissionGate, type PermissionAssertInput } from "../../src/core/permissions.js";
import {
  chmodDirectoryNoFollow,
  safeDirectoryMode,
  safeMode,
  writeFully,
  writeOutput,
} from "../../src/core/safe-output.js";
import { parseSchema } from "../../src/core/schema.js";
import { Sandbox } from "../../src/core/sandbox.js";
import { collect } from "../../src/core/stream.js";
import type { ToolResult, ToolSpec } from "../../src/core/types.js";
import { arTool } from "../../src/tools/ar.js";
import { cpioTool, hexField } from "../../src/tools/cpio.js";
import { ddTool } from "../../src/tools/dd.js";
import { diffTool } from "../../src/tools/diff.js";
import { grepTool } from "../../src/tools/grep.js";
import { gunzipTool, gzipTool } from "../../src/tools/gzip.js";
import { pipeTool } from "../../src/tools/pipe.js";
import { splitTool } from "../../src/tools/split.js";
import { tarTool } from "../../src/tools/tar.js";
import { teeTool } from "../../src/tools/tee.js";
import { unzipTool, zipTool } from "../../src/tools/zip.js";
import { makeRoot, pathExists } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

interface GatedRun {
  requests: PermissionAssertInput[];
  result?: ToolResult;
  error?: unknown;
}

async function runGated<I>(
  spec: ToolSpec<I>,
  raw: unknown,
  sandbox: Sandbox,
  deny?: (request: PermissionAssertInput) => boolean,
  options: { signal?: AbortSignal } = {},
): Promise<GatedRun> {
  const input = parseSchema<I>(spec.schema, raw, `${spec.name} input`);
  const requests: PermissionAssertInput[] = [];
  const assertPermission = async (request: PermissionAssertInput): Promise<void> => {
    requests.push(request);
    if (deny?.(request) === true) throw new Error("permission denied by test");
  };
  const gateFor = (action: string): PermissionGate =>
    new PermissionGate(
      { sessionID: "ses_test", agent: "worker", messageID: "msg_test", id: "call_test" },
      action,
      (full) => sandbox.resource(full),
      assertPermission,
    );
  try {
    const result = await spec.run(
      {
        sandbox,
        permission: gateFor(`fs_${spec.name}`),
        permissionFor: gateFor,
        concurrency: 4,
        signal: options.signal ?? new AbortController().signal,
        tmpdir: os.tmpdir(),
      },
      input,
      {},
    );
    return { requests, result };
  } catch (error) {
    return { requests, error };
  }
}

const denyExternal = (request: PermissionAssertInput): boolean => request.action === "external_directory";

function expectDenied(run: GatedRun): void {
  expect(run.error).toBeInstanceOf(Error);
  expect((run.error as Error).message).toBe("permission denied by test");
  expect(run.requests).toContainEqual(
    expect.objectContaining({ action: "external_directory" }),
  );
}

function resources(run: GatedRun, action: string): string[] {
  return run.requests.filter((request) => request.action === action).flatMap((request) => request.resources);
}

async function setup() {
  const root = await makeRoot("fs-sec-archive-");
  const outside = await makeRoot("fs-sec-archive-out-");
  roots.push(root, outside);
  const outsideFile = path.join(outside, "target.txt");
  await fs.writeFile(outsideFile, "outside-original");
  return { root, outside, outsideFile, sb: await Sandbox.create(root) };
}

describe("final symlink output writes", () => {
  it("gates tee and writes the canonical target only when external is allowed", async () => {
    const { root, outside, outsideFile, sb } = await setup();
    const link = path.join(root, "tee-link");
    await fs.symlink(outsideFile, link);

    const denied = await runGated(teeTool, { paths: ["tee-link"], content: "pwned" }, sb, denyExternal);
    expectDenied(denied);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");
    expect(resources(denied, "external_directory")).toContain(`${outside}/*`);

    const allowed = await runGated(teeTool, { paths: ["tee-link"], content: "pwned" }, sb);
    expect(allowed.error).toBeUndefined();
    expect(await fs.readFile(outsideFile, "utf8")).toBe("pwned");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(resources(allowed, "fs_tee")).toContain(outsideFile);
  });

  const archiveCases = [
    {
      label: "tar",
      spec: tarTool,
      prepare: async (_root: string, _outsideFile: string) => ({}),
      input: { mode: "create", archive: "archive-link", input: "x", member: "member" },
    },
    {
      label: "zip",
      spec: zipTool,
      prepare: async (_root: string, _outsideFile: string) => ({}),
      input: { archive: "archive-link", input: "x", member: "member" },
    },
    {
      label: "cpio",
      spec: cpioTool,
      prepare: async (_root: string, _outsideFile: string) => ({}),
      input: { mode: "create", archive: "archive-link", input: "x", member: "member" },
    },
    {
      label: "ar",
      spec: arTool,
      prepare: async (root: string, _outsideFile: string) => {
        await fs.writeFile(path.join(root, "member.txt"), "x");
      },
      input: { mode: "create", archive: "archive-link", paths: ["member.txt"] },
    },
  ];

  for (const testCase of archiveCases) {
    it(`gates ${testCase.label} create through an external archive symlink`, async () => {
      const { root, outside, outsideFile, sb } = await setup();
      await testCase.prepare(root, outsideFile);
      await fs.symlink(outsideFile, path.join(root, "archive-link"));

      const denied = await runGated(testCase.spec, testCase.input, sb, denyExternal);
      expectDenied(denied);
      expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");
      expect(resources(denied, "external_directory")).toContain(`${outside}/*`);
    });
  }

  it("gates gzip and gunzip outputs through a symlink", async () => {
    const { root, outside, outsideFile, sb } = await setup();
    await fs.writeFile(path.join(root, "gzin"), "hello");
    await fs.writeFile(path.join(root, "packed.gz"), await gzipped("hello"));
    await fs.symlink(outsideFile, path.join(root, "gzin.gz"));
    await fs.symlink(outsideFile, path.join(root, "packed"));

    const gzipDenied = await runGated(gzipTool, { paths: ["gzin"] }, sb, denyExternal);
    expectDenied(gzipDenied);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");
    expect(resources(gzipDenied, "external_directory")).toContain(`${outside}/*`);

    const gunzipDenied = await runGated(gunzipTool, { paths: ["packed.gz"] }, sb, denyExternal);
    expectDenied(gunzipDenied);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");
    expect(resources(gunzipDenied, "external_directory")).toContain(`${outside}/*`);
  });

  it("gates split, dd and pipe output through a symlink", async () => {
    const { root, outside, outsideFile, sb } = await setup();
    await fs.writeFile(path.join(root, "data"), "hello");
    await fs.symlink(outsideFile, path.join(root, "xaa"));
    await fs.symlink(outsideFile, path.join(root, "dd-out"));
    await fs.symlink(outsideFile, path.join(root, "pipe-out"));

    const splitDenied = await runGated(splitTool, { input: "data", prefix: "x", bytes: 10 }, sb, denyExternal);
    expectDenied(splitDenied);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");
    expect(resources(splitDenied, "external_directory")).toContain(`${outside}/*`);
    expect(await pathExists(path.join(root, "xaa"))).toBe(true);

    const ddDenied = await runGated(ddTool, { input: "data", output: "dd-out" }, sb, denyExternal);
    expectDenied(ddDenied);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");
    expect(resources(ddDenied, "external_directory")).toContain(`${outside}/*`);

    const pipeDenied = await runGated(
      pipeTool,
      { stages: [{ tool: "rev" }], input: "hello\n", output: "pipe-out" },
      sb,
      denyExternal,
    );
    expectDenied(pipeDenied);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");
    expect(resources(pipeDenied, "external_directory")).toContain(`${outside}/*`);
  });

  it("writes an allowed pipe output with append and rejects a directory sink", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "out.txt"), "a");

    const allowed = await runGated(
      pipeTool,
      { stages: [{ tool: "rev" }], input: "b\n", output: "out.txt", append: true },
      sb,
    );
    expect(allowed.error).toBeUndefined();
    expect(await fs.readFile(path.join(root, "out.txt"), "utf8")).toBe("ab\n");

    const directory = await runGated(teeTool, { paths: ["."], content: "x" }, sb);
    expect(directory.error).toMatchObject({ code: "not-file" });
  });

  it("streams to an output and wraps a failing stream", async () => {
    const { root } = await setup();
    const target = path.join(root, "streamed");
    await writeOutput(target, (async function* () {
      yield Buffer.from("a");
      yield Buffer.from("b");
    })());
    expect(await fs.readFile(target, "utf8")).toBe("ab");

    await expect(writeOutput(path.join(root, "failed"), (async function* () {
      throw new Error("stream failed");
    })())).rejects.toMatchObject({ code: "io" });
  });
});

describe("follow-up hardening", () => {
  it("gates a cpio file source by its containing external directory", async () => {
    const { root, outside, outsideFile, sb } = await setup();
    const run = await runGated(
      cpioTool,
      { mode: "create", archive: "source.cpio", paths: [outsideFile], directory: outside },
      sb,
      denyExternal,
    );
    expectDenied(run);
    expect(resources(run, "external_directory")).toContain(`${outside}/*`);
    expect(await pathExists(path.join(root, "source.cpio"))).toBe(false);
  });

  it("preserves stable not-file codes for ar and dd directory outputs", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "archive-out/file"), { recursive: true });
    await fs.writeFile(path.join(root, "member.a"), arArchive("file", Buffer.from("x")));
    const ar = await runGated(
      arTool,
      { mode: "extract", archive: "member.a", directory: "archive-out" },
      sb,
    );
    expect(ar.error).toMatchObject({ code: "not-file" });

    await fs.writeFile(path.join(root, "data"), "x");
    await fs.mkdir(path.join(root, "dd-out"));
    const dd = await runGated(ddTool, { input: "data", output: "dd-out" }, sb);
    expect(dd.error).toMatchObject({ code: "not-file" });
  });

  it("retries partial writes and rejects zero progress", async () => {
    const target = Buffer.alloc(6);
    const partial = {
      async write(data: Buffer, offset: number, length: number, position?: number) {
        const start = position ?? 0;
        const bytesWritten = Math.min(2, length);
        data.copy(target, start, offset, offset + bytesWritten);
        return { bytesWritten, buffer: data };
      },
    } as unknown as import("node:fs/promises").FileHandle;
    await writeFully(partial, Buffer.from("abcdef"), 0);
    expect(target.toString("utf8")).toBe("abcdef");

    const stuck = {
      async write() {
        return { bytesWritten: 0, buffer: Buffer.alloc(0) };
      },
    } as unknown as import("node:fs/promises").FileHandle;
    await expect(writeFully(stuck, Buffer.from("x"), 0)).rejects.toMatchObject({ code: "io" });

    const failing = {
      async write() {
        throw new Error("write failed");
      },
    } as unknown as import("node:fs/promises").FileHandle;
    await expect(writeFully(failing, Buffer.from("x"), 0)).rejects.toMatchObject({ code: "io" });
  });

  it("surfaces an aborted signal as interrupted before writing", async () => {
    const { root, sb } = await setup();
    const controller = new AbortController();
    controller.abort();
    const run = await runGated(
      teeTool,
      { paths: ["aborted"], content: "x" },
      sb,
      undefined,
      { signal: controller.signal },
    );
    expect(run.error).toMatchObject({ code: "interrupted" });
    expect(await pathExists(path.join(root, "aborted"))).toBe(false);

    await fs.writeFile(path.join(root, "input"), "x");
    const archiveRun = await runGated(
      cpioTool,
      { mode: "create", archive: "aborted.cpio", paths: ["input"] },
      sb,
      undefined,
      { signal: controller.signal },
    );
    expect(archiveRun.error).toMatchObject({ code: "interrupted" });
    expect(await pathExists(path.join(root, "aborted.cpio"))).toBe(false);
  });

  it("honors tar create directory and nested source member names", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "base/dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "base/dir/sub/file"), "base");
    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/sub/file"), "nested");

    const withDirectory = await runGated(
      tarTool,
      { mode: "create", archive: "base.tar", directory: "base", paths: ["dir/sub"] },
      sb,
    );
    expect(withDirectory.error).toBeUndefined();
    const baseList = await runGated(tarTool, { mode: "list", archive: "base.tar" }, sb);
    expect(baseList.result?.metadata?.members).toEqual(["dir/sub", "dir/sub/file"]);

    const nested = await runGated(
      tarTool,
      { mode: "create", archive: "nested.tar", paths: ["dir/sub"] },
      sb,
    );
    expect(nested.error).toBeUndefined();
    const nestedList = await runGated(tarTool, { mode: "list", archive: "nested.tar" }, sb);
    expect(nestedList.result?.metadata?.members).toEqual(["dir/sub", "dir/sub/file"]);

    const absolute = await runGated(
      tarTool,
      {
        mode: "create",
        archive: "absolute.tar",
        directory: "base",
        paths: [path.join(root, "base/dir/sub")],
      },
      sb,
    );
    expect(absolute.error).toBeUndefined();
    const absoluteList = await runGated(tarTool, { mode: "list", archive: "absolute.tar" }, sb);
    expect(absoluteList.result?.metadata?.members).toEqual(["dir/sub", "dir/sub/file"]);

    const absoluteOutsideBase = await runGated(
      tarTool,
      {
        mode: "create",
        archive: "absolute-root.tar",
        directory: "base",
        paths: [path.join(root, "dir/sub")],
      },
      sb,
    );
    expect(absoluteOutsideBase.error).toBeUndefined();
    const rootList = await runGated(tarTool, { mode: "list", archive: "absolute-root.tar" }, sb);
    expect(rootList.result?.metadata?.members).toEqual(["dir/sub", "dir/sub/file"]);

    const extracted = await runGated(
      tarTool,
      { mode: "extract", archive: "base.tar", directory: "out" },
      sb,
    );
    expect(extracted.error).toBeUndefined();
    expect(await fs.readFile(path.join(root, "out/dir/sub/file"), "utf8")).toBe("base");
  });

  it("falls back to safe tar member names for traversing and external sources", async () => {
    const { root, outsideFile, sb } = await setup();
    await fs.mkdir(path.join(root, "base"));
    await fs.mkdir(path.join(root, "outside"));
    await fs.writeFile(path.join(root, "outside/file"), "x");

    const relativeEscape = await runGated(
      tarTool,
      { mode: "create", archive: "escape.tar", directory: "base", paths: ["../outside/file"] },
      sb,
    );
    expect(relativeEscape.error).toBeUndefined();
    const escapeList = await runGated(tarTool, { mode: "list", archive: "escape.tar" }, sb);
    expect(escapeList.result?.metadata?.members).toEqual(["file"]);

    const external = await runGated(
      tarTool,
      { mode: "create", archive: "external.tar", paths: [outsideFile] },
      sb,
    );
    expect(external.error).toBeUndefined();
    const externalList = await runGated(tarTool, { mode: "list", archive: "external.tar" }, sb);
    expect(externalList.result?.metadata?.members).toEqual(["target.txt"]);

    const self = await runGated(
      tarTool,
      { mode: "create", archive: "self.tar", directory: ".", paths: [root] },
      sb,
    );
    expect(self.error).toBeUndefined();
    const selfList = await runGated(tarTool, { mode: "list", archive: "self.tar" }, sb);
    const names = selfList.result?.metadata?.members as string[];
    expect(names[0]).toBe(path.basename(root));
    expect(names).toContain(`${path.basename(root)}/outside/file`);
  });

  it("keeps tar exclusion and bounded traversal order", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "dir/skip"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/a.txt"), "a");
    await fs.writeFile(path.join(root, "dir/skip/b.txt"), "b");
    await fs.writeFile(path.join(root, "dir/z.txt"), "z");

    const created = await runGated(
      tarTool,
      { mode: "create", archive: "tree.tar", paths: ["dir"], exclude: ["skip"] },
      sb,
    );
    expect(created.error).toBeUndefined();
    const list = await runGated(tarTool, { mode: "list", archive: "tree.tar" }, sb);
    const output = list.result?.stdout.toString() ?? "";
    expect(output).toContain("dir/a.txt");
    expect(output).toContain("dir/z.txt");
    expect(output).not.toContain("skip");
  });

  it("refuses a directory member final symlink even when external is allowed", async () => {
    const { root, outside, sb } = await setup();
    await fs.writeFile(path.join(root, "dir.cpio"), Buffer.concat([
      newcEntry("dir", Buffer.alloc(0), 0o040755),
      newcTrailer(),
    ]));
    await fs.mkdir(path.join(root, "out"));
    await fs.symlink(outside, path.join(root, "out/dir"), "dir");

    const run = await runGated(
      cpioTool,
      { mode: "extract", archive: "dir.cpio", directory: "out" },
      sb,
    );
    expect(run.error).toMatchObject({ code: "archive" });
    expect(run.requests.every((request) => !request.resources.includes("out/dir"))).toBe(true);
    expect(await fs.readFile(path.join(outside, "target.txt"), "utf8")).toBe("outside-original");
    expect((await fs.lstat(path.join(root, "out/dir"))).isSymbolicLink()).toBe(true);
  });
});

describe("final review hardening", () => {
  const preflightCases = [
    {
      label: "tar",
      createSpec: tarTool,
      create: { mode: "create", archive: "two.tar", paths: ["a", "b"] },
      extractSpec: tarTool,
      extract: { mode: "extract", archive: "two.tar", directory: "out" },
      action: "fs_tar",
    },
    {
      label: "zip",
      createSpec: zipTool,
      create: { archive: "two.zip", paths: ["a", "b"] },
      extractSpec: unzipTool,
      extract: { archive: "two.zip", directory: "out" },
      action: "fs_unzip",
    },
    {
      label: "cpio",
      createSpec: cpioTool,
      create: { mode: "create", archive: "two.cpio", paths: ["a", "b"] },
      extractSpec: cpioTool,
      extract: { mode: "extract", archive: "two.cpio", directory: "out" },
      action: "fs_cpio",
    },
    {
      label: "ar",
      createSpec: arTool,
      create: { mode: "create", archive: "two.a", paths: ["a", "b"] },
      extractSpec: arTool,
      extract: { mode: "extract", archive: "two.a", directory: "out" },
      action: "fs_ar",
    },
  ] as const;

  for (const testCase of preflightCases) {
    it(`plans every ${testCase.label} extraction target before writing`, async () => {
      const { root, sb } = await setup();
      await fs.writeFile(path.join(root, "a"), "a");
      await fs.writeFile(path.join(root, "b"), "b");
      const created = await runGated(testCase.createSpec, testCase.create, sb);
      expect(created.error).toBeUndefined();

      const denied = await runGated(
        testCase.extractSpec,
        testCase.extract,
        sb,
        (request) => request.action === testCase.action && request.resources.includes("out/b"),
      );
      expect((denied.error as Error).message).toBe("permission denied by test");
      const memberRequest = denied.requests.find(
        (request) => request.action === testCase.action && request.resources.includes("out/b"),
      );
      expect(memberRequest?.resources).toEqual(expect.arrayContaining(["out/a", "out/b"]));
      expect(await pathExists(path.join(root, "out/a"))).toBe(false);
      expect(await pathExists(path.join(root, "out/b"))).toBe(false);
    });
  }

  const finalFileLinkCases = [
    {
      label: "tar",
      archive: "file.tar",
      member: "file",
      createSpec: tarTool,
      create: { mode: "create", archive: "file.tar", input: "x", member: "file" },
      extractSpec: tarTool,
      extract: { mode: "extract", archive: "file.tar", directory: "out" },
    },
    {
      label: "zip",
      archive: "file.zip",
      member: "file",
      createSpec: zipTool,
      create: { archive: "file.zip", input: "x", member: "file" },
      extractSpec: unzipTool,
      extract: { archive: "file.zip", directory: "out" },
    },
    {
      label: "cpio",
      archive: "file.cpio",
      member: "file",
      createSpec: cpioTool,
      create: { mode: "create", archive: "file.cpio", input: "x", member: "file" },
      extractSpec: cpioTool,
      extract: { mode: "extract", archive: "file.cpio", directory: "out" },
    },
    {
      label: "ar",
      archive: "file.a",
      member: "source",
      createSpec: arTool,
      create: { mode: "create", archive: "file.a", paths: ["source"] },
      extractSpec: arTool,
      extract: { mode: "extract", archive: "file.a", directory: "out" },
    },
  ] as const;

  for (const testCase of finalFileLinkCases) {
    it(`refuses a ${testCase.label} file destination final symlink`, async () => {
      const { root, outside, outsideFile, sb } = await setup();
      if (testCase.label === "ar") await fs.writeFile(path.join(root, "source"), "x");
      const created = await runGated(testCase.createSpec, testCase.create, sb);
      expect(created.error).toBeUndefined();
      await fs.mkdir(path.join(root, "out"));
      await fs.symlink(outsideFile, path.join(root, "out", testCase.member));

      const run = await runGated(testCase.extractSpec, testCase.extract, sb);
      expect(run.error).toMatchObject({ code: "archive" });
      expect(run.requests.every((request) => !request.resources.includes(`out/${testCase.member}`))).toBe(true);
      expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");
      expect((await fs.lstat(path.join(root, "out", testCase.member))).isSymbolicLink()).toBe(true);
      expect(await fs.readdir(outside)).toEqual(["target.txt"]);
    });
  }

  const finalDirectoryLinkCases = [
    {
      label: "tar",
      createSpec: tarTool,
      create: { mode: "create", archive: "dir.tar", paths: ["dir"] },
      extractSpec: tarTool,
      extract: { mode: "extract", archive: "dir.tar", directory: "out" },
    },
    {
      label: "zip",
      createSpec: zipTool,
      create: { archive: "dir.zip", paths: ["dir"] },
      extractSpec: unzipTool,
      extract: { archive: "dir.zip", directory: "out" },
    },
    {
      label: "cpio",
      createSpec: cpioTool,
      create: { mode: "create", archive: "dir.cpio", paths: ["dir"] },
      extractSpec: cpioTool,
      extract: { mode: "extract", archive: "dir.cpio", directory: "out" },
    },
  ] as const;

  for (const testCase of finalDirectoryLinkCases) {
    it(`refuses a ${testCase.label} directory destination final symlink`, async () => {
      const { root, outside, sb } = await setup();
      await fs.mkdir(path.join(root, "dir"));
      const created = await runGated(testCase.createSpec, testCase.create, sb);
      expect(created.error).toBeUndefined();
      await fs.mkdir(path.join(root, "out"));
      await fs.symlink(outside, path.join(root, "out/dir"), "dir");

      const run = await runGated(testCase.extractSpec, testCase.extract, sb);
      expect(run.error).toMatchObject({ code: "archive" });
      expect(await fs.readFile(path.join(outside, "target.txt"), "utf8")).toBe("outside-original");
      expect((await fs.lstat(path.join(root, "out/dir"))).isSymbolicLink()).toBe(true);
    });
  }

  it("refuses an archive symlink entry over an existing destination", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "symlink.cpio"), Buffer.concat([
      newcEntry("link", Buffer.from("target"), 0o120777),
      newcTrailer(),
    ]));
    await fs.mkdir(path.join(root, "out"));
    await fs.writeFile(path.join(root, "out/link"), "keep");

    const run = await runGated(
      cpioTool,
      { mode: "extract", archive: "symlink.cpio", directory: "out" },
      sb,
    );
    expect(run.error).toMatchObject({ code: "archive" });
    expect(await fs.readFile(path.join(root, "out/link"), "utf8")).toBe("keep");
    expect((await fs.lstat(path.join(root, "out/link"))).isSymbolicLink()).toBe(false);
  });

  it("emits safe cpio names for nested and external sources", async () => {
    const { root, outsideFile, sb } = await setup();
    await fs.mkdir(path.join(root, "dir/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dir/sub/file"), "nested");

    const created = await runGated(
      cpioTool,
      { mode: "create", archive: "nested.cpio", paths: ["dir/sub"] },
      sb,
    );
    expect(created.error).toBeUndefined();
    const list = await runGated(cpioTool, { mode: "list", archive: "nested.cpio" }, sb);
    expect(list.result?.stdout.toString()).toBe("dir/sub\ndir/sub/file\n");
    const extracted = await runGated(
      cpioTool,
      { mode: "extract", archive: "nested.cpio", directory: "out" },
      sb,
    );
    expect(extracted.error).toBeUndefined();
    expect(await fs.readFile(path.join(root, "out/dir/sub/file"), "utf8")).toBe("nested");

    const external = await runGated(
      cpioTool,
      { mode: "create", archive: "external.cpio", paths: [outsideFile] },
      sb,
    );
    expect(external.error).toBeUndefined();
    const externalList = await runGated(cpioTool, { mode: "list", archive: "external.cpio" }, sb);
    expect(externalList.result?.stdout.toString()).toBe("target.txt\n");
    const externalExtract = await runGated(
      cpioTool,
      { mode: "extract", archive: "external.cpio", directory: "external-out" },
      sb,
    );
    expect(externalExtract.error).toBeUndefined();
    expect(await fs.readFile(path.join(root, "external-out/target.txt"), "utf8")).toBe("outside-original");

    const unsafeRelative = path.relative(root, outsideFile);
    const unsafe = await runGated(
      cpioTool,
      { mode: "create", archive: "unsafe.cpio", paths: [unsafeRelative] },
      sb,
    );
    expect(unsafe.error).toBeUndefined();
    const unsafeList = await runGated(cpioTool, { mode: "list", archive: "unsafe.cpio" }, sb);
    expect(unsafeList.result?.stdout.toString()).toBe("target.txt\n");
  });

  it("validates cpio hex field boundaries", () => {
    expect(hexField(0)).toBe("00000000");
    expect(hexField(0xffffffff)).toBe("ffffffff");
    for (const value of [-1, 1.5, Number.NaN, 0x100000000]) {
      expect(() => hexField(value)).toThrowError(/out of range/);
    }
  });

  const modeCases = [
    {
      label: "tar",
      createSpec: tarTool,
      create: { mode: "create", archive: "mode.tar", paths: ["setuid"] },
      extractSpec: tarTool,
      extract: { mode: "extract", archive: "mode.tar", directory: "out" },
    },
    {
      label: "zip",
      createSpec: zipTool,
      create: { archive: "mode.zip", paths: ["setuid"] },
      extractSpec: unzipTool,
      extract: { archive: "mode.zip", directory: "out" },
    },
    {
      label: "cpio",
      createSpec: cpioTool,
      create: { mode: "create", archive: "mode.cpio", paths: ["setuid"] },
      extractSpec: cpioTool,
      extract: { mode: "extract", archive: "mode.cpio", directory: "out" },
    },
    {
      label: "ar",
      createSpec: arTool,
      create: { mode: "create", archive: "mode.a", paths: ["setuid"] },
      extractSpec: arTool,
      extract: { mode: "extract", archive: "mode.a", directory: "out" },
    },
  ] as const;

  for (const testCase of modeCases) {
    it(`strips setuid/setgid on ${testCase.label} extraction`, async () => {
      const { root, sb } = await setup();
      const source = path.join(root, "setuid");
      await fs.writeFile(source, "#!/bin/sh\n");
      await fs.chmod(source, 0o6755);
      expect((await fs.stat(source)).mode & 0o7000).toBe(0o6000);

      const created = await runGated(testCase.createSpec, testCase.create, sb);
      expect(created.error).toBeUndefined();
      const extracted = await runGated(testCase.extractSpec, testCase.extract, sb);
      expect(extracted.error).toBeUndefined();
      const mode = (await fs.stat(path.join(root, "out/setuid"))).mode;
      expect(mode & 0o7000).toBe(0);
      expect(await fs.readFile(path.join(root, "out/setuid"), "utf8")).toBe("#!/bin/sh\n");
    });
  }

  it("aborts archive list collection, diff planning, and pipe stages", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.writeFile(path.join(root, "b"), "b");
    await runGated(tarTool, { mode: "create", archive: "list.tar", paths: ["a", "b"] }, sb);
    await runGated(zipTool, { archive: "list.zip", paths: ["a", "b"] }, sb);

    const preAborted = new AbortController();
    preAborted.abort();
    const tarList = await runGated(
      tarTool,
      { mode: "list", archive: "list.tar" },
      sb,
      undefined,
      { signal: preAborted.signal },
    );
    expect(tarList.error).toMatchObject({ code: "interrupted" });

    let checks = 0;
    const midSignal = {
      get aborted() {
        return checks++ >= 1;
      },
    } as AbortSignal;
    const midList = await runGated(
      tarTool,
      { mode: "list", archive: "list.tar" },
      sb,
      undefined,
      { signal: midSignal },
    );
    expect(midList.error).toMatchObject({ code: "interrupted" });

    const zipList = await runGated(
      unzipTool,
      { archive: "list.zip", mode: "list" },
      sb,
      undefined,
      { signal: preAborted.signal },
    );
    expect(zipList.error).toMatchObject({ code: "interrupted" });

    await fs.mkdir(path.join(root, "left"));
    await fs.mkdir(path.join(root, "right"));
    await fs.writeFile(path.join(root, "left/f"), "x");
    await fs.writeFile(path.join(root, "right/f"), "x");
    const diff = await runGated(
      diffTool,
      { left: "left", right: "right", recursive: true },
      sb,
      undefined,
      { signal: preAborted.signal },
    );
    expect(diff.error).toMatchObject({ code: "interrupted" });

    const pipe = await runGated(
      pipeTool,
      { stages: [{ tool: "rev" }], input: "x\n", output: "pipe-out" },
      sb,
      undefined,
      { signal: preAborted.signal },
    );
    expect(pipe.error).toMatchObject({ code: "interrupted" });
    expect(await pathExists(path.join(root, "pipe-out"))).toBe(false);
  });

  it("preserves empty pipe output for a non-Buffer stage result", async () => {
    const { root, sb } = await setup();
    const original = teeTool.run;
    teeTool.run = (async () => ({
      stdout: undefined as unknown as Buffer,
      exitCode: 0,
    })) as typeof teeTool.run;
    try {
      const run = await runGated(
        pipeTool,
        { stages: [{ tool: "tee", args: { content: "x" } }], input: "y\n", output: "empty-out" },
        sb,
      );
      expect(run.error).toBeUndefined();
      expect(run.result?.stdout.toString()).toBe("");
      expect(await fs.readFile(path.join(root, "empty-out"), "utf8")).toBe("");
    } finally {
      teeTool.run = original;
    }
  });
});

describe("final semantic hardening", () => {
  const symlinkChildCases = [
    {
      label: "tar",
      archive: "symlink.tar",
      write: async (root: string) => fs.writeFile(path.join(root, "symlink.tar"), await tarSymlinkChildArchive("")),
      extractSpec: tarTool,
      extract: { mode: "extract", archive: "symlink.tar", directory: "out" },
    },
    {
      label: "zip",
      archive: "symlink.zip",
      write: async (root: string) => fs.writeFile(path.join(root, "symlink.zip"), await zipSymlinkChildArchive("")),
      extractSpec: unzipTool,
      extract: { archive: "symlink.zip", directory: "out" },
    },
    {
      label: "cpio",
      archive: "symlink.cpio",
      write: async (root: string) => fs.writeFile(path.join(root, "symlink.cpio"), cpioSymlinkChildArchive("")),
      extractSpec: cpioTool,
      extract: { mode: "extract", archive: "symlink.cpio", directory: "out" },
    },
  ] as const;

  for (const testCase of symlinkChildCases) {
    it(`rejects ${testCase.label} members beneath an archive-created symlink`, async () => {
      const { root, outside, sb } = await setup();
      await testCase.write(root);
      await fs.mkdir(path.join(root, "out"));
      await fs.symlink(outside, path.join(root, "out/sub"), "dir");

      const run = await runGated(testCase.extractSpec, testCase.extract, sb);
      expect(run.error).toMatchObject({ code: "archive" });
      expect(await pathExists(path.join(root, "out/link"))).toBe(false);
      expect(await pathExists(path.join(outside, "pwn"))).toBe(false);
      expect(await fs.readFile(path.join(outside, "target.txt"), "utf8")).toBe("outside-original");
    });
  }

  it("rejects a tar symlink ancestor after strip-components canonicalization", async () => {
    const { root, outside, sb } = await setup();
    await fs.writeFile(path.join(root, "strip.tar"), await tarSymlinkChildArchive("prefix"));
    await fs.mkdir(path.join(root, "out"));
    await fs.symlink(outside, path.join(root, "out/sub"), "dir");

    const run = await runGated(
      tarTool,
      { mode: "extract", archive: "strip.tar", directory: "out", stripComponents: 1 },
      sb,
    );
    expect(run.error).toMatchObject({ code: "archive" });
    expect(await pathExists(path.join(root, "out/link"))).toBe(false);
    expect(await pathExists(path.join(outside, "pwn"))).toBe(false);
  });

  it("rejects canonical and duplicate archive symlink collisions", async () => {
    const { root, outside, sb } = await setup();
    await fs.writeFile(path.join(root, "canonical.cpio"), Buffer.concat([
      newcEntry("a/./link", Buffer.from("sub"), 0o120777),
      newcEntry("a/link/file", Buffer.from("pwned")),
      newcTrailer(),
    ]));
    await fs.writeFile(path.join(root, "duplicate.cpio"), Buffer.concat([
      newcEntry("link", Buffer.from("sub"), 0o120777),
      newcEntry("link", Buffer.from("pwned")),
      newcTrailer(),
    ]));
    await fs.mkdir(path.join(root, "out"));
    await fs.symlink(outside, path.join(root, "out/sub"), "dir");

    const canonical = await runGated(
      cpioTool,
      { mode: "extract", archive: "canonical.cpio", directory: "out" },
      sb,
    );
    expect(canonical.error).toMatchObject({ code: "archive" });
    expect(await pathExists(path.join(root, "out/link"))).toBe(false);

    const duplicate = await runGated(
      cpioTool,
      { mode: "extract", archive: "duplicate.cpio", directory: "out" },
      sb,
    );
    expect(duplicate.error).toMatchObject({ code: "archive" });
    expect(await pathExists(path.join(root, "out/link"))).toBe(false);
    expect(await pathExists(path.join(outside, "pwn"))).toBe(false);
  });

  it("applies safe ZIP defaults when Unix mode bits are absent", async () => {
    const { root, sb } = await setup();
    const previous = process.umask(0o022);
    try {
      await fs.writeFile(path.join(root, "dos.zip"), await zipDosModeArchive());
      const run = await runGated(unzipTool, { archive: "dos.zip", directory: "out" }, sb);
      expect(run.error).toBeUndefined();
      expect((await fs.stat(path.join(root, "out/dos.txt"))).mode & 0o7777).toBe(0o644);
      expect((await fs.stat(path.join(root, "out/dosdir"))).mode & 0o7777).toBe(0o755);
      expect(await fs.readFile(path.join(root, "out/dos.txt"), "utf8")).toBe("dos");
    } finally {
      process.umask(previous);
    }
  });

  const directoryModeCases = [
    {
      label: "tar",
      createSpec: tarTool,
      create: { mode: "create", archive: "modes.tar", paths: ["src"] },
      extractSpec: tarTool,
      extract: { mode: "extract", archive: "modes.tar", directory: "out" },
    },
    {
      label: "zip",
      createSpec: zipTool,
      create: { archive: "modes.zip", paths: ["src"] },
      extractSpec: unzipTool,
      extract: { archive: "modes.zip", directory: "out" },
    },
    {
      label: "cpio",
      createSpec: cpioTool,
      create: { mode: "create", archive: "modes.cpio", paths: ["src"] },
      extractSpec: cpioTool,
      extract: { mode: "extract", archive: "modes.cpio", directory: "out" },
    },
  ] as const;

  for (const testCase of directoryModeCases) {
    it(`applies private and sticky directory modes on ${testCase.label} extraction`, async () => {
      const previous = process.umask(0o022);
      try {
        const { root, sb } = await setup();
        await fs.mkdir(path.join(root, "src/private"), { recursive: true });
        await fs.mkdir(path.join(root, "src/sticky"), { recursive: true });
        await fs.writeFile(path.join(root, "src/private/only-owner"), "x");
        await fs.writeFile(path.join(root, "src/sticky/shared"), "x");
        await fs.chmod(path.join(root, "src/private"), 0o700);
        await fs.chmod(path.join(root, "src/sticky"), 0o1777);

        const created = await runGated(testCase.createSpec, testCase.create, sb);
        expect(created.error).toBeUndefined();
        const extracted = await runGated(testCase.extractSpec, testCase.extract, sb);
        expect(extracted.error).toBeUndefined();
        expect((await fs.stat(path.join(root, "out/src/private"))).mode & 0o7777).toBe(0o700);
        expect((await fs.stat(path.join(root, "out/src/sticky"))).mode & 0o7777).toBe(0o1755);
        expect(await fs.readFile(path.join(root, "out/src/private/only-owner"), "utf8")).toBe("x");
        expect(await fs.readFile(path.join(root, "out/src/sticky/shared"), "utf8")).toBe("x");
      } finally {
        process.umask(previous);
      }
    });
  }

  it("applies only the last duplicate directory mode", async () => {
    const previous = process.umask(0o022);
    try {
      const { root, sb } = await setup();
      await fs.writeFile(path.join(root, "duplicate-dir.cpio"), Buffer.concat([
        newcEntry("d", Buffer.alloc(0), 0o040300),
        newcEntry("d", Buffer.alloc(0), 0o040755),
        newcTrailer(),
      ]));
      const run = await runGated(
        cpioTool,
        { mode: "extract", archive: "duplicate-dir.cpio", directory: "out" },
        sb,
      );
      expect(run.error).toBeUndefined();
      expect((await fs.stat(path.join(root, "out/d"))).mode & 0o7777).toBe(0o755);

      await fs.writeFile(path.join(root, "alias-dir.cpio"), Buffer.concat([
        newcEntry("d", Buffer.alloc(0), 0o040300),
        newcEntry("./d", Buffer.alloc(0), 0o040755),
        newcTrailer(),
      ]));
      const alias = await runGated(
        cpioTool,
        { mode: "extract", archive: "alias-dir.cpio", directory: "alias-out" },
        sb,
      );
      expect(alias.error).toBeUndefined();
      expect((await fs.stat(path.join(root, "alias-out/d"))).mode & 0o7777).toBe(0o755);
    } finally {
      process.umask(previous);
    }
  });

  it("updates an existing unreadable directory mode", async () => {
    const previous = process.umask(0o022);
    try {
      const { root, sb } = await setup();
      await fs.writeFile(path.join(root, "unreadable.cpio"), Buffer.concat([
        newcEntry("d", Buffer.alloc(0), 0o040755),
        newcTrailer(),
      ]));
      await fs.mkdir(path.join(root, "out/d"), { recursive: true });
      await fs.chmod(path.join(root, "out/d"), 0o311);
      const run = await runGated(
        cpioTool,
        { mode: "extract", archive: "unreadable.cpio", directory: "out" },
        sb,
      );
      expect(run.error).toBeUndefined();
      expect((await fs.stat(path.join(root, "out/d"))).mode & 0o7777).toBe(0o755);
    } finally {
      process.umask(previous);
    }
  });

  it("never chmods a symlink target through the directory helper", async () => {
    const { root, outside } = await setup();
    const outsideDir = path.join(outside, "mode-target");
    await fs.mkdir(outsideDir);
    await fs.chmod(outsideDir, 0o700);
    await fs.symlink(outsideDir, path.join(root, "dir-link"), "dir");

    await expect(
      chmodDirectoryNoFollow(path.join(root, "dir-link"), 0o755),
    ).rejects.toBeInstanceOf(Error);
    expect((await fs.stat(outsideDir)).mode & 0o7777).toBe(0o700);
  });

  it("applies umask to archive file modes and preserves explicit 0000", async () => {
    const previous = process.umask(0o022);
    try {
      const { root, sb } = await setup();
      expect(safeMode(0o666, 0o022)).toBe(0o644);
      expect(safeMode(0o777, 0o022)).toBe(0o755);
      expect(safeMode(0, 0o022)).toBe(0);
      expect(safeDirectoryMode(0o1777, 0o022)).toBe(0o1755);

      await fs.writeFile(path.join(root, "umask.cpio"), Buffer.concat([
        newcEntry("file666", Buffer.from("x"), 0o100666),
        newcEntry("file777", Buffer.from("x"), 0o100777),
        newcEntry("file000", Buffer.from("x"), 0o100000),
        newcTrailer(),
      ]));
      const cpio = await runGated(
        cpioTool,
        { mode: "extract", archive: "umask.cpio", directory: "cpio-out" },
        sb,
      );
      expect(cpio.error).toBeUndefined();
      expect((await fs.stat(path.join(root, "cpio-out/file666"))).mode & 0o7777).toBe(0o644);
      expect((await fs.stat(path.join(root, "cpio-out/file777"))).mode & 0o7777).toBe(0o755);
      expect((await fs.stat(path.join(root, "cpio-out/file000"))).mode & 0o7777).toBe(0);

      await fs.writeFile(path.join(root, "umask.tar"), await tarModeArchive([0o666, 0o777, 0]));
      const tarRun = await runGated(
        tarTool,
        { mode: "extract", archive: "umask.tar", directory: "tar-out" },
        sb,
      );
      expect(tarRun.error).toBeUndefined();
      expect((await fs.stat(path.join(root, "tar-out/file0"))).mode & 0o7777).toBe(0o644);
      expect((await fs.stat(path.join(root, "tar-out/file1"))).mode & 0o7777).toBe(0o755);
      expect((await fs.stat(path.join(root, "tar-out/file2"))).mode & 0o7777).toBe(0);
    } finally {
      process.umask(previous);
    }
  });

  it("applies archive modes through the open handle and keeps contents", async () => {
    const previous = process.umask(0o022);
    try {
      const { root, sb } = await setup();
      await fs.writeFile(path.join(root, "file"), "new");
      await fs.chmod(path.join(root, "file"), 0o666);
      await runGated(tarTool, { mode: "create", archive: "handle.tar", paths: ["file"] }, sb);
      await fs.mkdir(path.join(root, "out"));
      await fs.writeFile(path.join(root, "out/file"), "old");
      await fs.chmod(path.join(root, "out/file"), 0o600);
      const tarRun = await runGated(
        tarTool,
        { mode: "extract", archive: "handle.tar", directory: "out" },
        sb,
      );
      expect(tarRun.error).toBeUndefined();
      expect(await fs.readFile(path.join(root, "out/file"), "utf8")).toBe("new");
      expect((await fs.stat(path.join(root, "out/file"))).mode & 0o7777).toBe(0o644);

      await fs.writeFile(path.join(root, "zfile"), "zip-new");
      await fs.chmod(path.join(root, "zfile"), 0o666);
      await runGated(zipTool, { archive: "handle.zip", paths: ["zfile"] }, sb);
      await fs.writeFile(path.join(root, "out/zfile"), "zip-old");
      await fs.chmod(path.join(root, "out/zfile"), 0o600);
      const zipRun = await runGated(
        unzipTool,
        { archive: "handle.zip", directory: "out", overwrite: true },
        sb,
      );
      expect(zipRun.error).toBeUndefined();
      expect(await fs.readFile(path.join(root, "out/zfile"), "utf8")).toBe("zip-new");
      expect((await fs.stat(path.join(root, "out/zfile"))).mode & 0o7777).toBe(0o644);
    } finally {
      process.umask(previous);
    }
  });

  it("reports directory handle chmod errors", async () => {
    const { root } = await setup();
    await expect(
      chmodDirectoryNoFollow(path.join(root, "missing"), 0o755),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("skips duplicate ZIP members with noOverwrite", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "duplicate.zip"), await zipDuplicateArchive());
    const run = await runGated(unzipTool, { archive: "duplicate.zip", directory: "out", noOverwrite: true }, sb);
    expect(run.error).toBeUndefined();
    expect(await fs.readFile(path.join(root, "out/dup.txt"), "utf8")).toBe("first");
    expect(run.result?.metadata?.members).toEqual(["dup.txt"]);
  });
});

describe("archive read permission", () => {
  it("gates tar list and extract on the resolved archive target", async () => {
    const { root, outside, outsideFile, sb } = await setup();
    await runGated(tarTool, { mode: "create", archive: "real.tar", input: "x", member: "file" }, sb);
    const outsideArchive = path.join(outside, "real.tar");
    await fs.copyFile(path.join(root, "real.tar"), outsideArchive);
    await fs.symlink(outsideArchive, path.join(root, "archive.tar"));

    const list = await runGated(tarTool, { mode: "list", archive: "archive.tar" }, sb, denyExternal);
    expectDenied(list);
    expect(resources(list, "external_directory")).toContain(`${outside}/*`);

    const extract = await runGated(
      tarTool,
      { mode: "extract", archive: "archive.tar", directory: "out" },
      sb,
      denyExternal,
    );
    expectDenied(extract);
    expect(resources(extract, "external_directory")).toContain(`${outside}/*`);
    expect(await pathExists(path.join(root, "out/file"))).toBe(false);
  });

  it("gates unzip list on the resolved archive target", async () => {
    const { root, outside, outsideFile, sb } = await setup();
    await runGated(zipTool, { archive: "real.zip", input: "x", member: "file" }, sb);
    const outsideArchive = path.join(outside, "real.zip");
    await fs.copyFile(path.join(root, "real.zip"), outsideArchive);
    await fs.symlink(outsideArchive, path.join(root, "archive.zip"));

    const list = await runGated(unzipTool, { archive: "archive.zip", mode: "list" }, sb, denyExternal);
    expectDenied(list);
    expect(resources(list, "external_directory")).toContain(`${outside}/*`);
  });
});

describe("archive extraction escapes", () => {
  const extractionCases = [
    {
      label: "tar",
      create: { mode: "create", archive: "case.tar", input: "x", member: "dir/file" },
      extract: { mode: "extract", archive: "case.tar", directory: "out" },
      createSpec: tarTool,
      extractSpec: tarTool,
    },
    {
      label: "zip",
      create: { archive: "case.zip", input: "x", member: "dir/file" },
      extract: { archive: "case.zip", directory: "out" },
      createSpec: zipTool,
      extractSpec: unzipTool,
    },
    {
      label: "cpio",
      create: { mode: "create", archive: "case.cpio", input: "x", member: "dir/file" },
      extract: { mode: "extract", archive: "case.cpio", directory: "out" },
      createSpec: cpioTool,
      extractSpec: cpioTool,
    },
  ] as const;

  for (const testCase of extractionCases) {
    it(`gates a ${testCase.label} extraction root symlink and a child symlink escape`, async () => {
      const { root, outside, sb } = await setup();
      await runGated(testCase.createSpec, testCase.create, sb);
      const rootLink = await setupRootLink(root, outside, sb, testCase.extract, testCase.extractSpec);
      expectDenied(rootLink);
      expect(await pathExists(path.join(outside, "dir/file"))).toBe(false);

      await fs.rm(path.join(root, "out"), { recursive: true, force: true });
      await fs.mkdir(path.join(root, "out"));
      await fs.symlink(outside, path.join(root, "out/dir"), "dir");
      const childLink = await runGated(testCase.extractSpec, testCase.extract, sb, denyExternal);
      expectDenied(childLink);
      expect(await fs.readFile(path.join(outside, "target.txt"), "utf8")).toBe("outside-original");
      expect(await pathExists(path.join(outside, "file"))).toBe(false);
      expect(resources(childLink, "external_directory")).toContain(`${outside}/*`);
    });
  }

  it("rejects a child symlink that leaves the extraction root but stays in the sandbox", async () => {
    const { root, sb } = await setup();
    await runGated(cpioTool, { mode: "create", archive: "inside.cpio", input: "x", member: "dir/file" }, sb);
    await fs.mkdir(path.join(root, "inside-target"));
    await fs.mkdir(path.join(root, "out"));
    await fs.symlink(path.join(root, "inside-target"), path.join(root, "out/dir"), "dir");

    const run = await runGated(
      cpioTool,
      { mode: "extract", archive: "inside.cpio", directory: "out" },
      sb,
    );
    expect(run.error).toMatchObject({ code: "archive" });
    expect(await pathExists(path.join(root, "inside-target/file"))).toBe(false);
  });

  it("gates an ar extraction root symlink and a child symlink escape", async () => {
    const { root, outside, sb } = await setup();
    await fs.writeFile(path.join(root, "case.a"), arArchive("dir/file", Buffer.from("x")));

    await fs.symlink(outside, path.join(root, "out"), "dir");
    const rootLink = await runGated(arTool, { mode: "extract", archive: "case.a", directory: "out" }, sb, denyExternal);
    expectDenied(rootLink);
    expect(await pathExists(path.join(outside, "dir/file"))).toBe(false);

    await fs.rm(path.join(root, "out"), { recursive: true, force: true });
    await fs.mkdir(path.join(root, "out"));
    await fs.symlink(outside, path.join(root, "out/dir"), "dir");
    const childLink = await runGated(arTool, { mode: "extract", archive: "case.a", directory: "out" }, sb, denyExternal);
    expectDenied(childLink);
    expect(await pathExists(path.join(outside, "file"))).toBe(false);
    expect(resources(childLink, "external_directory")).toContain(`${outside}/*`);
  });

  it("rejects absolute and traversing cpio symlink targets before writing beneath them", async () => {
    const { root, outside, sb } = await setup();
    const outsideTarget = path.join(outside, "pwn");
    await fs.writeFile(path.join(root, "absolute.cpio"), Buffer.concat([
      newcEntry("link", Buffer.from(outsideTarget), 0o120777),
      newcEntry("link/pwn", Buffer.from("pwned")),
      newcTrailer(),
    ]));
    await fs.writeFile(path.join(root, "traverse.cpio"), Buffer.concat([
      newcEntry("link", Buffer.from("../../pwn"), 0o120777),
      newcEntry("link/pwn", Buffer.from("pwned")),
      newcTrailer(),
    ]));
    await fs.writeFile(path.join(root, "empty-link.cpio"), Buffer.concat([
      newcEntry("link", Buffer.alloc(0), 0o120777),
      newcEntry("link/pwn", Buffer.from("pwned")),
      newcTrailer(),
    ]));

    const empty = await runGated(
      cpioTool,
      { mode: "extract", archive: "empty-link.cpio", directory: "out" },
      sb,
    );
    expect(empty.error).toMatchObject({ code: "archive" });
    expect(await pathExists(path.join(root, "out/link"))).toBe(false);

    const absolute = await runGated(
      cpioTool,
      { mode: "extract", archive: "absolute.cpio", directory: "out" },
      sb,
    );
    expect(absolute.error).toMatchObject({ code: "archive" });
    expect(await pathExists(outsideTarget)).toBe(false);

    const traverse = await runGated(
      cpioTool,
      { mode: "extract", archive: "traverse.cpio", directory: "out" },
      sb,
    );
    expect(traverse.error).toMatchObject({ code: "archive" });
    expect(await pathExists(path.join(outside, "pwn"))).toBe(false);
  });
});

async function setupRootLink<I>(
  root: string,
  outside: string,
  sb: Sandbox,
  extract: unknown,
  spec: ToolSpec<I>,
): Promise<GatedRun> {
  await fs.symlink(outside, path.join(root, "out"), "dir");
  return runGated(spec, extract, sb, denyExternal);
}

describe("symlink read permission", () => {
  it("gates grep on the resolved external file before reading", async () => {
    const { root, outside, outsideFile, sb } = await setup();
    await fs.symlink(outsideFile, path.join(root, "secret"));

    const denied = await runGated(grepTool, { pattern: "outside", paths: ["secret"] }, sb, denyExternal);
    expectDenied(denied);
    expect(resources(denied, "external_directory")).toContain(`${outside}/*`);

    const allowed = await runGated(grepTool, { pattern: "outside", paths: ["secret"] }, sb);
    expect(allowed.error).toBeUndefined();
    expect(allowed.result?.stdout.toString()).toContain("outside-original");
    expect(resources(allowed, "fs_grep")).toContain(outsideFile);
  });

  it("gates diff on resolved file symlinks and recursive symlink children", async () => {
    const { root, outside, outsideFile, sb } = await setup();
    await fs.writeFile(path.join(root, "local"), "local\n");
    await fs.symlink(outsideFile, path.join(root, "secret"));

    const files = await runGated(diffTool, { left: "secret", right: "local" }, sb, denyExternal);
    expectDenied(files);
    expect(resources(files, "external_directory")).toContain(`${outside}/*`);

    await fs.mkdir(path.join(root, "left"));
    await fs.mkdir(path.join(root, "right"));
    await fs.symlink(outsideFile, path.join(root, "left/secret"));
    await fs.writeFile(path.join(root, "right/secret"), "different\n");
    const recursive = await runGated(
      diffTool,
      { left: "left", right: "right", recursive: true },
      sb,
      denyExternal,
    );
    expectDenied(recursive);
    expect(resources(recursive, "external_directory")).toContain(`${outside}/*`);
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside-original");

    await fs.writeFile(path.join(root, "target"), "same\n");
    await fs.rm(path.join(root, "left/secret"));
    await fs.symlink(path.join(root, "target"), path.join(root, "left/secret"));
    await fs.writeFile(path.join(root, "right/secret"), "same\n");
    const allowed = await runGated(
      diffTool,
      { left: "left", right: "right", recursive: true },
      sb,
    );
    expect(allowed.error).toBeUndefined();
    expect(allowed.result?.exitCode).toBe(0);
  });
});

describe("archive decoder hardening", () => {
  it("rejects an ar member size that would not advance the offset", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "negative.a"), Buffer.from([
      "!<arch>\n",
      arHeader("a", "-60"),
    ].join(""), "ascii"));
    const run = await runGated(arTool, { mode: "list", archive: "negative.a" }, sb);
    expect(run.error).toMatchObject({ code: "archive" });

    await fs.writeFile(path.join(root, "blank-size.a"), Buffer.from([
      "!<arch>\n",
      arHeader("a", ""),
    ].join(""), "ascii"));
    const blank = await runGated(arTool, { mode: "list", archive: "blank-size.a" }, sb);
    expect(blank.error).toMatchObject({ code: "archive" });

    await fs.writeFile(path.join(root, "bad-mode.a"), Buffer.from([
      "!<arch>\n",
      arHeader("a", "0", { mode: "99999999" }),
    ].join(""), "ascii"));
    const badMode = await runGated(arTool, { mode: "list", archive: "bad-mode.a" }, sb);
    expect(badMode.error).toMatchObject({ code: "archive" });
  }, 2_000);

  it("reads a GNU-compatible hexadecimal newc fixture and rejects invalid fields", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "gnu.cpio"), GNU_HEX_CPIO);
    const list = await runGated(cpioTool, { mode: "list", archive: "gnu.cpio" }, sb);
    expect(list.result?.stdout.toString()).toBe("hello.txt\n");
    const extracted = await runGated(
      cpioTool,
      { mode: "extract", archive: "gnu.cpio", directory: "out" },
      sb,
    );
    expect(extracted.error).toBeUndefined();
    expect(await fs.readFile(path.join(root, "out/hello.txt"), "utf8")).toBe("hi\n");

    const bad = Buffer.from(GNU_HEX_CPIO);
    bad.write("zzzzzzzz", 14, "ascii");
    await fs.writeFile(path.join(root, "bad-field.cpio"), bad);
    const rejected = await runGated(cpioTool, { mode: "list", archive: "bad-field.cpio" }, sb);
    expect(rejected.error).toMatchObject({ code: "archive" });

    const patches: Array<[string, number, string]> = [
      ["bad-mode.cpio", 14, "00000001"],
      ["zero-mode.cpio", 14, "00000000"],
      ["bad-size.cpio", 6 + 6 * 8, "ffffffff"],
      ["bad-name-size.cpio", 6 + 11 * 8, "00000000"],
    ];
    for (const [name, offset, value] of patches) {
      const copy = Buffer.from(GNU_HEX_CPIO);
      copy.write(value, offset, "ascii");
      await fs.writeFile(path.join(root, name), copy);
      const run = await runGated(cpioTool, { mode: "list", archive: name }, sb);
      expect(run.error).toMatchObject({ code: "archive" });
    }

    const unpadded = newcEntry("file", Buffer.from("abc"));
    await fs.writeFile(
      path.join(root, "unpadded.cpio"),
      unpadded.subarray(0, unpadded.length - 1),
    );
    const missingPad = await runGated(cpioTool, { mode: "list", archive: "unpadded.cpio" }, sb);
    expect(missingPad.error).toMatchObject({ code: "archive" });

    await fs.writeFile(
      path.join(root, "trailing-junk.cpio"),
      Buffer.concat([Buffer.from(GNU_HEX_CPIO), Buffer.from("x")]),
    );
    const junk = await runGated(cpioTool, { mode: "list", archive: "trailing-junk.cpio" }, sb);
    expect(junk.error).toMatchObject({ code: "archive" });

    const emptyBadName = Buffer.alloc(110, 0x30);
    emptyBadName.write("070701", 0, "ascii");
    await fs.writeFile(path.join(root, "empty-bad-name.cpio"), emptyBadName);
    const noName = await runGated(cpioTool, { mode: "list", archive: "empty-bad-name.cpio" }, sb);
    expect(noName.error).toMatchObject({ code: "archive" });

    const nonOctalName = Buffer.from(emptyBadName);
    nonOctalName.write("ffffffff", 6 + 11 * 8, "ascii");
    await fs.writeFile(path.join(root, "empty-hex-name.cpio"), nonOctalName);
    const hexName = await runGated(cpioTool, { mode: "list", archive: "empty-hex-name.cpio" }, sb);
    expect(hexName.error).toMatchObject({ code: "archive" });
  });

  it("reads static legacy-octal old-padding newc archives, including an empty archive", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "legacy.cpio"), LEGACY_OCTAL_CPIO);
    const list = await runGated(cpioTool, { mode: "list", archive: "legacy.cpio" }, sb);
    expect(list.error).toBeUndefined();
    expect(list.result?.stdout.toString()).toBe("legacy.txt\n");
    const extracted = await runGated(
      cpioTool,
      { mode: "extract", archive: "legacy.cpio", directory: "out" },
      sb,
    );
    expect(extracted.error).toBeUndefined();
    expect(await fs.readFile(path.join(root, "out/legacy.txt"), "utf8")).toBe("old\n");

    await fs.writeFile(path.join(root, "empty-legacy.cpio"), LEGACY_EMPTY_CPIO);
    const empty = await runGated(cpioTool, { mode: "list", archive: "empty-legacy.cpio" }, sb);
    expect(empty.error).toBeUndefined();
    expect(empty.result?.stdout.toString()).toBe("\n");
    expect(empty.result?.metadata).toMatchObject({ members: 0 });
  });

  it("maps a directory member creation failure to an archive error", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "dir.cpio"), Buffer.concat([
      newcEntry("dir", Buffer.alloc(0), 0o040755),
      newcTrailer(),
    ]));
    await fs.mkdir(path.join(root, "out"));
    await fs.writeFile(path.join(root, "out/dir"), "blocker");

    const run = await runGated(
      cpioTool,
      { mode: "extract", archive: "dir.cpio", directory: "out" },
      sb,
    );
    expect(run.error).toMatchObject({ code: "exists" });
  });

  it("round-trips a member larger than 16 MiB through hexadecimal newc fields", async () => {
    const { root, sb } = await setup();
    const size = 16 * 1024 * 1024 + 1;
    const data = Buffer.alloc(size, 0x61);
    data[0] = 0x53;
    data[size - 1] = 0x45;
    await fs.writeFile(path.join(root, "big"), data);

    const created = await runGated(
      cpioTool,
      { mode: "create", archive: "big.cpio", paths: ["big"] },
      sb,
    );
    expect(created.error).toBeUndefined();
    const header = (await fs.readFile(path.join(root, "big.cpio"))).subarray(0, 110);
    expect(header.subarray(6 + 6 * 8, 6 + 7 * 8).toString("ascii")).toBe(size.toString(16).padStart(8, "0"));

    const extracted = await runGated(
      cpioTool,
      { mode: "extract", archive: "big.cpio", directory: "out" },
      sb,
    );
    expect(extracted.error).toBeUndefined();
    const roundTrip = await fs.readFile(path.join(root, "out/big"));
    expect(roundTrip.length).toBe(size);
    expect(roundTrip[0]).toBe(0x53);
    expect(roundTrip[size - 1]).toBe(0x45);
  }, 30_000);

  it("rejects alphabetic and numeric suffix overflow before writing any chunk", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "data"), "x".repeat(677));

    const overflow = await runGated(
      splitTool,
      { input: "data", prefix: "s", bytes: 1, suffixLength: 2 },
      sb,
    );
    expect(overflow.error).toMatchObject({ code: "invalid" });
    expect((await fs.readdir(root)).filter((name) => name.startsWith("s"))).toEqual([]);

    await fs.writeFile(path.join(root, "small"), "x".repeat(11));
    const numericOverflow = await runGated(
      splitTool,
      { input: "small", prefix: "n", bytes: 1, suffixLength: 1, numeric: true },
      sb,
    );
    expect(numericOverflow.error).toMatchObject({ code: "invalid" });
    expect((await fs.readdir(root)).filter((name) => name.startsWith("n"))).toEqual([]);

    const numeric = await runGated(
      splitTool,
      { input: "small", prefix: "m", bytes: 2, suffixLength: 1, numeric: true },
      sb,
    );
    expect(numeric.error).toBeUndefined();
    expect(numeric.result?.metadata?.chunks).toBe(6);
    const names = (await fs.readdir(root)).filter((name) => name.startsWith("m")).sort();
    expect(names).toHaveLength(6);
    expect(names[0]).toBe("m0");
    expect(names).toContain("m5");
  }, 30_000);
});

// GNU cpio 2.15 `cpio -o --format=newc` output for hello.txt ("hi\n").
const GNU_HEX_CPIO = Buffer.from(
  "303730373031303031333946324130303030383141343030303030334538303030303033453830303030303030313030303030303030303030303030303330303030303030303030303030303341303030303030303030303030303030303030303030303041303030303030303068656c6c6f2e7478740068690a003037303730313030303030303030303030303030303030303030303030303030303030303030303030303030303130303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030423030303030303030545241494c455221212100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  "hex",
).subarray(0, 512);

const LEGACY_OCTAL_CPIO = Buffer.from(
  "30373037303130303030303030313030313030363434303030303030303030303030303030303030303030303031303030303030303030303030303030343030303030303030303030303030303030303030303030303030303030303030303030303030313330303030303030306c65676163792e74787400006f6c640a3037303730313030303030303030303030303030303030303030303030303030303030303030303030303030303130303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303031333030303030303030545241494c45522121210000",
  "hex",
);

const LEGACY_EMPTY_CPIO = Buffer.from(
  "3037303730313030303030303030303030303030303030303030303030303030303030303030303030303030303130303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303031333030303030303030545241494c45522121210000",
  "hex",
);

async function tarSymlinkChildArchive(prefix: string): Promise<Buffer> {
  const base = prefix === "" ? "" : `${prefix}/`;
  const pack = tar.pack();
  pack.entry({ name: `${base}link`, type: "symlink", linkname: "sub", mode: 0o120777 });
  pack.entry(
    { name: `${base}link/file`, type: "file", mode: 0o100644, size: 5 },
    Buffer.from("pwned"),
  );
  pack.finalize();
  return collect(pack as AsyncIterable<Buffer>);
}

async function zipSymlinkChildArchive(prefix: string): Promise<Buffer> {
  const base = prefix === "" ? "" : `${prefix}/`;
  const writer = new ZipWriter();
  writer.addBuffer(Buffer.from("sub"), `${base}link`, { mode: 0o120777, compress: false });
  writer.addBuffer(Buffer.from("pwned"), `${base}link/file`, { mode: 0o100644, compress: false });
  writer.end();
  return collect(writer.outputStream as AsyncIterable<Buffer>);
}

function cpioSymlinkChildArchive(prefix: string): Buffer {
  const base = prefix === "" ? "" : `${prefix}/`;
  return Buffer.concat([
    newcEntry(`${base}link`, Buffer.from("sub"), 0o120777),
    newcEntry(`${base}link/file`, Buffer.from("pwned")),
    newcTrailer(),
  ]);
}

async function tarModeArchive(modes: number[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const [index, mode] of modes.entries()) {
    const header = Buffer.alloc(512, 0);
    header.write(`file${index}`, 0, "ascii");
    header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write("00000000001\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    chunks.push(header, Buffer.from("x"), Buffer.alloc(511, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

async function zipDosModeArchive(): Promise<Buffer> {
  const writer = new ZipWriter();
  writer.addBuffer(Buffer.from("dos"), "dos.txt", { mode: 0, compress: false });
  writer.addEmptyDirectory("dosdir/", { mode: 0 });
  writer.end();
  return collect(writer.outputStream as AsyncIterable<Buffer>);
}

async function zipDuplicateArchive(): Promise<Buffer> {
  const writer = new ZipWriter();
  writer.addBuffer(Buffer.from("first"), "dup.txt", { mode: 0o100644, compress: false });
  writer.addBuffer(Buffer.from("second"), "dup.txt", { mode: 0o100644, compress: false });
  writer.end();
  return collect(writer.outputStream as AsyncIterable<Buffer>);
}

function arArchive(name: string, data: Buffer): Buffer {
  const chunks = [Buffer.from("!<arch>\n", "ascii"), Buffer.from(arHeader(name, String(data.length)), "ascii"), data];
  if (data.length % 2 === 1) chunks.push(Buffer.from("\n", "ascii"));
  return Buffer.concat(chunks);
}

function arHeader(
  name: string,
  size: string,
  fields: { mode?: string } = {},
): string {
  return [
    `${name}/`.padEnd(16, " "),
    "0".padStart(12, " "),
    "0".padStart(6, " "),
    "0".padStart(6, " "),
    (fields.mode ?? "100644").padStart(8, " "),
    size.padStart(10, " "),
    "`\n",
  ].join("");
}

function newcEntry(name: string, data: Buffer, mode = 0o100644): Buffer {
  const nameBuffer = Buffer.from(`${name}\0`, "utf8");
  const fields = [1, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, nameBuffer.length, 0];
  const header = `070701${fields.map((value) => value.toString(16).padStart(8, "0")).join("")}`;
  return Buffer.concat([
    Buffer.from(header, "ascii"),
    nameBuffer,
    pad4(110 + nameBuffer.length),
    data,
    pad4(data.length),
  ]);
}

function newcTrailer(): Buffer {
  const name = Buffer.from("TRAILER!!!\0", "utf8");
  const fields = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, name.length, 0];
  return Buffer.concat([
    Buffer.from(`070701${fields.map((value) => value.toString(16).padStart(8, "0")).join("")}`, "ascii"),
    name,
    pad4(110 + name.length),
  ]);
}

function pad4(value: number): Buffer {
  return Buffer.alloc((4 - (value % 4)) % 4);
}

async function gzipped(text: string): Promise<Buffer> {
  const { promisify } = await import("node:util");
  const { gzip } = await import("node:zlib");
  return promisify(gzip)(Buffer.from(text, "utf8"));
}
