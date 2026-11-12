/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream, lines } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to wrap. Omit to read stdin." })),
    width: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10_000, description: "Maximum line width. Default: 80 (`-w`)." }),
    ),
    spaces: Type.Optional(Type.Boolean({ description: "Break at spaces when possible (`-s`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const foldTool: ToolSpec<Input> = {
  name: "fold",
  description: "Wrap input lines at a fixed width, optionally at spaces (`-w`, `-s`).",
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
    const width = input.width ?? 80;
    const output: string[] = [];
    for await (const line of lines({ async *[Symbol.asyncIterator]() { yield data; } })) {
      for (const chunk of wrap(line.text, width, input.spaces === true)) output.push(`${chunk}\n`);
    }
    return textResult(output.join(""), { lines: output.length });
  },
};

export function wrap(text: string, width: number, spaces: boolean): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = width;
    if (spaces) {
      const space = rest.lastIndexOf(" ", width);
      if (space > 0) cut = space + 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    if (spaces) rest = rest.replace(/^ +/, "");
  }
  chunks.push(rest);
  return chunks;
}
