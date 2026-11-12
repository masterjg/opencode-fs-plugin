/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { inputStream, lines } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to read. Omit to read stdin." })),
    count: Type.Optional(Type.Boolean({ description: "Prefix each line with its count (`-c`)." })),
    repeated: Type.Optional(Type.Boolean({ description: "Only print repeated lines (`-d`)." })),
    uniqueOnly: Type.Optional(Type.Boolean({ description: "Only print unique lines (`-u`)." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Fold case (`-i`)." })),
    skipFields: Type.Optional(Type.Integer({ minimum: 0, description: "Skip fields when comparing (`-f`)." })),
    skipChars: Type.Optional(Type.Integer({ minimum: 0, description: "Skip characters when comparing (`-s`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const uniqTool: ToolSpec<Input> = {
  name: "uniq",
  description:
    "Filter adjacent duplicate lines with Linux `uniq` semantics (`-c`, `-d`, `-u`, `-i`, `-f`, `-s`).",
  schema: Schema,
  pipeable: "filter",
  mutates: false,
  async run(ctx, input, io) {
    const paths = input.paths ?? [];
    const targets = [];
    for (const requested of paths) {
      const target = await ctx.sandbox.resolveFollow(requested);
      targets.push({ requested, full: target.full, target });
    }
    if (targets.length > 0) {
      await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));
    }

    const output: string[] = [];
    let previous: string | undefined;
    let count = 0;
    let first = "";
    const flush = () => {
      if (previous === undefined) return;
      if (input.repeated === true && count < 2) return;
      if (input.uniqueOnly === true && count > 1) return;
      output.push(`${input.count === true ? `${String(count).padStart(7)} ` : ""}${first}`);
    };
    for await (const line of lines(inputStream(targets.map((target) => target.full), io.stdin))) {
      const comparable = compareKey(line.text, input);
      if (comparable === previous) {
        count++;
      } else {
        flush();
        previous = comparable;
        count = 1;
        first = line.text;
      }
    }
    flush();
    return textResult(output.map((line) => `${line}\n`).join(""), { lines: output.length });
  },
};

function compareKey(value: string, input: Input): string {
  let text = value;
  if (input.skipFields !== undefined && input.skipFields > 0) {
    text = text.split(/\s+/).slice(input.skipFields).join(" ");
  }
  if (input.skipChars !== undefined && input.skipChars > 0) text = text.slice(input.skipChars);
  return input.ignoreCase === true ? text.toLowerCase() : text;
}
