/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as crypto from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to shuffle. Omit to read stdin." })),
    headCount: Type.Optional(Type.Integer({ minimum: 1, description: "Print only this many lines (`-n`)." })),
    zeroTerminated: Type.Optional(Type.Boolean({ description: "NUL-separated records (`-z`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const shufTool: ToolSpec<Input> = {
  name: "shuf",
  description: "Shuffle lines or NUL-separated records from files or stdin (`-n`, `-z`).",
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
    const delimiter = input.zeroTerminated === true ? "\0" : "\n";
    const rows = data.toString("utf8").split(delimiter);
    /* v8 ignore next */
    if (rows[rows.length - 1] === "") rows.pop();
    for (let index = rows.length - 1; index > 0; index--) {
      const swap = crypto.randomInt(index + 1);
      [rows[index], rows[swap]] = [rows[swap] as string, rows[index] as string];
    }
    const result = input.headCount === undefined ? rows : rows.slice(0, input.headCount);
    return textResult(result.length > 0 ? `${result.join(delimiter)}${delimiter}` : "", { lines: result.length });
  },
};
