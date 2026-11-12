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
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const tacTool: ToolSpec<Input> = {
  name: "tac",
  description: "Print files or stdin with the line order reversed.",
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
    const rows: string[] = [];
    for await (const line of lines({ async *[Symbol.asyncIterator]() { yield data; } })) rows.push(line.text);
    rows.reverse();
    return textResult(rows.length > 0 ? `${rows.join("\n")}\n` : "", { lines: rows.length });
  },
};
