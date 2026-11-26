/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { resolveGid, resolveUid, walkAll } from "../core/fsutil.js";
import { mapLimit } from "../core/parallel.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Paths to change." }),
    user: Type.Optional(Type.String({ description: "New owner name or uid." })),
    uid: Type.Optional(Type.Integer({ minimum: 0, description: "New numeric owner uid." })),
    group: Type.Optional(Type.String({ description: "New group name or gid." })),
    gid: Type.Optional(Type.Integer({ minimum: 0, description: "New numeric group gid." })),
    recursive: Type.Optional(Type.Boolean({ description: "Descend into directories (`-R`)." })),
    noDereference: Type.Optional(Type.Boolean({ description: "Affect symlinks themselves (`-h`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const chownTool: ToolSpec<Input> = {
  name: "chown",
  description:
    "Change file owner and/or group by name or id (`-R`, `-h`). At least one of user or group is required.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    if (input.user !== undefined && input.uid !== undefined) {
      throw new FsError("user and uid are mutually exclusive.", "invalid");
    }
    if (input.group !== undefined && input.gid !== undefined) {
      throw new FsError("group and gid are mutually exclusive.", "invalid");
    }
    const uid = input.uid ?? (input.user === undefined ? undefined : await resolveUid(input.user));
    const gid = input.gid ?? (input.group === undefined ? undefined : await resolveGid(input.group));
    if (uid === undefined && gid === undefined) {
      throw new FsError("at least one of user or group is required.", "invalid");
    }

    const targets = [];
    for (const requested of input.paths) {
      const target = input.noDereference === true
        ? await ctx.sandbox.resolveForCreate(requested)
        : await ctx.sandbox.resolveFollow(requested);
      ctx.sandbox.assertSafeToDelete(target.full);
      targets.push({ requested, target });
    }
    const entries: Array<{ full: string; requested: string; outside: boolean; directory: boolean }> = [];
    for (const { requested, target } of targets) {
      const stats = await ctx.sandbox.lstat(target.full, requested);
      entries.push({ full: target.full, requested, outside: target.outside, directory: stats.isDirectory() });
      if (input.recursive === true && stats.isDirectory()) {
        for (const entry of await walkAll(target.full, {
          recursive: true,
          includeHidden: true,
          concurrency: ctx.concurrency,
          signal: ctx.signal,
        })) {
          // Traversal symlinks are skipped: their targets were never resolved or gated.
          if (input.noDereference !== true && entry.stats.isSymbolicLink()) continue;
          entries.push({
            full: entry.path,
            requested: entry.path,
            outside: target.outside,
            directory: entry.stats.isDirectory(),
          });
        }
      }
    }
    await ctx.permission.assert(entries.map((entry) => ({
      target: { full: entry.full, outside: entry.outside, requested: entry.requested, realAncestor: entry.full },
      boundary: ctx.sandbox.boundaryFor(entry.full, entry.directory ? "directory" : "file"),
    })));

    await mapLimit(entries, ctx.concurrency, async (entry) => {
      try {
        const stats = await fs.lstat(entry.full);
        const nextUid = uid ?? Number(stats.uid);
        const nextGid = gid ?? Number(stats.gid);
        if (input.noDereference === true) await fs.lchown(entry.full, nextUid, nextGid);
        else await fs.chown(entry.full, nextUid, nextGid);
      } catch (error) {
        /* v8 ignore next -- chown failures are permission-dependent */
        throw fromErrno(error);
      }
    }, ctx.signal);
    return textResult("", { changed: entries.length, uid: uid ?? null, gid: gid ?? null });
  },
};
