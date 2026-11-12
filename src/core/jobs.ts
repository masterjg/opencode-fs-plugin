/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsError, errorMessage } from "./errors.js";
import type { RenderedResult } from "./format.js";

export type JobState = "running" | "completed" | "failed" | "cancelled";

export interface JobStatus {
  readonly id: string;
  readonly tool: string;
  readonly state: JobState;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly error?: string;
  readonly statusPath: string;
}

export interface JobWait {
  readonly status: JobStatus;
  readonly timedOut: boolean;
  readonly result?: RenderedResult;
}

export interface JobManagerOptions {
  readonly dir?: string;
  readonly limit?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

interface JobRecord {
  readonly id: string;
  readonly tool: string;
  state: JobState;
  readonly startedAt: number;
  finishedAt?: number;
  error?: string;
  readonly statusPath: string;
  readonly controller: AbortController;
  result?: RenderedResult;
  done: Promise<void>;
  timer?: NodeJS.Timeout;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function snapshot(job: JobRecord): JobStatus {
  return {
    id: job.id,
    tool: job.tool,
    state: job.state,
    startedAt: job.startedAt,
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.error === undefined ? {} : { error: job.error }),
    statusPath: job.statusPath,
  };
}



export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly dir: string;
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: JobManagerOptions = {}) {
    this.dir = options.dir ?? path.join(os.tmpdir(), "opencode", "fs-jobs", String(process.pid));
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async start(tool: string, run: (signal: AbortSignal) => Promise<RenderedResult>): Promise<JobStatus> {
    if (this.runningCount() >= this.limit) {
      throw new FsError(`background job limit reached (${this.limit} running).`, "busy");
    }

    const id = `job_${randomUUID()}`;
    const job: JobRecord = {
      id,
      tool,
      state: "running",
      startedAt: this.now(),
      statusPath: path.join(this.dir, `${id}.json`),
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.jobs.set(id, job);

    try {
      await this.write(job);
    } catch (error) {
      this.jobs.delete(id);
      throw error;
    }

    job.done = this.execute(job, run);
    this.armRunningDeadline(job);
    return snapshot(job);
  }

  status(id: string): JobStatus {
    return snapshot(this.require(id));
  }

  list(): JobStatus[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((job) => snapshot(job));
  }

  async wait(id: string, timeoutMs: number): Promise<JobWait> {
    const job = this.require(id);
    if (job.state !== "running") {
      return { status: snapshot(job), timedOut: false, ...(job.result ? { result: job.result } : {}) };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      void job.done.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return {
      status: snapshot(job),
      timedOut: job.state === "running",
      ...(job.result ? { result: job.result } : {}),
    };
  }

  cancel(id: string): JobStatus {
    const job = this.require(id);
    if (job.state === "running") job.controller.abort();
    return snapshot(job);
  }

  dispose(): void {
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      if (job.state === "running") job.controller.abort();
    }
    this.jobs.clear();
  }

  private async execute(
    job: JobRecord,
    run: (signal: AbortSignal) => Promise<RenderedResult>,
  ): Promise<void> {
    try {
      const result = await run(job.controller.signal);
      if (job.controller.signal.aborted) {
        job.state = "cancelled";
      } else {
        job.state = "completed";
        job.result = result;
      }
    } catch (error) {
      job.state = job.controller.signal.aborted ? "cancelled" : "failed";
      job.error = errorMessage(error);
    } finally {
      job.finishedAt = this.now();
      /* v8 ignore next 3 -- a status-file write failure must not lose the job result */
      await this.write(job).catch(() => {});
      this.armCleanup(job);
    }
  }

  private armRunningDeadline(job: JobRecord): void {
    job.timer = setTimeout(() => {
      job.controller.abort();
    }, this.ttlMs);
    job.timer.unref();
  }

  private armCleanup(job: JobRecord): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      this.jobs.delete(job.id);
      /* v8 ignore next -- status-file cleanup is best-effort */
      void fs.rm(job.statusPath, { force: true }).catch(() => {});
    }, this.ttlMs);
    job.timer.unref();
  }

  private async write(job: JobRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const temp = `${job.statusPath}.${process.pid}.tmp`;
    const payload = {
      ...snapshot(job),
      ...(job.result ? { hasResult: true } : {}),
    };
    await fs.writeFile(temp, `${JSON.stringify(payload)}\n`, "utf8");
    await fs.rename(temp, job.statusPath);
  }

  private require(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new FsError(`job not found: ${id}`, "not-found");
    return job;
  }

  private runningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.state === "running") count++;
    return count;
  }
}
