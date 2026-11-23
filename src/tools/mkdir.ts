/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { directoryPaths } from "../core/aliases.js";
import { FsError, fromErrno, isMissing } from "../core/errors.js";
import { parseMode } from "../core/mode.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    path: Type.Optional(Type.String({ minLength: 1, description: "Directory path, relative to the project or absolute." })),
    paths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Alias for one or more `path` values; do not combine with `path`.",
      }),
    ),
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
    const directories = directoryPaths(input);
    const mode = input.mode === undefined ? undefined : parseMode(input.mode, 0o777, true);
    const summaries: string[] = [];
    let createdAny = false;
    for (const requested of directories) {
      const target = await ctx.sandbox.resolveForCreate(requested);
      await ctx.permission.assert([
        { target, boundary: target.full, resource: ctx.sandbox.resource(target.full) },
      ]);

      let exists = false;
      let isDirectory = false;
      try {
        isDirectory = (await fs.lstat(target.full)).isDirectory();
        exists = true;
      } catch (error) {
        /* v8 ignore next */
        if (!isMissing(error)) throw fromErrno(error, "access");
      }

      if (exists && isDirectory) {
        if (input.parents === true) {
          summaries.push(`Directory already exists (no-op): ${requested}\n`);
          continue;
        }
        throw new FsError(`Already exists: "${requested}"`, "exists");
      }
      if (exists) throw new FsError(`Already exists and is not a directory: "${requested}"`, "exists");

      try {
        await fs.mkdir(target.full, { recursive: input.parents === true, ...(mode === undefined ? {} : { mode }) });
      } catch (error) {
        throw fromErrno(error);
      }
      createdAny = true;
      if (input.verbose === true) summaries.push(`Directory created: ${requested}\n`);
    }

    return textResult(summaries.join(""), {
      created: createdAny,
      ...(directories.length === 1 ? { path: directories[0] } : {}),
      paths: directories,
      mode: mode ?? null,
    });
  },
};
