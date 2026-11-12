/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1.1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { JobManager } from "../../src/core/jobs.js";
import plugin from "../../src/index.js";
import {
  makePluginHarness,
  makeRoot,
  makeToolContext,
  pathExists,
  type FakeEditor,
} from "../helpers.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function load() {
  const root = await makeRoot("fs-jobs-plugin-");
  roots.push(root);
  const harness = makePluginHarness(root, { jobDir: path.join(root, "jobs") });
  const cleanup = (await plugin.setup(harness.context as never)) as () => void;
  cleanups.push(cleanup);
  return { root, ...harness };
}

function tool(editor: FakeEditor, name: string) {
  const found = editor.tools.find((item) => item.name === name);
  if (!found) throw new Error(`missing tool: ${name}`);
  return found;
}

async function start(editor: FakeEditor, name: string, input: Record<string, unknown>) {
  const result = (await tool(editor, name).execute({ ...input, background: true }, makeToolContext())) as {
    content: string;
    metadata: Record<string, unknown>;
  };
  return { result, payload: JSON.parse(result.content) };
}

describe("background fs jobs", () => {
  it("exposes background on every tool and registers fs.job", async () => {
    const { editor } = await load();
    for (const item of editor.tools.filter((entry) => entry.name !== "job")) {
      expect(item.input.properties.background).toBeDefined();
    }
    expect(tool(editor, "job").options).toMatchObject({ namespace: "fs", permission: "fs_job" });
  });

  it("returns immediately, then waits for the job and returns its result", async () => {
    const { root, editor } = await load();
    const { result, payload } = await start(editor, "mkdir", { path: "background", verbose: true });
    expect(payload).toMatchObject({ tool: "mkdir", state: "running" });
    expect(result.metadata).toMatchObject({ ok: true, background: true, jobId: payload.jobId });
    expect(await pathExists(payload.statusPath)).toBe(true);

    const job = tool(editor, "job");
    const waited = (await job.execute({ id: payload.jobId, wait: true }, makeToolContext())) as {
      content: string;
      metadata: Record<string, unknown>;
    };
    expect(waited.content).toContain("Directory created");
    expect(waited.metadata).toMatchObject({
      ok: true,
      jobId: payload.jobId,
      state: "completed",
      timedOut: false,
    });
    expect(await pathExists(path.join(root, "background"))).toBe(true);

    const status = JSON.parse(
      ((await job.execute({ id: payload.jobId }, makeToolContext())) as { content: string }).content,
    );
    expect(status.state).toBe("completed");

    const listed = JSON.parse(
      ((await job.execute({ list: true }, makeToolContext())) as { content: string }).content,
    );
    expect(listed.jobs.map((entry: { id: string }) => entry.id)).toContain(payload.jobId);

    const cancelled = JSON.parse(
      ((await job.execute({ id: payload.jobId, cancel: true }, makeToolContext())) as { content: string })
        .content,
    );
    expect(cancelled.state).toBe("completed");
  });

  it("times out, reports running state, and cancels a blocked job", async () => {
    const { editor, context } = await load();
    let release!: () => void;
    const asserted = new Promise<void>((resolve) => {
      context.permission.assert = () =>
        new Promise<void>((done) => {
          release = done;
          resolve();
        });
    });

    const { payload } = await start(editor, "mkdir", { path: "blocked" });
    await asserted;
    const job = tool(editor, "job");

    const timedOut = JSON.parse(
      ((await job.execute({ id: payload.jobId, wait: true, timeoutMs: 1 }, makeToolContext())) as {
        content: string;
      }).content,
    );
    expect(timedOut).toMatchObject({ state: "running", timedOut: true });

    const running = JSON.parse(
      ((await job.execute({ id: payload.jobId }, makeToolContext())) as { content: string }).content,
    );
    expect(running.state).toBe("running");

    const cancelled = JSON.parse(
      ((await job.execute({ id: payload.jobId, cancel: true }, makeToolContext())) as {
        content: string;
      }).content,
    );
    expect(cancelled.state).toBe("running");

    release();
    const waited = (await job.execute(
      { id: payload.jobId, wait: true, timeoutMs: 1000 },
      makeToolContext(),
    )) as { content: string; metadata: Record<string, unknown> };
    expect(waited.metadata).toMatchObject({ ok: false, state: "cancelled" });
  });

  it("returns a failed job status when the background tool fails", async () => {
    const { editor } = await load();
    const { payload } = await start(editor, "mkdir", { path: "missing/child" });
    const job = tool(editor, "job");
    const waited = (await job.execute(
      { id: payload.jobId, wait: true, timeoutMs: 1000 },
      makeToolContext(),
    )) as { content: string; metadata: Record<string, unknown> };
    const status = JSON.parse(waited.content);
    expect(status.state).toBe("failed");
    expect(status.error).toBeTruthy();
    expect(waited.metadata).toMatchObject({ ok: false, state: "failed" });
  });

  it("propagates non-FsError job control failures", async () => {
    const { editor } = await load();
    const job = tool(editor, "job");
    const spy = vi.spyOn(JobManager.prototype, "status").mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(job.execute({ id: "job_x" }, makeToolContext())).rejects.toThrow("boom");
    spy.mockRestore();
  });

  it("rejects invalid job requests", async () => {
    const { editor } = await load();
    const job = tool(editor, "job");
    const cases = [
      {},
      { id: "job_missing" },
      { list: true, id: "job_x" },
      { id: "job_x", wait: true, cancel: true },
      { id: "job_x", timeoutMs: 0 },
    ];
    for (const input of cases) {
      const result = (await job.execute(input, makeToolContext())) as {
        content: string;
        metadata: Record<string, unknown>;
      };
      expect(result.content).toMatch(/^ERROR:/);
    }
  });
});
