/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as os from "node:os";
import { FsError } from "./errors.js";

export function autoConcurrency(): number {
  const raw = process.env.OPENCODE_FS_CONCURRENCY;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return Math.max(1, os.availableParallelism());
}

export function clampConcurrency(value: number | undefined): number {
  if (value === undefined) return autoConcurrency();
  if (!Number.isInteger(value) || value < 1) {
    throw new FsError("concurrency must be a positive integer.", "invalid");
  }
  return value;
}

/**
 * Bounded parallel map that preserves input order and stops scheduling new
 * work as soon as the signal aborts or a task fails.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new FsError("parallel limit must be a positive integer.", "invalid");
  }
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let next = 0;
  let failed: unknown;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed !== undefined) return;
      if (signal?.aborted) {
        failed = new FsError("Operation interrupted.", "interrupted");
        return;
      }
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index] as T, index);
      } catch (error) {
        failed ??= error;
        return;
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  if (failed !== undefined) throw failed;
  return results;
}

export async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  await mapLimit(items, limit, mapper, signal);
}
