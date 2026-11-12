/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream, readFiles } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";
import { FsError } from "../core/errors.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to read. Omit to read stdin." })),
    lines: Type.Optional(Type.Integer({ minimum: 1, description: "Number of lines. Default: 10 (`-n`)." })),
    bytes: Type.Optional(Type.Integer({ minimum: 1, description: "Number of bytes from the end (`-c`)." })),
    fromStart: Type.Optional(Type.Boolean({ description: "Treat lines as a 1-based starting line (`-n +N`)." })),
    quiet: Type.Optional(Type.Boolean({ description: "Never print file headers (`-q`)." })),
    verbose: Type.Optional(Type.Boolean({ description: "Always print file headers (`-v`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const tailTool: ToolSpec<Input> = {
  name: "tail",
  description:
    "Output the last part of files or stdin with Linux `tail` semantics (`-n`, `-n +N`, `-c`, `-q`, `-v`). " +
    "Follow mode (`-f`) is not supported.",
  schema: Schema,
  pipeable: "filter",
  mutates: false,
  async run(ctx, input, io) {
    if (input.lines !== undefined && input.bytes !== undefined) {
      throw new FsError("tail accepts either lines or bytes, not both.", "invalid");
    }
    const count = input.bytes ?? input.lines ?? 10;
    const paths = input.paths ?? [];
    const targets = [];
    for (const requested of paths) {
      const target = await ctx.sandbox.resolveFollow(requested);
      targets.push({ requested, full: target.full, target });
    }
    if (targets.length > 0) {
      await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));
    }

    const output: Buffer[] = [];
    if (targets.length === 0) {
      const data = await collect(await inputStream([], io.stdin));
      output.push(tailBuffer(data, count, input));
    } else {
      for (const target of targets) {
        if (input.quiet !== true && (targets.length > 1 || input.verbose === true)) {
          output.push(Buffer.from(`==> ${target.requested} <==\n`));
        }
        const data = await collect(readFiles([target.full]));
        output.push(tailBuffer(data, count, input));
      }
    }
    return textResult(Buffer.concat(output).toString("utf8"), { paths });
  },
};

function tailBuffer(data: Buffer, count: number, input: Input): Buffer {
  if (input.bytes !== undefined) return data.subarray(Math.max(0, data.length - count));
  const text = data.toString("utf8");
  const trailing = text.endsWith("\n");
  const parts = text.split("\n");
  if (trailing) parts.pop();
  if (input.fromStart === true) return Buffer.from(parts.slice(count - 1).join("\n") + (trailing ? "\n" : ""), "utf8");
  return Buffer.from(parts.slice(Math.max(0, parts.length - count)).join("\n") + (trailing ? "\n" : ""), "utf8");
}
