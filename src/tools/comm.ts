/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { fromErrno } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    left: Type.String({ minLength: 1, description: "First sorted file." }),
    right: Type.String({ minLength: 1, description: "Second sorted file." }),
    suppress1: Type.Optional(Type.Boolean({ description: "Suppress column 1 (`-1`)." })),
    suppress2: Type.Optional(Type.Boolean({ description: "Suppress column 2 (`-2`)." })),
    suppress3: Type.Optional(Type.Boolean({ description: "Suppress column 3 (`-3`)." })),
    outputDelimiter: Type.Optional(Type.String({ description: "Column separator. Default: tab." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const commTool: ToolSpec<Input> = {
  name: "comm",
  description: "Compare two sorted files column by column (`-1`, `-2`, `-3`, `--output-delimiter`).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const left = await resolve(ctx, input.left);
    const right = await resolve(ctx, input.right);
    let leftRows: string[];
    let rightRows: string[];
    try {
      [leftRows, rightRows] = await Promise.all([
        fs.readFile(left, "utf8").then((text) => splitLines(text)),
        fs.readFile(right, "utf8").then((text) => splitLines(text)),
      ]);
    } catch (error) {
      throw fromErrno(error);
    }

    const delimiter = input.outputDelimiter ?? "\t";
    const output: string[] = [];
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < leftRows.length || rightIndex < rightRows.length) {
      const leftValue = leftRows[leftIndex];
      const rightValue = rightRows[rightIndex];
      if (leftValue !== undefined && (rightValue === undefined || leftValue < rightValue)) {
        if (input.suppress1 !== true) output.push(leftValue);
        leftIndex++;
      } else if (rightValue !== undefined && (leftValue === undefined || rightValue < leftValue)) {
        if (input.suppress2 !== true) output.push(`${input.suppress1 === true ? "" : delimiter}${rightValue}`);
        rightIndex++;
      } else {
        if (input.suppress3 !== true) {
          const prefix = `${input.suppress1 === true ? "" : delimiter}${input.suppress2 === true ? "" : delimiter}`;
          output.push(`${prefix}${leftValue}`);
        }
        leftIndex++;
        rightIndex++;
      }
    }
    return textResult(output.length > 0 ? `${output.join("\n")}\n` : "", { lines: output.length });
  },
};

async function resolve(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  requested: string,
): Promise<string> {
  const target = await ctx.sandbox.resolveFollow(requested);
  await ctx.permission.assert([{ target, boundary: target.full }]);
  return target.full;
}

function splitLines(text: string): string[] {
  const rows = text.split("\n");
  /* v8 ignore next */
  if (rows[rows.length - 1] === "") rows.pop();
  return rows;
}
