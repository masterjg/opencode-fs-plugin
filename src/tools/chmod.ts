/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { num, walkAll } from "../core/fsutil.js";
import { parseMode } from "../core/mode.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    mode: Type.Optional(Type.String({ description: "Octal or symbolic mode, e.g. 755 or u=rwx,go=rx." })),
    reference: Type.Optional(Type.String({ description: "Use another file's mode (`--reference`)." })),
    recursive: Type.Optional(Type.Boolean({ description: "Change modes recursively (`-R`)." })),
    noDereference: Type.Optional(Type.Boolean({ description: "Refuse to follow symlinks (`-h`)." })),
    verbose: Type.Optional(Type.Boolean({ description: "Report every changed path (`-v`)." })),
    changes: Type.Optional(Type.Boolean({ description: "Report only actual changes (`-c`)." })),
    silent: Type.Optional(Type.Boolean({ description: "Suppress most errors (`-f`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const chmodTool: ToolSpec<Input> = {
  name: "chmod",
  description:
    "Change file modes with Linux `chmod` semantics (`-R`, `--reference`, `-v`, `-c`, `-f`). " +
    "Supports octal and symbolic modes.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    if (input.mode === undefined && input.reference === undefined) {
      throw new FsError("mode or reference is required.", "invalid");
    }
    let referenceMode: number | undefined;
    if (input.reference !== undefined) {
      const reference = await ctx.sandbox.resolveFollow(input.reference);
      await ctx.permission.assert([{ target: reference, boundary: ctx.sandbox.boundaryFor(reference.full, "file") }]);
      const stats = await ctx.sandbox.lstat(reference.full, input.reference);
      referenceMode = num(stats.mode) & 0o7777;
    }

    const changed: string[] = [];
    for (const requested of input.paths) {
      const root = input.noDereference === true
        ? await ctx.sandbox.resolveForCreate(requested)
        : await ctx.sandbox.resolveFollow(requested);
      ctx.sandbox.assertSafeToDelete(root.full);
      const rootStats = await ctx.sandbox.lstat(root.full, requested);
      const targets = [{ target: root, directory: rootStats.isDirectory() }];
      if (input.recursive === true && rootStats.isDirectory()) {
        for (const entry of await walkAll(root.full, {
          recursive: true,
          signal: ctx.signal,
          concurrency: ctx.concurrency,
        })) {
          // Traversal symlinks are skipped: their targets were never resolved or gated.
          if (input.noDereference !== true && entry.stats.isSymbolicLink()) continue;
          targets.push({
            target: {
              full: entry.path,
              outside: root.outside,
              requested: entry.path,
              realAncestor: root.realAncestor,
            },
            directory: entry.stats.isDirectory(),
          });
        }
      }
      await ctx.permission.assert(targets.map(({ target, directory }) => ({
        target,
        boundary: ctx.sandbox.boundaryFor(target.full, directory ? "directory" : "file"),
      })));

      for (const { target } of targets) {
        const stats = input.noDereference === true
          ? await ctx.sandbox.lstat(target.full, target.requested)
          : await ctx.sandbox.stat(target.full, target.requested);
        if (input.noDereference === true && stats.isSymbolicLink()) {
          throw new FsError(`"${target.requested}" is a symlink; -h is not supported on this platform.`, "unsupported");
        }
        const nextMode = referenceMode ?? parseMode(input.mode as string, num(stats.mode) & 0o7777, stats.isDirectory());
        if (input.changes === true && (num(stats.mode) & 0o7777) === nextMode) continue;
        try {
          await fs.chmod(target.full, nextMode);
        } catch (error) {
          /* v8 ignore next 3 */
          if (input.silent === true) continue;
          /* v8 ignore next */
          throw fromErrno(error);
        }
        changed.push(target.requested);
      }
    }
    return textResult(
      input.verbose === true || input.changes === true
        ? changed.map((item) => `mode of '${item}' changed`).join("\n")
        : "",
      { changed },
    );
  },
};
