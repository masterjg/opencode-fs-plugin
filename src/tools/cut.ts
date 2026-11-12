/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { FsError } from "../core/errors.js";
import { inputStream, lines } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to read. Omit to read stdin." })),
    fields: Type.Optional(Type.String({ description: "Field list, e.g. 1,3-5 (`-f`)." })),
    characters: Type.Optional(Type.String({ description: "Character list (`-c`)." })),
    bytes: Type.Optional(Type.String({ description: "Byte list (`-b`)." })),
    delimiter: Type.Optional(Type.String({ description: "Input field delimiter (`-d`). Default: tab." })),
    outputDelimiter: Type.Optional(Type.String({ description: "Output field delimiter (`--output-delimiter`)." })),
    complement: Type.Optional(Type.Boolean({ description: "Select the complement (`--complement`)." })),
    onlyDelimited: Type.Optional(Type.Boolean({ description: "Print lines without the delimiter unchanged (`-s`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const cutTool: ToolSpec<Input> = {
  name: "cut",
  description:
    "Select fields, characters or bytes with Linux `cut` semantics (`-f`, `-c`, `-b`, `-d`, " +
    "`--complement`, `--output-delimiter`, `-s`).",
  schema: Schema,
  pipeable: "filter",
  mutates: false,
  async run(ctx, input, io) {
    const mode = input.fields !== undefined ? "fields" : input.characters !== undefined ? "chars" : input.bytes !== undefined ? "bytes" : "";
    if (!mode) throw new FsError("cut requires fields, characters, or bytes.", "invalid");
    const ranges = parseRanges(input.fields ?? input.characters ?? input.bytes ?? "");
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
    for await (const line of lines(inputStream(targets.map((target) => target.full), io.stdin))) {
      if (mode === "fields") {
        const delimiter = input.delimiter ?? "\t";
        if (input.onlyDelimited === true && !line.text.includes(delimiter)) {
          output.push(line.text);
          continue;
        }
        const fields = line.text.split(delimiter);
        const selected = select(fields, ranges, input.complement === true);
        output.push(selected.join(input.outputDelimiter ?? delimiter));
      } else {
        const units = mode === "chars" ? Array.from(line.text) : [...Buffer.from(line.text, "utf8")].map((byte) => String.fromCharCode(byte));
        output.push(select(units, ranges, input.complement === true).join(""));
      }
    }
    return textResult(output.map((line) => `${line}\n`).join(""), { lines: output.length });
  },
};

export function parseRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const part of value.split(",")) {
    if (part.length === 0) continue;
    const match = /^(\d+)(?:-(\d*))?$/.exec(part);
    if (!match) throw new FsError(`Invalid field list: ${value}`, "invalid");
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : match[2] === "" ? Number.POSITIVE_INFINITY : Number(match[2]);
    if (start < 1 || end < start) throw new FsError(`Invalid field range: ${part}`, "invalid");
    ranges.push({ start, end });
  }
  if (ranges.length === 0) throw new FsError(`Invalid field list: ${value}`, "invalid");
  return ranges;
}

function select<T>(items: T[], ranges: Array<{ start: number; end: number }>, complement: boolean): T[] {
  const output: T[] = [];
  for (let index = 0; index < items.length; index++) {
    const position = index + 1;
    const selected = ranges.some((range) => position >= range.start && position <= range.end);
    if (selected !== complement) output.push(items[index] as T);
  }
  return output;
}
