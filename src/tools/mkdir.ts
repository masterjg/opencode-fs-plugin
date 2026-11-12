/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno, isMissing } from "../core/errors.js";
import { parseMode } from "../core/mode.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    path: Type.String({ minLength: 1, description: "Directory path, relative to the project or absolute." }),
    parents: Type.Optional(
      Type.Boolean({ description: "Create missing parents like `mkdir -p`. Default: false." }),
    ),
    mode: Type.Optional(Type.String({ description: "Permission mode, like `755` or `u=rwx,go=rx`." })),
    verbose: Type.Optional(Type.Boolean({ description: "Report the created directory like `mkdir -v`." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const mkdirTool: ToolSpec<Input> = {
  name: "mkdir",
  description:
    "Create a directory with Linux `mkdir` semantics (`-p`, `-m`, `-v`). " +
    "Targets outside the project, including through symlinks, require external_directory approval.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const target = await ctx.sandbox.resolveForCreate(input.path);
    await ctx.permission.assert([
      { target, boundary: target.full, resource: ctx.sandbox.resource(target.full) },
    ]);

    let exists = false;
    let isDirectory = false;
    try {
      isDirectory = (await fs.lstat(target.full)).isDirectory();
      exists = true;
    } catch (error) {
      if (!isMissing(error)) throw fromErrno(error, "access");
    }

    if (exists && isDirectory) {
      if (input.parents === true) {
        return textResult(`Directory already exists (no-op): ${input.path}`, {
          created: false,
        });
      }
      throw new FsError(`Already exists: "${input.path}"`, "exists");
    }
    if (exists) throw new FsError(`Already exists and is not a directory: "${input.path}"`, "exists");

    const mode = input.mode === undefined ? undefined : parseMode(input.mode, 0o777, true);
    try {
      await fs.mkdir(target.full, { recursive: input.parents === true, ...(mode === undefined ? {} : { mode }) });
    } catch (error) {
      throw fromErrno(error);
    }

    const summary = input.verbose === true ? `Directory created: ${input.path}\n` : "";
    return textResult(summary, { created: true, path: input.path, mode: mode ?? null });
  },
};
