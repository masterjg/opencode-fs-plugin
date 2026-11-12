/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream, lines, readFiles } from "../core/stream.js";
import { FsError } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to read. Omit to read stdin." })),
    lines: Type.Optional(Type.Integer({ minimum: 1, description: "Number of lines. Default: 10 (`-n`)." })),
    bytes: Type.Optional(Type.Integer({ minimum: 1, description: "Number of bytes (`-c`)." })),
    quiet: Type.Optional(Type.Boolean({ description: "Never print file headers (`-q`)." })),
    verbose: Type.Optional(Type.Boolean({ description: "Always print file headers (`-v`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const headTool: ToolSpec<Input> = {
  name: "head",
  description: "Output the first part of files or stdin with Linux `head` semantics (`-n`, `-c`, `-q`, `-v`).",
  schema: Schema,
  pipeable: "filter",
  mutates: false,
  async run(ctx, input, io) {
    if (input.lines !== undefined && input.bytes !== undefined) {
      throw new FsError("head accepts either lines or bytes, not both.", "invalid");
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
      const data = input.bytes !== undefined
        ? await collect(await inputStream([], io.stdin), input.bytes)
        : await takeLines(inputStream([], io.stdin), count);
      output.push(data);
    } else {
      for (const target of targets) {
        if (input.quiet !== true && (targets.length > 1 || input.verbose === true)) {
          output.push(Buffer.from(`==> ${target.requested} <==\n`));
        }
        output.push(
          input.bytes !== undefined
            ? await collect(readFiles([target.full]), input.bytes)
            : await takeLines(readFiles([target.full]), count),
        );
      }
    }
    return textResult(Buffer.concat(output).toString("utf8"), { paths });
  },
};

async function takeLines(stream: AsyncIterable<Buffer>, count: number): Promise<Buffer> {
  const output: string[] = [];
  let taken = 0;
  for await (const line of lines(stream)) {
    output.push(line.text + (line.newline ? "\n" : ""));
    taken++;
    if (taken >= count) break;
  }
  return Buffer.from(output.join(""), "utf8");
}
