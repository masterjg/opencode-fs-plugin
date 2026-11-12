/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FsError } from "../../src/core/errors.js";
import { JobManager } from "../../src/core/jobs.js";
import { makeRoot } from "../helpers.js";

const dirs: string[] = [];
const managers: JobManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = await makeRoot("fs-jobs-test-");
  dirs.push(dir);
  const manager = new JobManager({ dir, ttlMs: 60_000 });
  managers.push(manager);
  return { dir, manager };
}

const ok = { content: "ok", metadata: { ok: true } };

describe("JobManager", () => {
  it("starts a running job and writes its status file", async () => {
    const { dir, manager } = await setup();
    let release: (value: typeof ok) => void = () => {};
    const job = await manager.start(
      "cp",
      () => new Promise((resolve) => (release = resolve)),
    );
    expect(job.state).toBe("running");
    expect(manager.status(job.id).state).toBe("running");
    expect(manager.list()).toHaveLength(1);
    const status = JSON.parse(await fs.readFile(path.join(dir, `${job.id}.json`), "utf8"));
    expect(status).toMatchObject({ id: job.id, tool: "cp", state: "running" });
    release(ok);
    const waited = await manager.wait(job.id, 1000);
    expect(waited).toMatchObject({ timedOut: false, result: ok });
    expect(waited.status.state).toBe("completed");
  });

  it("records failures and returns their error", async () => {
    const { manager } = await setup();
    const job = await manager.start("grep", async () => {
      throw new Error("boom");
    });
    const waited = await manager.wait(job.id, 1000);
    expect(waited.timedOut).toBe(false);
    expect(waited.status.state).toBe("failed");
    expect(waited.status.error).toBe("boom");
    expect(waited.result).toBeUndefined();
  });

  it("cancels a running job through its signal", async () => {
    const { manager } = await setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    const job = await manager.start(
      "rm",
      (signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    await ready;
    expect(manager.cancel(job.id).state).toBe("running");
    const waited = await manager.wait(job.id, 1000);
    expect(waited.status.state).toBe("cancelled");
    expect(waited.status.error).toBe("aborted");
  });

  it("does not cancel a completed job", async () => {
    const { manager } = await setup();
    const job = await manager.start("stat", async () => ok);
    const waited = await manager.wait(job.id, 1000);
    expect(waited.status.state).toBe("completed");
    expect(manager.cancel(job.id).state).toBe("completed");
  });

  it("returns a timeout before the job finishes and can be waited again", async () => {
    const { manager } = await setup();
    let release: (value: typeof ok) => void = () => {};
    const job = await manager.start(
      "tar",
      () => new Promise((resolve) => (release = resolve)),
    );
    const timedOut = await manager.wait(job.id, 10);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.status.state).toBe("running");
    release(ok);
    const completed = await manager.wait(job.id, 1000);
    expect(completed.timedOut).toBe(false);
    expect(completed.status.state).toBe("completed");
    expect(completed.result).toEqual(ok);
  });

  it("enforces the concurrency limit", async () => {
    const dir = await makeRoot("fs-jobs-limit-");
    dirs.push(dir);
    const manager = new JobManager({ dir, limit: 1 });
    managers.push(manager);
    let release: (value: typeof ok) => void = () => {};
    const first = await manager.start(
      "cp",
      () => new Promise((resolve) => (release = resolve)),
    );
    await expect(manager.start("cp", async () => ok)).rejects.toMatchObject({ code: "busy" });
    release(ok);
    await manager.wait(first.id, 1000);
    const second = await manager.start("cp", async () => ok);
    expect((await manager.wait(second.id, 1000)).status.state).toBe("completed");
  });

  it("reports a missing job", async () => {
    const { manager } = await setup();
    expect(() => manager.status("missing")).toThrow(FsError);
    expect(() => manager.cancel("missing")).toThrow(FsError);
    await expect(manager.wait("missing", 10)).rejects.toMatchObject({ code: "not-found" });
  });

  it("fails to start when the status directory cannot be created", async () => {
    const dir = await makeRoot("fs-jobs-file-");
    dirs.push(dir);
    const file = path.join(dir, "not-a-dir");
    await fs.writeFile(file, "x");
    const manager = new JobManager({ dir: file });
    managers.push(manager);
    await expect(manager.start("cp", async () => ok)).rejects.toThrow();
    expect(manager.list()).toEqual([]);
  });

  it("aborts a job that exceeds the running TTL", async () => {
    const dir = await makeRoot("fs-jobs-running-ttl-");
    dirs.push(dir);
    const manager = new JobManager({ dir, ttlMs: 20 });
    managers.push(manager);
    const job = await manager.start(
      "cp",
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("ttl")), { once: true });
        }),
    );
    const waited = await manager.wait(job.id, 1000);
    expect(waited.status.state).toBe("cancelled");
    expect(waited.status.error).toBe("ttl");
  });

  it("removes completed jobs and status files after the cleanup TTL", async () => {
    const dir = await makeRoot("fs-jobs-cleanup-");
    dirs.push(dir);
    const manager = new JobManager({ dir, ttlMs: 20 });
    managers.push(manager);
    const job = await manager.start("stat", async () => ok);
    await manager.wait(job.id, 1000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(manager.list()).toEqual([]);
    await expect(fs.access(path.join(dir, `${job.id}.json`))).rejects.toThrow();
  });

  it("lists jobs newest first and disposes running jobs", async () => {
    const dir = await makeRoot("fs-jobs-list-");
    dirs.push(dir);
    let clock = 100;
    const manager = new JobManager({ dir, now: () => clock++, ttlMs: 60_000 });
    managers.push(manager);
    let release: (value: typeof ok) => void = () => {};
    const first = await manager.start(
      "cp",
      () => new Promise((resolve) => (release = resolve)),
    );
    const second = await manager.start("stat", async () => ok);
    expect(manager.list().map((job) => job.id)).toEqual([second.id, first.id]);
    let aborted = false;
    const original = manager as unknown as { jobs: Map<string, { controller: AbortController }> };
    original.jobs.get(first.id)?.controller.signal.addEventListener("abort", () => (aborted = true));
    manager.dispose();
    expect(aborted).toBe(true);
    expect(manager.list()).toEqual([]);
    release(ok);
  });
});
