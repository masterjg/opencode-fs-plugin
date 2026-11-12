/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { parseSize } from "../core/format.js";
import { num } from "../core/fsutil.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    size: Type.Optional(Type.String({ description: "Target size, optionally relative with leading + or -, e.g. 10M." })),
    reference: Type.Optional(Type.String({ description: "Use another file's size (`-r`)." })),
    noCreate: Type.Optional(Type.Boolean({ description: "Do not create missing files (`-c`)." })),
    noDereference: Type.Optional(Type.Boolean({ description: "Do not follow a final symlink (`-o`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const truncateTool: ToolSpec<Input> = {
  name: "truncate",
  description:
    "Shrink or extend files to a size with Linux `truncate` semantics (`-s`, `-r`, `-c`, `-o`). " +
    "Sizes accept K, M, G, T, P and E suffixes.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    if (input.size === undefined && input.reference === undefined) {
      throw new FsError("size or reference is required.", "invalid");
    }
    const referenceSize =
      input.reference === undefined
        ? undefined
        : num((await ctx.sandbox.lstat((await ctx.sandbox.resolveExisting(input.reference, { allowRoot: true })).full, input.reference)).size);

    const changed: string[] = [];
    for (const requested of input.paths) {
      const target = await ctx.sandbox.resolveForCreate(requested);
      await ctx.permission.assert([{ target, boundary: target.full }]);
      let stats;
      try {
        stats = await ctx.sandbox.lstat(target.full, requested);
      } catch (error) {
        if (!(error instanceof FsError) || error.code !== "not-found") throw error;
        if (input.noCreate === true) continue;
        try {
          const handle = await fs.open(target.full, "a");
          await handle.close();
          stats = await ctx.sandbox.lstat(target.full, requested);
        } catch (openError) {
          throw fromErrno(openError);
        }
      }

      const desired = input.size === undefined ? (referenceSize ?? 0) : relativeSize(num(stats.size), input.size);
      if (desired < 0) throw new FsError(`Size is negative: ${desired}`, "invalid");
      try {
        if (input.noDereference === true) {
          const handle = await fs.open(target.full, constants.O_WRONLY | constants.O_NOFOLLOW);
          try {
            await handle.truncate(desired);
          } finally {
            await handle.close();
          }
        } else {
          await fs.truncate(target.full, desired);
        }
      } catch (error) {
        throw fromErrno(error);
      }
      changed.push(requested);
    }
    return textResult("", { changed });
  },
};

function relativeSize(current: number, value: string): number {
  const sign = value.startsWith("+") ? 1 : value.startsWith("-") ? -1 : 0;
  const body = sign === 0 ? value : value.slice(1);
  const parsed = parseSize(body);
  return sign === 0 ? parsed : current + sign * parsed;
}
