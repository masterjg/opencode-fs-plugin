/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream, lines } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to read. Omit to read stdin." })),
    all: Type.Optional(Type.Boolean({ description: "Number blank lines too (`-ba`)." })),
    start: Type.Optional(Type.Integer({ minimum: 1, description: "First line number (`-v`). Default: 1." })),
    width: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Number width (`-w`). Default: 6." })),
    separator: Type.Optional(Type.String({ description: "Number separator (`-s`). Default: tab." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const nlTool: ToolSpec<Input> = {
  name: "nl",
  description: "Number lines of files or stdin (`-ba`, `-v`, `-w`, `-s`).",
  schema: Schema,
  pipeable: "source",
  mutates: false,
  async run(ctx, input, io) {
    const targets = [];
    for (const requested of input.paths ?? []) {
      const target = await ctx.sandbox.resolveFollow(requested);
      targets.push({ requested, full: target.full, target });
    }
    if (targets.length > 0) {
      await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));
    }
    const data = await collect(inputStream(targets.map((target) => target.full), io.stdin));
    const width = input.width ?? 6;
    const separator = input.separator ?? "\t";
    let number = (input.start ?? 1) - 1;
    const output: string[] = [];
    for await (const line of lines({ async *[Symbol.asyncIterator]() { yield data; } })) {
      const numbered = input.all === true || line.text.length > 0;
      if (numbered) number++;
      const prefix = numbered ? `${String(number).padStart(width)}${separator}` : " ".repeat(width + separator.length);
      output.push(prefix + line.text + (line.newline ? "\n" : ""));
    }
    return textResult(output.join(""), { lines: output.length });
  },
};
