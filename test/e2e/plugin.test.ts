/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import plugin from "../../src/index.js";
import { makePluginHarness, makeRoot, makeToolContext, pathExists } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function load(options: Record<string, unknown> = {}) {
  const root = await makeRoot();
  roots.push(root);
  const harness = makePluginHarness(root, options);
  await plugin.setup(harness.context as never);
  return { root, ...harness };
}

async function makeCommandPath(prefix: string): Promise<string> {
  const dir = await makeRoot(prefix);
  roots.push(dir);
  return fs.realpath(dir);
}

async function writeProbe(dir: string, name: string, body: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

describe("plugin registration", () => {
  it("registers the fs namespace and native tools", async () => {
    const { editor } = await load();
    expect(editor.namespaceValue).toMatchObject({ name: "fs" });
    expect(editor.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["mkdir", "rmdir", "rm", "cp", "mv", "pipe"]),
    );
    const mkdir = editor.tools.find((tool) => tool.name === "mkdir");
    expect(mkdir?.options).toMatchObject({
      namespace: "fs",
      permission: "fs_mkdir",
    });
    const command = editor.tools.find((tool) => tool.name === "command");
    expect(
      (command?.input as { properties?: Record<string, unknown> }).properties,
    ).toHaveProperty("envVars");
    expect((command?.input as { additionalProperties?: unknown }).additionalProperties).toBe(
      false,
    );
  });

  it("fails when no root can be determined", async () => {
    const harness = makePluginHarness("");
    harness.context.location = { project: { canonical: "" }, directory: "" };
    await expect(plugin.setup(harness.context as never)).rejects.toThrow(/sandbox root/);
  });

  it("uses the session location as the root, ignoring a root option", async () => {
    const root = await makeRoot();
    const elsewhere = await makeRoot();
    roots.push(root, elsewhere);
    const harness = makePluginHarness(root, { root: elsewhere });
    await plugin.setup(harness.context as never);
    const mkdir = harness.editor.tools.find((tool) => tool.name === "mkdir");
    const result = (await mkdir?.execute({ path: "one", verbose: true }, makeToolContext())) as {
      content: string;
      metadata: Record<string, unknown>;
    };
    expect(result.metadata.bytes).toBeGreaterThan(0);
    expect(await pathExists(path.join(root, "one"))).toBe(true);
    expect(await pathExists(path.join(elsewhere, "one"))).toBe(false);
  });

  it("rejects invalid concurrency", async () => {
    const root = await makeRoot();
    roots.push(root);
    const harness = makePluginHarness(root, { concurrency: 0 });
    await expect(plugin.setup(harness.context as never)).rejects.toThrow(/concurrency/);
  });

  it("rejects invalid commandPaths", async () => {
    const root = await makeRoot();
    roots.push(root);
    for (const commandPaths of ["nope", [""], ["relative/bin"], [root]]) {
      const harness = makePluginHarness(root, { commandPaths });
      await expect(plugin.setup(harness.context as never)).rejects.toThrow(/commandPaths/);
    }
  });

  it("rejects invalid commandEnvVars", async () => {
    const root = await makeRoot();
    roots.push(root);
    for (const commandEnvVars of [
      "nope",
      null,
      [],
      { PATH: "/tmp/bin" },
      { TMPDIR: "/tmp" },
      { "1BAD": "x" },
      { FS_BAD: 1 },
      { FS_BAD: "x\0y" },
    ]) {
      const harness = makePluginHarness(root, { commandEnvVars });
      await expect(plugin.setup(harness.context as never)).rejects.toThrow(/commandEnvVars/);
    }
  });

  it("rejects commandPaths inside the filesystem root project", async () => {
    const harness = makePluginHarness("/", { commandPaths: ["/tmp"] });
    await expect(plugin.setup(harness.context as never)).rejects.toThrow(
      /project root or inside/,
    );
  });

  it("resolves a background command from a configured command path", async () => {
    const root = await makeRoot();
    const dir = await makeCommandPath("fs-command-plugin-");
    await writeProbe(dir, "fs-command-probe", 'process.stdout.write("background")');
    roots.push(root);
    const harness = makePluginHarness(root, {
      commandPaths: [dir],
      jobDir: path.join(root, "jobs"),
    });
    const cleanup = (await plugin.setup(harness.context as never)) as () => void;
    try {
      const command = harness.editor.tools.find((tool) => tool.name === "command");
      const job = harness.editor.tools.find((tool) => tool.name === "job");
      const started = (await command?.execute(
        { command: "fs-command-probe", background: true },
        makeToolContext(),
      )) as { content: string; metadata: Record<string, unknown> };
      const payload = JSON.parse(started.content) as { jobId: string };
      const waited = (await job?.execute(
        { id: payload.jobId, wait: true, timeoutMs: 5000 },
        makeToolContext(),
      )) as { content: string; metadata: Record<string, unknown> };
      expect(JSON.parse(waited.content)).toMatchObject({ stdout: "background", exitCode: 0 });
      expect(waited.metadata).toMatchObject({ ok: true, state: "completed" });
    } finally {
      cleanup();
    }
  });

  it("passes configured environment entries to a background command", async () => {
    const root = await makeRoot();
    const dir = await makeCommandPath("fs-command-plugin-env-");
    await writeProbe(
      dir,
      "fs-command-probe",
      'process.stdout.write(process.env.FS_BACKGROUND_MARKER ?? "missing")',
    );
    roots.push(root);
    const harness = makePluginHarness(root, {
      commandPaths: [dir],
      commandEnvVars: { FS_BACKGROUND_MARKER: "background-env" },
      jobDir: path.join(root, "jobs"),
    });
    const cleanup = (await plugin.setup(harness.context as never)) as () => void;
    try {
      const command = harness.editor.tools.find((tool) => tool.name === "command");
      const job = harness.editor.tools.find((tool) => tool.name === "job");
      const started = (await command?.execute(
        { command: "fs-command-probe", background: true },
        makeToolContext(),
      )) as { content: string };
      const payload = JSON.parse(started.content) as { jobId: string };
      const waited = (await job?.execute(
        { id: payload.jobId, wait: true, timeoutMs: 5000 },
        makeToolContext(),
      )) as { content: string; metadata: Record<string, unknown> };
      expect(JSON.parse(waited.content)).toMatchObject({
        stdout: "background-env",
        exitCode: 0,
      });
      expect(waited.metadata).toMatchObject({ ok: true, state: "completed" });
    } finally {
      cleanup();
    }
  });

  it("passes per-call environment overlays to a background command", async () => {
    const root = await makeRoot();
    const dir = await makeCommandPath("fs-command-plugin-env-call-");
    await writeProbe(
      dir,
      "fs-command-probe",
      'process.stdout.write(JSON.stringify({ marker: process.env.FS_BACKGROUND_MARKER, keep: process.env.FS_BACKGROUND_KEEP, only: process.env.FS_BACKGROUND_ONLY }))',
    );
    roots.push(root);
    const harness = makePluginHarness(root, {
      commandPaths: [dir],
      commandEnvVars: {
        FS_BACKGROUND_MARKER: "background-env",
        FS_BACKGROUND_KEEP: "background-keep",
      },
      jobDir: path.join(root, "jobs"),
    });
    const cleanup = (await plugin.setup(harness.context as never)) as () => void;
    try {
      const command = harness.editor.tools.find((tool) => tool.name === "command");
      const job = harness.editor.tools.find((tool) => tool.name === "job");
      const started = (await command?.execute(
        {
          command: "fs-command-probe",
          background: true,
          envVars: { FS_BACKGROUND_MARKER: "call-env", FS_BACKGROUND_ONLY: "call-only" },
        },
        makeToolContext(),
      )) as { content: string };
      const payload = JSON.parse(started.content) as { jobId: string };
      const waited = (await job?.execute(
        { id: payload.jobId, wait: true, timeoutMs: 5000 },
        makeToolContext(),
      )) as { content: string; metadata: Record<string, unknown> };
      expect(JSON.parse(waited.content)).toMatchObject({
        stdout: JSON.stringify({
          marker: "call-env",
          keep: "background-keep",
          only: "call-only",
        }),
        exitCode: 0,
      });
      expect(JSON.stringify(waited.metadata)).not.toContain("call-env");
      expect(waited.metadata).toMatchObject({ ok: true, state: "completed" });
    } finally {
      cleanup();
    }
  });
});

describe("plugin execution", () => {
  it("executes mkdir and returns model-visible content", async () => {
    const { root, editor } = await load();
    const mkdir = editor.tools.find((tool) => tool.name === "mkdir");
    const result = (await mkdir?.execute({ path: "one", verbose: true }, makeToolContext())) as {
      content: string;
      metadata: Record<string, unknown>;
    };
    expect(result.content).toContain("Directory created");
    expect(result.metadata.ok).toBe(true);
    expect(await pathExists(path.join(root, "one"))).toBe(true);
  });

  it("returns an ERROR result for invalid arguments", async () => {
    const { editor } = await load();
    const mkdir = editor.tools.find((tool) => tool.name === "mkdir");
    const result = (await mkdir?.execute({ path: "" }, makeToolContext())) as {
      content: string;
      metadata: Record<string, unknown>;
    };
    expect(result.content).toMatch(/^ERROR:/);
    expect(result.metadata).toMatchObject({ ok: false, code: "invalid" });
  });

  it("rejects malformed envVars without echoing the key or value", async () => {
    const { editor, permissionRequests } = await load();
    const command = editor.tools.find((tool) => tool.name === "command");
    const result = (await command?.execute(
      {
        command: "node",
        args: ["-e", "process.stdout.write('ran')"],
        envVars: { "TOPSECRET\nKEY": { TOPSECRETVALUE: true } },
      },
      makeToolContext(),
    )) as { content: string; metadata: Record<string, unknown> };
    expect(result.content).toMatch(/^ERROR:/);
    expect(result.content).not.toContain("TOPSECRET");
    expect(result.content).not.toContain("TOPSECRETVALUE");
    expect(result.metadata).toMatchObject({ ok: false, code: "invalid" });
    expect(permissionRequests).toEqual([]);
  });

  it("returns a BLOCKED result for sandbox hard stops", async () => {
    const { editor } = await load();
    const rm = editor.tools.find((tool) => tool.name === "rm");
    const result = (await rm?.execute({ paths: ["."], recursive: true }, makeToolContext())) as {
      content: string;
      metadata: Record<string, unknown>;
    };
    expect(result.content).toMatch(/^BLOCKED:/);
    expect(result.metadata).toMatchObject({ blocked: true, code: "outside" });
  });

  it("executes a pipe with per-stage permission gates", async () => {
    const { editor } = await load();
    const pipe = editor.tools.find((tool) => tool.name === "pipe");
    const result = (await pipe?.execute(
      { input: "b\na\n", stages: [{ tool: "sort" }, { tool: "uniq" }] },
      makeToolContext(),
    )) as { content: string; metadata: Record<string, unknown> };
    expect(result.content).toBe("a\nb\n");
    expect(result.metadata.ok).toBe(true);
  });

  it("propagates permission denials", async () => {
    const root = await makeRoot();
    roots.push(root);
    const harness = makePluginHarness(root);
    harness.context.permission.assert = async () => {
      throw new Error("denied");
    };
    await plugin.setup(harness.context as never);
    const mkdir = harness.editor.tools.find((tool) => tool.name === "mkdir");
    await expect(mkdir?.execute({ path: "one" }, makeToolContext())).rejects.toThrow("denied");
  });
});
