/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { sourcesFrom } from "../core/aliases.js";
import { FsError, fromErrno, isMissing } from "../core/errors.js";
import { copyTree, isSubpath, num } from "../core/fsutil.js";
import { createLimiter, mapLimit } from "../core/parallel.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    sources: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    source: Type.Optional(Type.String({ minLength: 1, description: "Alias for a single element of `sources`." })),
    destination: Type.String({ minLength: 1 }),
    recursive: Type.Optional(Type.Boolean({ description: "Copy directories recursively (`-r`, `-R`)." })),
    archive: Type.Optional(Type.Boolean({ description: "Archive mode (`-a`): recursive, preserve, keep symlinks." })),
    force: Type.Optional(Type.Boolean({ description: "Overwrite existing destinations (`-f`)." })),
    noClobber: Type.Optional(Type.Boolean({ description: "Never overwrite existing files (`-n`)." })),
    update: Type.Optional(Type.Boolean({ description: "Copy only when the source is newer (`-u`)." })),
    preserve: Type.Optional(Type.Boolean({ description: "Preserve mode and timestamps (`-p`)." })),
    dereference: Type.Optional(Type.Boolean({ description: "Follow source symlinks (`-L`); default true." })),
    verbose: Type.Optional(Type.Boolean({ description: "Report copied paths (`-v`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface Referent {
  dev: number;
  ino: number;
}

interface Source {
  requested: string;
  full: string;
  isDirectory: boolean;
  isSymlink: boolean;
  dev: number;
  ino: number;
  referent: Referent | undefined;
}

export const cpTool: ToolSpec<Input> = {
  name: "cp",
  description:
    "Copy files and directories with Linux `cp` semantics (`-r`, `-a`, `-f`, `-n`, `-u`, " +
    "`-p`, `-L`, `-v`). Multiple sources require a directory destination.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const archive = input.archive === true;
    const recursive = archive || input.recursive === true;
    const dereference = archive ? false : input.dereference !== false;
    const preserve = archive || input.preserve === true;

    const requestedSources = sourcesFrom(input);
    if (requestedSources.length === 0) throw new FsError("cp needs sources: [...]", "invalid");
    const sources: Source[] = [];
    for (const requested of requestedSources) {
      const target = dereference
        ? await ctx.sandbox.resolveFollow(requested)
        : await ctx.sandbox.resolveExisting(requested);
      const stats = dereference
        ? await ctx.sandbox.stat(target.full, requested)
        : await ctx.sandbox.lstat(target.full, requested);
      /* v8 ignore next */
      if (stats.isDirectory() && !recursive) {
        throw new FsError(`"${requested}" is a directory; recursive is required.`, "not-file");
      }
      const isSymlink = !dereference && stats.isSymbolicLink();
      let referent: Referent | undefined;
      if (isSymlink) {
        try {
          const followed = await ctx.sandbox.resolveFollow(requested);
          const referentStats = await ctx.sandbox.stat(followed.full, requested);
          referent = { dev: num(referentStats.dev), ino: num(referentStats.ino) };
        } catch (error) {
          /* v8 ignore next */
          if (!(error instanceof FsError) || error.code !== "not-found") throw error;
        }
      }
      sources.push({
        requested,
        full: target.full,
        isDirectory: stats.isDirectory(),
        isSymlink,
        dev: num(stats.dev),
        ino: num(stats.ino),
        referent,
      });
    }

    const unfollowedTarget = await ctx.sandbox.resolveForCreate(input.destination);
    const destinationTarget = await ctx.sandbox.resolveForWrite(input.destination);
    let destIsDirectory = false;
    try {
      destIsDirectory = (await fs.lstat(destinationTarget.full)).isDirectory();
    } catch (error) {
      /* v8 ignore next 2 */
      if (!isMissing(error)) throw fromErrno(error, "access");
    }
    if (sources.length > 1 && !destIsDirectory) {
      throw new FsError("Multiple sources require an existing directory destination.", "not-directory");
    }

    const jobs = await mapLimit(
      sources,
      ctx.concurrency,
      async (source) => {
        const unfollowed = input.noClobber === true || source.isSymlink;
        const candidate =
          destIsDirectory || sources.length > 1
            ? path.join(destinationTarget.full, path.basename(path.resolve(source.requested)))
            : unfollowed
              ? unfollowedTarget.full
              : destinationTarget.full;
        const destination = unfollowed
          ? await ctx.sandbox.resolveForCreate(candidate)
          : await ctx.sandbox.resolveForWrite(candidate);
        return { source, destination };
      },
      ctx.signal,
    );

    for (const job of jobs) {
      if (job.source.full === job.destination.full) {
        throw new FsError(`"${job.source.requested}" and destination are the same file.`, "invalid");
      }
      if (job.source.isDirectory && isSubpath(job.source.full, job.destination.full)) {
        throw new FsError(`Cannot copy a directory into itself: "${job.source.requested}".`, "invalid");
      }
      let destinationStats: Awaited<ReturnType<typeof fs.lstat>> | undefined;
      try {
        destinationStats = await fs.lstat(job.destination.full);
      } catch (error) {
        /* v8 ignore next */
        if (!isMissing(error)) throw fromErrno(error, "access");
      }
      if (
        destinationStats !== undefined &&
        num(destinationStats.dev) === job.source.dev &&
        num(destinationStats.ino) === job.source.ino
      ) {
        throw new FsError(`"${job.source.requested}" and destination are the same file.`, "invalid");
      }
      if (
        job.source.referent !== undefined &&
        destinationStats !== undefined &&
        job.source.referent.dev === num(destinationStats.dev) &&
        job.source.referent.ino === num(destinationStats.ino)
      ) {
        throw new FsError(
          `"${job.source.requested}" refers to the destination file itself.`,
          "invalid",
        );
      }
    }

    const entries = [];
    for (const source of sources) {
      const target = dereference
        ? await ctx.sandbox.resolveFollow(source.requested)
        : await ctx.sandbox.resolveExisting(source.requested);
      entries.push({
        target,
        boundary: source.isDirectory ? target.full : path.dirname(target.full),
      });
    }
    for (const job of jobs) {
      entries.push({ target: job.destination, boundary: path.dirname(job.destination.full) });
    }
    await ctx.permission.assert(entries);

    const limiter = createLimiter(ctx.concurrency);
    const copied = await mapLimit(
      jobs,
      ctx.concurrency,
      (job) =>
        copyTree(job.source.full, job.destination.full, {
          recursive,
          dereference,
          preserve,
          noClobber: input.noClobber === true,
          update: input.update === true,
          signal: ctx.signal,
          concurrency: ctx.concurrency,
          limiter,
        }),
      ctx.signal,
    );
    const total = copied.reduce((sum, value) => sum + value, 0);
    const output = input.verbose === true
      ? jobs.map((job) => `'${job.source.requested}' -> '${job.destination.full}'`).join("\n")
      : "";
    return textResult(output, { copied: total, jobs: jobs.length, force: input.force === true });
  },
};
