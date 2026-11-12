/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as os from "node:os";
import { FsError } from "../../src/core/errors.js";
import {
  autoConcurrency,
  clampConcurrency,
  createLimiter,
  forEachLimit,
  mapLimit,
} from "../../src/core/parallel.js";

const original = process.env.OPENCODE_FS_CONCURRENCY;

afterEach(() => {
  if (original === undefined) delete process.env.OPENCODE_FS_CONCURRENCY;
  else process.env.OPENCODE_FS_CONCURRENCY = original;
});

describe("parallel helpers", () => {
  it("defaults to the available core count", () => {
    delete process.env.OPENCODE_FS_CONCURRENCY;
    expect(autoConcurrency()).toBe(Math.max(1, os.availableParallelism()));
  });

  it("reads a valid environment override", () => {
    process.env.OPENCODE_FS_CONCURRENCY = "3";
    expect(autoConcurrency()).toBe(3);
  });

  it("ignores invalid environment overrides", () => {
    process.env.OPENCODE_FS_CONCURRENCY = "0";
    expect(autoConcurrency()).toBeGreaterThanOrEqual(1);
    process.env.OPENCODE_FS_CONCURRENCY = "nope";
    expect(autoConcurrency()).toBeGreaterThanOrEqual(1);
  });

  it("clamps explicit concurrency", () => {
    expect(clampConcurrency(undefined)).toBe(autoConcurrency());
    expect(clampConcurrency(2)).toBe(2);
    expect(() => clampConcurrency(0)).toThrow(FsError);
    expect(() => clampConcurrency(1.5)).toThrow(FsError);
  });

  it("maps in order with bounded concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return value * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(maximum).toBeLessThanOrEqual(2);
  });

  it("returns an empty result without scheduling", async () => {
    expect(await mapLimit([], 2, async () => 1)).toEqual([]);
  });

  it("rejects invalid limits", async () => {
    await expect(mapLimit([1], 0, async () => 1)).rejects.toThrow(FsError);
  });

  it("stops on the first task failure", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error("boom");
        return value;
      }),
    ).rejects.toThrow("boom");
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      mapLimit([1, 2], 1, async (value) => value, controller.signal),
    ).rejects.toMatchObject({ code: "interrupted" });
  });

  it("limits work through a shared gate", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maximum = 0;
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((value) =>
        limit(async () => {
          active++;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          active--;
          return value;
        }),
      ),
    );
    expect(maximum).toBeLessThanOrEqual(2);
  });

  it("validates the gate limit and releases after failures", async () => {
    expect(() => createLimiter(0)).toThrow(FsError);
    const limit = createLimiter(1);
    await expect(limit(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await expect(limit(async () => 1)).resolves.toBe(1);
  });

  it("runs forEachLimit", async () => {
    const seen: number[] = [];
    await forEachLimit([1, 2, 3], 2, async (value) => {
      seen.push(value);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});
