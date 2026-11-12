/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno, isMissing } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Files, symlinks or directories to remove, like `rm FILE...`.",
    }),
    recursive: Type.Optional(
      Type.Boolean({ description: "Remove directories and their contents recursively (`-r`, `-R`)." }),
    ),
    force: Type.Optional(Type.Boolean({ description: "Ignore missing files and never prompt (`-f`)." })),
    dir: Type.Optional(Type.Boolean({ description: "Remove empty directories like `rm -d`." })),
    verbose: Type.Optional(Type.Boolean({ description: "Report each removed path like `rm -v`." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const rmTool: ToolSpec<Input> = {
  name: "rm",
  description:
    "Remove files, symlinks or directories with Linux `rm` semantics (`-r`, `-f`, `-d`, `-v`). " +
    "Symlinks are removed as links; their targets are never touched. The project root is a hard stop.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const removed: string[] = [];
    const warnings: string[] = [];

    for (const requested of input.paths) {
      let target;
      try {
        target = await ctx.sandbox.resolveExisting(requested);
      } catch (error) {
        if (input.force === true && error instanceof FsError && error.code === "not-found") {
          continue;
        }
        throw error;
      }
      ctx.sandbox.assertSafeToDelete(target.full);

      const stats = await ctx.sandbox.lstat(target.full, requested);
      const boundary = stats.isDirectory() && !stats.isSymbolicLink() ? target.full : ctx.sandbox.boundaryFor(target.full, "file");
      await ctx.permission.assert([
        { target, boundary, resource: ctx.sandbox.resource(target.full) },
      ]);

      try {
        if (stats.isSymbolicLink()) {
          await fs.unlink(target.full);
        } else if (stats.isDirectory()) {
          if (input.recursive === true) {
            await fs.rm(target.full, { recursive: true, force: false });
          } else if (input.dir === true) {
            await fs.rmdir(target.full);
          } else {
            throw new FsError(
              `"${requested}" is a directory; use recursive: true or dir: true.`,
              "not-file",
            );
          }
        } else {
          await fs.unlink(target.full);
        }
      } catch (error) {
        if (input.force === true && isMissing(error)) continue;
        if (error instanceof FsError) throw error;
        throw fromErrno(error);
      }

      removed.push(requested);
      if (input.verbose === true) warnings.push(`removed '${requested}'`);
    }

    return textResult(warnings.join("\n"), { removed });
  },
};
