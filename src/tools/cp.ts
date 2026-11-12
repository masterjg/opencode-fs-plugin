/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno, isMissing } from "../core/errors.js";
import { copyTree, isSubpath } from "../core/fsutil.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    sources: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
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

interface Source {
  requested: string;
  full: string;
  isDirectory: boolean;
  isSymlink: boolean;
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

    const sources: Source[] = [];
    for (const requested of input.sources) {
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
      sources.push({
        requested,
        full: target.full,
        isDirectory: stats.isDirectory(),
        isSymlink: !dereference && stats.isSymbolicLink(),
      });
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
      source,
      destination:
        destIsDirectory || sources.length > 1
          ? path.join(destTarget.full, path.basename(path.resolve(source.requested)))
          : destTarget.full,
    }));

    for (const job of jobs) {
      if (job.source.full === job.destination) {
        throw new FsError(`"${job.source.requested}" and destination are the same file.`, "invalid");
      }
      if (job.source.isDirectory && isSubpath(job.source.full, job.destination)) {
        throw new FsError(`Cannot copy a directory into itself: "${job.source.requested}".`, "invalid");
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
      const target = await ctx.sandbox.resolveForCreate(job.destination);
      entries.push({ target, boundary: path.dirname(target.full) });
    }
    await ctx.permission.assert(entries);

    const copied = await Promise.all(
      jobs.map((job) =>
        copyTree(job.source.full, job.destination, {
          recursive,
          dereference,
          preserve,
          noClobber: input.noClobber === true,
          update: input.update === true,
          signal: ctx.signal,
          concurrency: ctx.concurrency,
        }),
      ),
    );
    const total = copied.reduce((sum, value) => sum + value, 0);
    const output = input.verbose === true
      ? jobs.map((job) => `'${job.source.requested}' -> '${job.destination}'`).join("\n")
      : "";
    return textResult(output, { copied: total, jobs: jobs.length, force: input.force === true });
  },
};
