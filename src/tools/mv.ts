/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { sourcesFrom } from "../core/aliases.js";
import { FsError, fromErrno, isMissing } from "../core/errors.js";
import { copyTree, ensureParent, isSubpath, num } from "../core/fsutil.js";
import { createLimiter } from "../core/parallel.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    sources: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    source: Type.Optional(Type.String({ minLength: 1, description: "Alias for a single element of `sources`." })),
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
    const requestedSources = sourcesFrom(input);
    if (requestedSources.length === 0) throw new FsError("mv needs sources: [...]", "invalid");
    const sources = [];
    for (const requested of requestedSources) {
      const target = await ctx.sandbox.resolveExisting(requested);
      ctx.sandbox.assertSafeToDelete(target.full);
      const stats = await ctx.sandbox.lstat(target.full, requested);
      let referent: { dev: number; ino: number } | undefined;
      if (stats.isSymbolicLink()) {
        try {
          const followed = await ctx.sandbox.resolveFollow(requested);
          const referentStats = await ctx.sandbox.stat(followed.full, requested);
          referent = { dev: num(referentStats.dev), ino: num(referentStats.ino) };
        } catch (error) {
          /* v8 ignore next */
          if (!(error instanceof FsError) || error.code !== "not-found") throw error;
        }
      }
      sources.push({ requested, target, stats, referent });
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
      if (job.stats.isDirectory() && isSubpath(job.target.full, job.destination)) {
        throw new FsError(`Cannot move a directory into itself: "${job.requested}".`, "invalid");
      }
      const destinationStats = await lstatOptional(job.destination);
      if (
        job.referent !== undefined &&
        destinationStats !== undefined &&
        job.referent.dev === num(destinationStats.dev) &&
        job.referent.ino === num(destinationStats.ino)
      ) {
        throw new FsError(
          `"${job.requested}" refers to the destination file itself.`,
          "invalid",
        );
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

    const limiter = createLimiter(ctx.concurrency);
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
        if ((error as NodeJS.ErrnoException)?.code !== "EXDEV") throw fromErrno(error);
        const destinationStats = await lstatOptional(job.destination);
        if (destinationStats?.isSymbolicLink() === true) {
          throw new FsError(`Refusing to move across devices onto a symbolic link: "${job.destination}".`, "invalid");
        }
        const skipped = { count: 0 };
        const copied = await copyTree(job.target.full, job.destination, {
          recursive: true,
          dereference: false,
          preserve: true,
          noClobber: input.noClobber === true,
          update: input.update === true,
          signal: ctx.signal,
          concurrency: ctx.concurrency,
          limiter,
          onSkip: () => {
            skipped.count++;
          },
        });
        if (copied === 0) {
          throw new FsError(
            `Cross-device move did not transfer "${job.requested}"; source preserved.`,
            "cross-device",
          );
        }
        if (skipped.count > 0) {
          throw new FsError(
            `Cross-device move left a partial destination at "${job.destination}"; ` +
              `source "${job.requested}" preserved.`,
            "cross-device",
          );
        }
        await fs.rm(job.target.full, { recursive: true, force: true });
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
  return (await lstatOptional(target)) !== undefined;
}

async function lstatOptional(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    /* v8 ignore next */
    if (!isMissing(error)) throw fromErrno(error, "access");
    return undefined;
  }
}
