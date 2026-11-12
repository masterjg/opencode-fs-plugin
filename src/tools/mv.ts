/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno, isMissing } from "../core/errors.js";
import { copyTree, ensureParent } from "../core/fsutil.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    sources: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    destination: Type.String({ minLength: 1 }),
    force: Type.Optional(Type.Boolean({ description: "Overwrite existing destinations (`-f`)." })),
    noClobber: Type.Optional(Type.Boolean({ description: "Never overwrite (`-n`)." })),
    update: Type.Optional(Type.Boolean({ description: "Move only when the source is newer (`-u`)." })),
    verbose: Type.Optional(Type.Boolean({ description: "Report moved paths (`-v`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const mvTool: ToolSpec<Input> = {
  name: "mv",
  description:
    "Move or rename files and directories with Linux `mv` semantics (`-f`, `-n`, `-u`, `-v`). " +
    "Cross-device moves fall back to copy-then-remove.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const sources = [];
    for (const requested of input.sources) {
      const target = await ctx.sandbox.resolveExisting(requested);
      ctx.sandbox.assertSafeToDelete(target.full);
      const stats = await ctx.sandbox.lstat(target.full, requested);
      sources.push({ requested, target, stats });
    }

    const destTarget = await ctx.sandbox.resolveForCreate(input.destination);
    let destIsDirectory = false;
    try {
      destIsDirectory = (await fs.lstat(destTarget.full)).isDirectory();
    } catch (error) {
      /* v8 ignore next 2 */
      if (!isMissing(error)) throw fromErrno(error, "access");
    }
    if (sources.length > 1 && !destIsDirectory) {
      throw new FsError("Multiple sources require an existing directory destination.", "not-directory");
    }

    const jobs = sources.map((source) => ({
      ...source,
      destination:
        destIsDirectory || sources.length > 1
          ? path.join(destTarget.full, path.basename(path.resolve(source.requested)))
          : destTarget.full,
    }));

    for (const job of jobs) {
      if (job.target.full === job.destination) {
        throw new FsError(`"${job.requested}" and destination are the same file.`, "invalid");
      }
    }

    const entries = jobs.map((job) => ({
      target: job.target,
      boundary: job.stats.isDirectory() ? job.target.full : path.dirname(job.target.full),
    }));
    for (const job of jobs) {
      const target = await ctx.sandbox.resolveForCreate(job.destination);
      entries.push({ target, boundary: path.dirname(target.full) });
    }
    await ctx.permission.assert(entries);

    const moved: string[] = [];
    for (const job of jobs) {
      if (input.noClobber === true && (await exists(job.destination))) continue;
      if (input.update === true && (await exists(job.destination))) {
        const destStats = await fs.lstat(job.destination);
        /* v8 ignore next */
        if (destStats.mtimeMs >= job.stats.mtimeMs) continue;
      }
      await ensureParent(job.destination);
      try {
        await fs.rename(job.target.full, job.destination);
      } catch (error) {
        /* v8 ignore next */
        if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") {
          /* v8 ignore next 3 */
          if (input.force === true && (await exists(job.destination))) {
            await fs.rm(job.destination, { recursive: true, force: true });
            await fs.rename(job.target.full, job.destination);
          } else {
            /* v8 ignore next */
            throw fromErrno(error);
          }
        } else {
          await copyTree(job.target.full, job.destination, {
            recursive: true,
            dereference: false,
            preserve: true,
            noClobber: input.noClobber === true,
            update: input.update === true,
            signal: ctx.signal,
            concurrency: ctx.concurrency,
          });
          await fs.rm(job.target.full, { recursive: true, force: true });
        }
      }
      moved.push(job.requested);
    }

    const output = input.verbose === true
      ? jobs.filter((job) => moved.includes(job.requested)).map((job) => `'${job.requested}' -> '${job.destination}'`).join("\n")
      : "";
    return textResult(output, { moved: moved.length });
  },
};

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    /* v8 ignore next */
    if (isMissing(error)) return false;
    /* v8 ignore next */
    throw fromErrno(error, "access");
  }
}
