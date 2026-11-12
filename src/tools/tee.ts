/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { FsError } from "../core/errors.js";
import { collect, writeAll } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { description: "Files to write. Empty means pass through only." }),
    append: Type.Optional(Type.Boolean({ description: "Append instead of overwriting (`-a`)." })),
    content: Type.Optional(Type.String({ description: "Text to write when no stdin is available." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const teeTool: ToolSpec<Input> = {
  name: "tee",
  description:
    "Copy stdin to one or more files and stdout with Linux `tee` semantics (`-a`). " +
    "Use `content` when calling it outside a pipe.",
  schema: Schema,
  pipeable: "filter",
  mutates: true,
  async run(ctx, input, io) {
    if (input.paths.length === 0 && input.content === undefined && io.stdin === undefined) {
      throw new FsError("tee needs files, content, or stdin.", "invalid");
    }
    const data = input.content !== undefined
      ? Buffer.from(input.content, "utf8")
      : await collect(io.stdin as AsyncIterable<Buffer>);

    const targets = [];
    for (const requested of input.paths) {
      const target = await ctx.sandbox.resolveForCreate(requested);
      targets.push({ requested, target });
    }
    await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));
    for (const target of targets) {
      await writeAll(target.target.full, data, input.append === true);
    }
    return { stdout: data, exitCode: 0, metadata: { files: input.paths, append: input.append === true } };
  },
};

void textResult;
