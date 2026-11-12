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
    sources: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    destination: Type.String({ minLength: 1, description: "Link path, or an existing directory for multiple sources." }),
    symbolic: Type.Optional(Type.Boolean({ description: "Create symbolic links (`-s`)." })),
    force: Type.Optional(Type.Boolean({ description: "Replace existing destinations (`-f`)." })),
    noDereference: Type.Optional(Type.Boolean({ description: "Hard-link a symlink itself (`-P`)." })),
    relative: Type.Optional(Type.Boolean({ description: "Create relative symbolic links (`-r`)." })),
    verbose: Type.Optional(Type.Boolean({ description: "Report created links (`-v`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const lnTool: ToolSpec<Input> = {
  name: "ln",
  description:
    "Create hard or symbolic links with Linux `ln` semantics (`-s`, `-f`, `-P`, `-r`, `-v`). " +
    "Symbolic targets may be dangling; hard-link sources must exist.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const destTarget = await ctx.sandbox.resolveForCreate(input.destination);
    let destIsDirectory = false;
    try {
      destIsDirectory = (await fs.lstat(destTarget.full)).isDirectory();
    } catch (error) {
      if (!isMissing(error)) throw fromErrno(error, "access");
    }
    if (input.sources.length > 1 && !destIsDirectory) {
      throw new FsError("Multiple sources require an existing directory destination.", "not-directory");
    }

    const created: string[] = [];
    for (const requested of input.sources) {
      const link = destIsDirectory || input.sources.length > 1
        ? path.join(destTarget.full, path.basename(path.resolve(requested)))
        : destTarget.full;
      const linkTarget = await ctx.sandbox.resolveForCreate(link);
      const entries = [{ target: linkTarget, boundary: path.dirname(linkTarget.full) }];

      let sourceFull: string | undefined;
      let targetText = requested;
      if (input.symbolic === true) {
        if (input.relative === true) {
          const sourceAbs = path.resolve(ctx.sandbox.root, requested);
          targetText = path.relative(path.dirname(linkTarget.full), sourceAbs);
        }
      } else {
        const source = input.noDereference === true
          ? await ctx.sandbox.resolveExisting(requested)
          : await ctx.sandbox.resolveFollow(requested);
        sourceFull = source.full;
        targetText = source.full;
        entries.push({ target: source, boundary: path.dirname(source.full) });
      }
      await ctx.permission.assert(entries);

      if (input.force === true) {
        try {
          await fs.unlink(linkTarget.full);
        } catch (error) {
          if (!isMissing(error)) throw fromErrno(error);
        }
      }
      try {
        if (input.symbolic === true) {
          await fs.symlink(targetText, linkTarget.full);
        } else {
          await fs.link(sourceFull as string, linkTarget.full);
        }
      } catch (error) {
        throw fromErrno(error);
      }
      created.push(link);
    }

    return textResult(
      input.verbose === true ? created.map((item) => `'${item}' created`).join("\n") : "",
      { created },
    );
  },
};
