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
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    mode: Type.Optional(
      Type.Union(
        [
          Type.Literal("raw"),
          Type.Literal("canonical"),
          Type.Literal("existing"),
          Type.Literal("missing"),
        ],
        { description: "raw, canonical (-f), existing (-e), or missing (-m). Default: raw." },
      ),
    ),
    noNewline: Type.Optional(Type.Boolean({ description: "Do not append a newline (`-n`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const readlinkTool: ToolSpec<Input> = {
  name: "readlink",
  description:
    "Print symbolic-link targets or canonical paths with Linux `readlink` semantics " +
    "(`-f`, `-e`, `-m`, `-n`).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const mode = input.mode ?? "raw";
    const results: string[] = [];
    for (const requested of input.paths) {
      const target = mode === "missing"
        ? await ctx.sandbox.resolveForCreate(requested)
        : await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      await ctx.permission.assert([{ target, boundary: target.full }]);
      results.push(await resolveLink(ctx, requested, target.full, mode));
    }
    const text = results.join(input.noNewline === true ? "" : "\n");
    return textResult(input.noNewline === true ? text : `${text}\n`, { paths: input.paths, mode });
  },
};

async function resolveLink(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  requested: string,
  full: string,
  mode: string,
): Promise<string> {
  if (mode === "raw") {
    try {
      return await fs.readlink(full);
    } catch (error) {
      /* v8 ignore next */
      if ((error as NodeJS.ErrnoException)?.code === "EINVAL") {
        throw new FsError(`"${requested}" is not a symbolic link.`, "not-file");
      }
      /* v8 ignore next */
      throw fromErrno(error);
    }
  }
  if (mode === "existing") {
    try {
      return await fs.realpath(full);
    } catch (error) {
      /* v8 ignore next */
      if (isMissing(error)) throw new FsError(`Not found: "${requested}"`, "not-found");
      /* v8 ignore next */
      throw fromErrno(error, "access");
    }
  }
  if (mode === "canonical") {
    const parent = await ctx.sandbox.resolveParent(requested);
    return path.join(parent.full, path.basename(full));
  }
  const target = await ctx.sandbox.resolveForCreate(requested);
  return target.full;
}
