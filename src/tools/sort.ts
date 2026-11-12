/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream, lines } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to sort. Omit to read stdin." })),
    numeric: Type.Optional(Type.Boolean({ description: "Compare numerically (`-n`)." })),
    reverse: Type.Optional(Type.Boolean({ description: "Reverse the result (`-r`)." })),
    unique: Type.Optional(Type.Boolean({ description: "Remove duplicate lines (`-u`)." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Fold case (`-f`)." })),
    ignoreLeadingBlanks: Type.Optional(Type.Boolean({ description: "Ignore leading blanks (`-b`)." })),
    field: Type.Optional(Type.Integer({ minimum: 1, description: "Sort by this 1-based field (`-k`)." })),
    separator: Type.Optional(Type.String({ description: "Field separator (`-t`). Default: whitespace." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const sortTool: ToolSpec<Input> = {
  name: "sort",
  description:
    "Sort lines with common Linux `sort` semantics (`-n`, `-r`, `-u`, `-f`, `-b`, `-k`, `-t`).",
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
    const stream = inputStream(targets.map((target) => target.full), io.stdin);
    const rows: string[] = [];
    for await (const line of lines(stream)) rows.push(line.text);
    rows.sort((a, b) => compare(a, b, input));
    const result = input.unique === true ? [...new Set(rows)] : rows;
    return textResult(result.map((line) => `${line}\n`).join(""), { lines: result.length });
  },
};

function compare(a: string, b: string, input: Input): number {
  const left = key(a, input);
  const right = key(b, input);
  let result: number;
  if (input.numeric === true) {
    result = Number.parseFloat(left) - Number.parseFloat(right);
    if (Number.isNaN(result)) result = left.localeCompare(right);
  } else {
    result = input.ignoreCase === true ? left.toLowerCase().localeCompare(right.toLowerCase()) : left.localeCompare(right);
  }
  return input.reverse === true ? -result : result;
}

function key(value: string, input: Input): string {
  let text = input.ignoreLeadingBlanks === true ? value.trimStart() : value;
  if (input.field !== undefined) {
    const fields = input.separator === undefined ? text.split(/\s+/) : text.split(input.separator);
    /* v8 ignore next */
    text = fields[input.field - 1] ?? "";
  }
  return text;
}
