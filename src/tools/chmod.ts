/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { num, walk } from "../core/fsutil.js";
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
    const referenceMode =
      input.reference === undefined
        ? undefined
        : num((await ctx.sandbox.lstat((await ctx.sandbox.resolveExisting(input.reference, { allowRoot: true })).full, input.reference)).mode) & 0o7777;

    const changed: string[] = [];
    for (const requested of input.paths) {
      const root = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      ctx.sandbox.assertSafeToDelete(root.full);
      const targets = [root];
      if (input.recursive === true) {
        const rootStats = await ctx.sandbox.lstat(root.full, requested);
        if (rootStats.isDirectory()) {
          for await (const entry of walk(root.full, { recursive: true, signal: ctx.signal })) {
            targets.push({
              full: entry.path,
              outside: root.outside,
              requested: entry.path,
              realAncestor: root.realAncestor,
            });
          }
        }
      }
      await ctx.permission.assert(targets.map((target) => ({ target, boundary: target.full })));

      for (const target of targets) {
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
          if (input.silent === true) continue;
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
