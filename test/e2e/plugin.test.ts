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

describe("plugin registration", () => {
  it("registers the fs namespace and native tools", async () => {
    const { editor } = await load();
    expect(editor.namespaceValue).toMatchObject({ name: "fs" });
    expect(editor.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["mkdir", "rmdir", "rm", "cp", "mv", "pipe"]),
    );
    expect(editor.tools[0]?.options).toMatchObject({
      namespace: "fs",
      permission: "fs_mkdir",
    });
  });

  it("fails when no root can be determined", async () => {
    const harness = makePluginHarness("");
    harness.context.location = { project: { canonical: "" }, directory: "" };
    await expect(plugin.setup(harness.context as never)).rejects.toThrow(/sandbox root/);
  });

  it("honors the root option and custom limits", async () => {
    const root = await makeRoot();
    roots.push(root);
    const harness = makePluginHarness(root, {
      root,
      maxOutputBytes: 3,
      concurrency: 2,
    });
    await plugin.setup(harness.context as never);
    const mkdir = harness.editor.tools.find((tool) => tool.name === "mkdir");
    const result = (await mkdir?.execute({ path: "one", verbose: true }, makeToolContext())) as {
      content: string;
      metadata: Record<string, unknown>;
    };
    expect(result.metadata.bytes).toBeGreaterThan(3);
    expect(result.metadata.truncated).toBe(true);
  });

  it("rejects invalid concurrency", async () => {
    const root = await makeRoot();
    roots.push(root);
    const harness = makePluginHarness(root, { concurrency: 0 });
    await expect(plugin.setup(harness.context as never)).rejects.toThrow(/concurrency/);
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
