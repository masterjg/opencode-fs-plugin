/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno, isMissing } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Empty directories to remove, like `rmdir DIR...`.",
    }),
    parents: Type.Optional(
      Type.Boolean({ description: "Remove now-empty parent directories like `rmdir -p`." }),
    ),
    ignoreNonEmpty: Type.Optional(
      Type.Boolean({ description: "Ignore non-empty directories like `--ignore-fail-on-non-empty`." }),
    ),
    verbose: Type.Optional(Type.Boolean({ description: "Report each removed directory like `rmdir -v`." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const rmdirTool: ToolSpec<Input> = {
  name: "rmdir",
  description:
    "Remove one or more empty directories with Linux `rmdir` semantics (`-p`, `-v`, " +
    "`--ignore-fail-on-non-empty`). Symlinks and non-empty directories are refused.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const removed: string[] = [];
    const warnings: string[] = [];

    for (const requested of input.paths) {
      const target = await ctx.sandbox.resolveExisting(requested);
      ctx.sandbox.assertSafeToDelete(target.full);
      await ctx.permission.assert([
        { target, boundary: target.full, resource: ctx.sandbox.resource(target.full) },
      ]);

      const stats = await ctx.sandbox.lstat(target.full, requested);
      if (stats.isSymbolicLink()) {
        throw new FsError(`"${requested}" is a symlink; use rm to remove the link.`, "not-directory");
      }
      if (!stats.isDirectory()) {
        throw new FsError(`"${requested}" is not a directory.`, "not-directory");
      }

      try {
        await fs.rmdir(target.full);
        removed.push(requested);
        if (input.verbose === true) warnings.push(`rmdir: removing directory, '${requested}'`);
      } catch (error) {
        if (isNonEmpty(error) && input.ignoreNonEmpty === true) {
          warnings.push(`rmdir: ignoring non-empty directory '${requested}'`);
          continue;
        }
        throw fromErrno(error);
      }

      if (input.parents === true) {
        await removeParents(ctx, target.full, removed, warnings, input.verbose === true);
      }
    }

    return textResult(
      [...warnings, ...(input.verbose === true ? removed.map((item) => `Directory removed: ${item}`) : [])].join(
        "\n",
      ),
      { removed },
    );
  },
};

async function removeParents(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  start: string,
  removed: string[],
  warnings: string[],
  verbose: boolean,
): Promise<void> {
  let current = path.dirname(start);
  while (ctx.sandbox.isWithin(current) && current !== ctx.sandbox.root) {
    const target = await ctx.sandbox.resolveExisting(current);
    await ctx.permission.assert([
      { target, boundary: target.full, resource: ctx.sandbox.resource(target.full) },
    ]);
    try {
      await fs.rmdir(current);
      const label = ctx.sandbox.resource(current);
      removed.push(label);
      if (verbose) warnings.push(`rmdir: removing directory, '${label}'`);
    } catch (error) {
      if (isMissing(error) || isNonEmpty(error)) return;
      throw fromErrno(error);
    }
    current = path.dirname(current);
  }
}

function isNonEmpty(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOTEMPTY" || code === "ENOTDIR" || code === "EEXIST";
}
