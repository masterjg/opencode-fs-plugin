/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FsError, errorMessage, fromErrno, isMissing } from "./errors.js";
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
  /** Internal bound on retained finished jobs; not a plugin option. */
  readonly retainedLimit?: number;
  /** Internal bound on one rendered result's content; not a plugin option. */
  readonly maxResultBytes?: number;
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
  /** Session that created the job; never exposed in snapshots. */
  readonly owner: string;
  result?: RenderedResult;
  done: Promise<void>;
  timer?: NodeJS.Timeout;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/**
 * Finished jobs are kept so `fs.job wait` can return their results. The TTL
 * alone bounds time, not count, so a burst of quick jobs would retain an
 * unbounded number of results and status files. Keep a finite window and evict
 * the oldest finished job before admitting a new one.
 */
const DEFAULT_MAX_RETAINED_JOBS = 64;
/** One retained rendered result; larger text is truncated and binary is dropped. */
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = "\n[truncated]";
/**
 * Owner used by direct `JobManager` callers (unit tests and internal helpers).
 * The plugin always passes the originating host session id, so this namespace
 * cannot collide with a real `ses_…` session and never widens another caller's
 * view.
 */
const LOCAL_OWNER = "local";

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
  private readonly retainedLimit: number;
  private readonly maxResultBytes: number;
  private readonly now: () => number;
  /** Serializes admission so concurrent starts cannot overrun either cap. */
  private admission: Promise<void> = Promise.resolve();

  constructor(options: JobManagerOptions = {}) {
    this.dir = options.dir ?? path.join(os.tmpdir(), "opencode", "fs-jobs", String(process.pid));
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.retainedLimit = options.retainedLimit ?? DEFAULT_MAX_RETAINED_JOBS;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    this.now = options.now ?? Date.now;
  }

  async start(
    tool: string,
    run: (signal: AbortSignal) => Promise<RenderedResult>,
    owner: string = LOCAL_OWNER,
  ): Promise<JobStatus> {
    const job = await this.admit(tool, owner);
    try {
      await this.write(job);
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    }

    job.done = this.execute(job, run);
    this.armRunningDeadline(job);
    return snapshot(job);
  }

  status(id: string, owner: string = LOCAL_OWNER): JobStatus {
    return snapshot(this.require(id, owner));
  }

  list(owner: string = LOCAL_OWNER): JobStatus[] {
    return [...this.jobs.values()]
      .filter((job) => job.owner === owner)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((job) => snapshot(job));
  }

  async wait(id: string, timeoutMs: number, owner: string = LOCAL_OWNER): Promise<JobWait> {
    const job = this.require(id, owner);
    if (job.state !== "running") {
      // State flips before the final status write in `execute`; await the
      // completion promise so a caller never observes a stale "running" file.
      await job.done;
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

  cancel(id: string, owner: string = LOCAL_OWNER): JobStatus {
    const job = this.require(id, owner);
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

  /**
   * Reserve both a running slot and a retained slot. The check, eviction and
   * insertion run under one admission lock, so two concurrent starts cannot
   * both observe free capacity and then both insert.
   */
  private async admit(tool: string, owner: string): Promise<JobRecord> {
    if (owner.length === 0) throw new FsError("job owner is required.", "invalid");
    return this.withAdmission(async () => {
      if (this.runningCount() >= this.limit) {
        throw new FsError(`background job limit reached (${this.limit} running).`, "busy");
      }
      await this.ensureCapacity();

      const id = `job_${randomUUID()}`;
      const job: JobRecord = {
        id,
        tool,
        owner,
        state: "running",
        startedAt: this.now(),
        statusPath: path.join(this.dir, `${id}.json`),
        controller: new AbortController(),
        done: Promise.resolve(),
      };
      this.jobs.set(id, job);
      return job;
    });
  }

  private async withAdmission<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.admission;
    let release!: () => void;
    this.admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  /**
   * Evict the oldest finished jobs until one slot remains for a new job.
   * Running jobs are never evicted; if only running jobs remain, the caller
   * fails with `busy` rather than growing the retained window.
   */
  private async ensureCapacity(): Promise<void> {
    while (this.jobs.size >= this.retainedLimit) {
      const victim = this.oldestFinished();
      if (victim === undefined) {
        throw new FsError(
          `background job retention limit reached (${this.retainedLimit} jobs).`,
          "busy",
        );
      }
      // Remove it from the map first so concurrent starts cannot pick the same
      // victim; then wait for its final status write before deleting the file.
      this.jobs.delete(victim.id);
      clearTimeout(victim.timer);
      await victim.done;
      clearTimeout(victim.timer);
      /* v8 ignore next -- retained status-file cleanup is best-effort */
      await fs.rm(victim.statusPath, { force: true }).catch(() => {});
    }
  }

  private oldestFinished(): JobRecord | undefined {
    let oldest: JobRecord | undefined;
    for (const job of this.jobs.values()) {
      if (job.state === "running") continue;
      if (oldest === undefined || (job.finishedAt as number) < (oldest.finishedAt as number)) {
        oldest = job;
      }
    }
    return oldest;
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
        job.result = this.boundResult(result);
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
    await this.ensureDir();
    // A random, exclusive-create temp name prevents a pre-planted symlink from
    // redirecting the status write (the job id and pid alone are predictable).
    const temp = `${job.statusPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    // Keep sensitive runtime data (raw errors, absolute status path) out of the
    // on-disk file; the owner still gets the rich snapshot from fs.job.
    const payload = {
      id: job.id,
      tool: job.tool,
      state: job.state,
      startedAt: job.startedAt,
      ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
      ...(job.result ? { hasResult: true } : {}),
    };
    await fs.writeFile(temp, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, job.statusPath);
  }

  /**
   * Create or validate the status directory without following a pre-existing
   * symlink anywhere in the configured path. A caller-supplied ordinary nested
   * directory keeps working; any symlink, non-directory, root, or inaccessible
   * component fails before a chmod or write. A resolve/check-to-syscall race
   * remains possible, so this is a guardrail, not a kernel boundary.
   */
  private async ensureDir(): Promise<void> {
    const absolute = path.resolve(this.dir);
    const root = path.parse(absolute).root;
    if (absolute === root) {
      throw new FsError(`job directory must not be the filesystem root: ${absolute}`, "invalid");
    }

    let current = root;
    let missing = false;
    for (const part of path.relative(root, absolute).split(path.sep)) {
      current = path.join(current, part);
      if (missing) continue;
      let stats: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        stats = await fs.lstat(current);
      } catch (error) {
        /* v8 ignore next -- a non-missing lstat error is an OS access failure */
        if (!isMissing(error)) throw fromErrno(error, "access");
        missing = true;
        continue;
      }
      if (stats.isSymbolicLink()) {
        throw new FsError(`job directory must not contain a symbolic link: ${current}`, "invalid");
      }
      if (!stats.isDirectory()) {
        throw new FsError(`job directory component is not a directory: ${current}`, "not-directory");
      }
    }

    if (missing) await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
    await fs.chmod(absolute, 0o700);
  }

  private boundResult(result: RenderedResult): RenderedResult {
    const bytes = Buffer.byteLength(result.content, "utf8");
    if (bytes <= this.maxResultBytes) return result;
    const metadata = { ...result.metadata, truncated: true, originalBytes: bytes };
    if (result.metadata.encoding === "base64") {
      return { content: "", metadata };
    }
    const limit = Math.max(0, this.maxResultBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
    return { content: `${truncateUtf8(result.content, limit)}${TRUNCATION_MARKER}`, metadata };
  }

  private require(id: string, owner: string = LOCAL_OWNER): JobRecord {
    const job = this.jobs.get(id);
    if (job === undefined || job.owner !== owner) {
      // Deliberately identical for missing and foreign jobs: a caller without
      // the owner token must not learn that another session's id exists.
      throw new FsError(`job not found: ${id}`, "not-found");
    }
    return job;
  }

  private runningCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.state === "running") count++;
    return count;
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
