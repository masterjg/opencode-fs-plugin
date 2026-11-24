/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { FsError } from "./errors.js";
import type { ToolResult } from "./types.js";

/** The dynamic threshold never goes below this. */
export const MIN_SPILL_THRESHOLD = 16 * 1024 * 1024;

/** The dynamic threshold never goes above this. */
export const MAX_SPILL_THRESHOLD = 512 * 1024 * 1024;

/** Bytes of a spilled result returned to the host as a preview. */
export const SPILL_PREVIEW = 64 * 1024;

/** A quarter of free memory, clamped to a safe range. */
export function dynamicSpillThreshold(free = os.freemem()): number {
  return Math.max(MIN_SPILL_THRESHOLD, Math.min(MAX_SPILL_THRESHOLD, Math.floor(free / 4)));
}

/** An explicit byte count from the plugin options; undefined means dynamic. */
export function normalizeSpillThreshold(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new FsError("spillThresholdBytes must be a positive number.", "invalid");
  }
  return Math.trunc(value);
}

/** The shared directory for spilled outputs under the plugin's temp area. */
export function spillDirectory(tmpdir: string): string {
  return path.join(tmpdir, "opencode", "fs-spill");
}

export interface SpillResult {
  /** The full output when it stayed in memory, else its first bytes. */
  readonly preview: Buffer;
  /** Set when the full output was written to disk. */
  readonly path: string | undefined;
  /** Total bytes written. */
  readonly bytes: number;
}

/**
 * Collects chunks with a bounded in-memory prefix. Once a direct call passes
 * `threshold`, the full stream goes to a temporary file and `finish` returns
 * only the prefix; pipe stages pass `memoryOnly` and keep the whole buffer.
 */
export class SpillSink {
  private chunks: Buffer[] = [];
  private head: Buffer[] = [];
  private headBytes = 0;
  private bytes = 0;
  private handle: FileHandle | undefined;
  private filePath: string | undefined;

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly memoryOnly = false,
    private readonly threshold = dynamicSpillThreshold(),
    private readonly previewBytes = SPILL_PREVIEW,
  ) {}

  async write(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    this.bytes += chunk.length;
    if (this.headBytes < this.previewBytes) {
      const take = Math.min(chunk.length, this.previewBytes - this.headBytes);
      this.head.push(chunk.subarray(0, take));
      this.headBytes += take;
    }
    if (this.handle !== undefined) {
      await this.handle.write(chunk);
      return;
    }
    this.chunks.push(chunk);
    if (!this.memoryOnly && this.bytes > this.threshold) await this.spill();
  }

  private async spill(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    this.filePath = path.join(this.dir, `${this.name}-${randomUUID()}.out`);
    this.handle = await fs.open(this.filePath, "w");
    for (const chunk of this.chunks) await this.handle.write(chunk);
    this.chunks = [];
  }

  async finish(): Promise<SpillResult> {
    const preview = this.handle === undefined ? Buffer.concat(this.chunks) : Buffer.concat(this.head);
    const filePath = this.filePath;
    if (this.handle !== undefined) {
      await this.handle.close();
      this.handle = undefined;
    }
    return { preview, path: filePath, bytes: this.bytes };
  }

  /** Closes and removes a partial spill file. */
  async abort(): Promise<void> {
    if (this.handle !== undefined) {
      /* v8 ignore next */
      await this.handle.close().catch(() => undefined);
      this.handle = undefined;
    }
    if (this.filePath !== undefined) {
      /* v8 ignore next */
      await fs.rm(this.filePath, { force: true }).catch(() => undefined);
      this.filePath = undefined;
    }
  }
}

/**
 * Spill a finished tool result that is larger than the threshold. Tools that
 * already streamed into a sink carry `outputPath` and pass through.
 */
export async function spillResult(
  result: ToolResult,
  name: string,
  tmpdir: string,
  threshold = dynamicSpillThreshold(),
): Promise<ToolResult> {
  if (result.stdout.length <= threshold || result.metadata?.outputPath !== undefined) return result;
  const sink = new SpillSink(spillDirectory(tmpdir), name, false, 0);
  try {
    await sink.write(result.stdout);
    const out = await sink.finish();
    return {
      ...result,
      stdout: out.preview,
      metadata: { ...result.metadata, bytes: out.bytes, outputPath: out.path, spilled: true },
    };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}
