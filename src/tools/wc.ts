/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream, readFiles } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to count. Omit to read stdin." })),
    lines: Type.Optional(Type.Boolean({ description: "Count lines (`-l`)." })),
    words: Type.Optional(Type.Boolean({ description: "Count words (`-w`)." })),
    bytes: Type.Optional(Type.Boolean({ description: "Count bytes (`-c`)." })),
    chars: Type.Optional(Type.Boolean({ description: "Count characters (`-m`)." })),
    maxLineLength: Type.Optional(Type.Boolean({ description: "Print the longest line length (`-L`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface Counts {
  lines: number;
  words: number;
  bytes: number;
  chars: number;
  maxLine: number;
}

export const wcTool: ToolSpec<Input> = {
  name: "wc",
  description:
    "Count lines, words, bytes, characters or maximum line length with Linux `wc` semantics " +
    "(`-l`, `-w`, `-c`, `-m`, `-L`).",
  schema: Schema,
  pipeable: "sink",
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

    const results: Array<{ name: string; counts: Counts }> = [];
    if (targets.length === 0) {
      results.push({ name: "", counts: count(await collect(await inputStream([], io.stdin))) });
    } else {
      for (const target of targets) {
        results.push({ name: target.requested, counts: count(await collect(readFiles([target.full]))) });
      }
    }

    const total = results.reduce(
      (sum, result) => ({
        lines: sum.lines + result.counts.lines,
        words: sum.words + result.counts.words,
        bytes: sum.bytes + result.counts.bytes,
        chars: sum.chars + result.counts.chars,
        maxLine: Math.max(sum.maxLine, result.counts.maxLine),
      }),
      { lines: 0, words: 0, bytes: 0, chars: 0, maxLine: 0 },
    );
    if (results.length > 1) results.push({ name: "total", counts: total });

    const any = input.lines || input.words || input.bytes || input.chars || input.maxLineLength;
    const rows = results.map((result) => format(result.counts, result.name, input, !any));
    /* v8 ignore next */
    return textResult(rows.join("\n") + (rows.length > 0 ? "\n" : ""), { total });
  },
};

function count(data: Buffer): Counts {
  const text = data.toString("utf8");
  /* v8 ignore next 2 */
  const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  /* v8 ignore next */
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  const maxLine = text.split("\n").reduce((max, line) => Math.max(max, Array.from(line).length), 0);
  return { lines, words, bytes: data.length, chars: Array.from(text).length, maxLine };
}

function format(counts: Counts, name: string, input: Input, defaults: boolean): string {
  const values: number[] = [];
  if (defaults || input.lines === true) values.push(counts.lines);
  if (defaults || input.words === true) values.push(counts.words);
  if (defaults || input.bytes === true) values.push(counts.bytes);
  if (input.chars === true) values.push(counts.chars);
  if (input.maxLineLength === true) values.push(counts.maxLine);
  return `${values.map((value) => String(value).padStart(7)).join(" ")}${name === "" ? "" : ` ${name}`}`;
}
