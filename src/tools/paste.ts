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
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Input files. Omit to read stdin." })),
    delimiters: Type.Optional(Type.String({ description: "Delimiter cycle. Default: tab." })),
    serial: Type.Optional(Type.Boolean({ description: "Paste one file at a time (`-s`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const pasteTool: ToolSpec<Input> = {
  name: "paste",
  description: "Merge input files line by line with a delimiter cycle (`-d`, `-s`).",
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
    const sources = targets.length > 0
      ? targets.map((target) => target.full)
      : undefined;
    const tables = sources === undefined
      ? [splitLines(await collect(inputStream([], io.stdin)))]
      : await mapLimit(sources, ctx.concurrency, async (full) => splitLines(await collect(inputStream([full], undefined))), ctx.signal);

    const delimiters = input.delimiters === undefined || input.delimiters.length === 0 ? "\t" : input.delimiters;
    const rows: string[] = [];
    if (input.serial === true) {
      for (const table of tables) {
        if (table.length === 0) continue;
        rows.push(
          table
            .map((line, index) => line + (index === table.length - 1 ? "" : delimiterAt(delimiters, index)))
            .join(""),
        );
      }
    } else {
      const height = Math.max(0, ...tables.map((table) => table.length));
      for (let index = 0; index < height; index++) {
        const fields: string[] = [];
        for (let column = 0; column < tables.length; column++) {
          fields.push((tables[column] as string[])[index] ?? "");
        }
        rows.push(fields.map((field, column) => `${field}${column === fields.length - 1 ? "" : delimiterAt(delimiters, column)}`).join(""));
      }
    }
    return textResult(rows.length > 0 ? `${rows.join("\n")}\n` : "", { rows: rows.length });
  },
};

function splitLines(data: Buffer): string[] {
  const rows = data.toString("utf8").split("\n");
  /* v8 ignore next */
  if (rows[rows.length - 1] === "") rows.pop();
  return rows;
}

function delimiterAt(delimiters: string, index: number): string {
  return delimiters[index % delimiters.length] as string;
}
