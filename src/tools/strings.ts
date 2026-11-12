/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { mapLimit } from "../core/parallel.js";
import { collect, inputStream } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to scan. Omit to read stdin." })),
    minLength: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 255, description: "Minimum printable run length. Default: 4." }),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const stringsTool: ToolSpec<Input> = {
  name: "strings",
  description:
    "Extract printable ASCII runs from binary files or stdin (`-n` minimum length).",
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
    const minLength = input.minLength ?? 4;

    if (targets.length === 0) {
      const data = await collect(inputStream([], io.stdin));
      return textResult(extract(data, minLength), { files: 0 });
    }

    const chunks = await mapLimit(targets, ctx.concurrency, async ({ full }) => {
      return extract(await collect(inputStream([full], undefined)), minLength);
    }, ctx.signal);
    return textResult(chunks.join(""), { files: targets.length });
  },
};

function extract(data: Buffer, minLength: number): string {
  const text = data.toString("latin1");
  const matches = text.match(new RegExp(`[\\x20-\\x7e]{${minLength},}`, "g")) ?? [];
  return matches.length === 0 ? "" : `${matches.join("\n")}\n`;
}
