/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    accessOnly: Type.Optional(Type.Boolean({ description: "Change only access time (`-a`)." })),
    modifyOnly: Type.Optional(Type.Boolean({ description: "Change only modification time (`-m`)." })),
    noCreate: Type.Optional(Type.Boolean({ description: "Do not create missing files (`-c`)." })),
    date: Type.Optional(Type.String({ description: "Date string accepted by Date.parse, or @epoch (`-d`)." })),
    timestamp: Type.Optional(Type.String({ description: "GNU -t timestamp [[CC]YY]MMDDhhmm[.ss]." })),
    reference: Type.Optional(Type.String({ description: "Use another file's times (`-r`)." })),
    noDereference: Type.Optional(Type.Boolean({ description: "Affect a symlink itself (`-h`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const touchTool: ToolSpec<Input> = {
  name: "touch",
  description:
    "Create empty files or update access/modification times with Linux `touch` semantics " +
    "(`-a`, `-m`, `-c`, `-d`, `-t`, `-r`, `-h`).",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const base = await resolveTimes(ctx, input);
    const changed: string[] = [];
    for (const requested of input.paths) {
      const target = await ctx.sandbox.resolveForCreate(requested);
      await ctx.permission.assert([{ target, boundary: target.full }]);
      let stats;
      try {
        stats = await ctx.sandbox.lstat(target.full, requested);
      } catch (error) {
        /* v8 ignore next */
        if (!(error instanceof FsError) || error.code !== "not-found") throw error;
        if (input.noCreate === true) continue;
        try {
          const handle = await fs.open(target.full, "a");
          await handle.close();
          stats = await ctx.sandbox.lstat(target.full, requested);
        } catch (openError) {
          /* v8 ignore next */
          throw fromErrno(openError);
        }
      }

      const atime = input.modifyOnly === true ? stats.atime : base.atime;
      const mtime = input.accessOnly === true ? stats.mtime : base.mtime;
      try {
        if (input.noDereference === true) {
          await fs.lutimes(target.full, atime, mtime);
        } else {
          await fs.utimes(target.full, atime, mtime);
        }
      } catch (error) {
        /* v8 ignore next */
        throw fromErrno(error);
      }
      changed.push(requested);
    }
    return textResult("", { changed });
  },
};

async function resolveTimes(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  input: Input,
): Promise<{ atime: Date; mtime: Date }> {
  if (input.reference !== undefined) {
    const target = await ctx.sandbox.resolveExisting(input.reference, { allowRoot: true });
    const stats = await ctx.sandbox.lstat(target.full, input.reference);
    return { atime: stats.atime, mtime: stats.mtime };
  }
  if (input.date !== undefined) {
    return { atime: parseDate(input.date), mtime: parseDate(input.date) };
  }
  if (input.timestamp !== undefined) {
    const date = parseGnuTimestamp(input.timestamp);
    return { atime: date, mtime: date };
  }
  const now = new Date();
  return { atime: now, mtime: now };
}

export function parseDate(value: string): Date {
  if (value.startsWith("@")) {
    const seconds = Number(value.slice(1));
    if (!Number.isFinite(seconds)) throw new FsError(`Invalid date: ${value}`, "invalid");
    return new Date(seconds * 1000);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new FsError(`Invalid date: ${value}`, "invalid");
  return new Date(parsed);
}

export function parseGnuTimestamp(value: string): Date {
  const match = /^(?:(\d{2})(\d{2})|(\d{2}))?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(value);
  if (!match) throw new FsError(`Invalid timestamp: ${value}`, "invalid");
  const current = new Date();
  const century = match[1];
  const twoDigitYear = match[2] ?? match[3];
  const year = century !== undefined && twoDigitYear !== undefined
    ? Number(century) * 100 + Number(twoDigitYear)
    : twoDigitYear === undefined
      ? current.getFullYear()
      /* v8 ignore next 3 */
      : Number(twoDigitYear) >= 69
        ? 1900 + Number(twoDigitYear)
        : 2000 + Number(twoDigitYear);
  const month = Number(match[4]) - 1;
  const day = Number(match[5]);
  const hour = Number(match[6]);
  const minute = Number(match[7]);
  const second = Number(match[8] ?? "0");
  const date = new Date(year, month, day, hour, minute, second);
  /* v8 ignore next */
  if (Number.isNaN(date.getTime())) throw new FsError(`Invalid timestamp: ${value}`, "invalid");
  return date;
}
