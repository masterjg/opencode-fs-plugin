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
    set1: Type.String({ description: "Source character set." }),
    set2: Type.Optional(Type.String({ description: "Replacement character set." })),
    delete: Type.Optional(Type.Boolean({ description: "Delete characters in set1 (`-d`)." })),
    squeeze: Type.Optional(Type.Boolean({ description: "Squeeze repeated characters (`-s`)." })),
    complement: Type.Optional(Type.Boolean({ description: "Use the complement of set1 (`-c`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const trTool: ToolSpec<Input> = {
  name: "tr",
  description:
    "Translate or delete characters with Linux `tr` semantics (`-d`, `-s`, `-c`) and simple ranges/classes.",
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

    const source = input.complement === true ? complement(expandSet(input.set1)) : expandSet(input.set1);
    const replacement = input.set2 === undefined ? [] : expandSet(input.set2);
    const output: string[] = [];
    for await (const line of lines(inputStream(targets.map((target) => target.full), io.stdin))) {
      let text = "";
      let previous = "";
      for (const char of Array.from(line.text)) {
        if (input.delete === true) {
          if (source.includes(char)) continue;
          text += char;
        } else {
          const index = source.indexOf(char);
          const mapped = index >= 0 && replacement.length > 0 ? replacement[Math.min(index, replacement.length - 1)] as string : char;
          if (input.squeeze === true && mapped === previous && source.includes(char)) continue;
          text += mapped;
          previous = mapped;
        }
      }
      output.push(text);
    }
    return textResult(output.map((line) => `${line}\n`).join(""), { lines: output.length });
  },
};

export function expandSet(value: string): string[] {
  const output: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const char = value[index] as string;
    if (char === "\\") {
      const next = value[++index];
      if (next === undefined) throw new FsError("trailing escape in set.", "invalid");
      output.push(next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next);
      continue;
    }
    if (char === "[" && value[index + 1] === ":") {
      const end = value.indexOf(":]", index + 2);
      if (end < 0) throw new FsError("unterminated character class.", "invalid");
      output.push(...characterClass(value.slice(index + 2, end)));
      index = end + 1;
      continue;
    }
    if (value[index + 1] === "-" && value[index + 2] !== undefined) {
      const start = char.codePointAt(0) as number;
      const end = value.codePointAt(index + 2) as number;
      if (end < start) throw new FsError("invalid set range.", "invalid");
      for (let code = start; code <= end; code++) output.push(String.fromCodePoint(code));
      index += 2;
      continue;
    }
    output.push(char);
  }
  return output;
}

function characterClass(name: string): string[] {
  const ranges: Record<string, [number, number]> = {
    alpha: [65, 122],
    digit: [48, 57],
    upper: [65, 90],
    lower: [97, 122],
    space: [9, 32],
  };
  const range = ranges[name];
  if (range === undefined) throw new FsError(`Unknown character class: ${name}`, "invalid");
  const output: string[] = [];
  for (let code = range[0]; code <= range[1]; code++) {
    if (name === "alpha" && code > 90 && code < 97) continue;
    output.push(String.fromCharCode(code));
  }
  return output;
}

function complement(set: string[]): string[] {
  const output: string[] = [];
  for (let code = 0; code < 256; code++) {
    const char = String.fromCharCode(code);
    if (!set.includes(char)) output.push(char);
  }
  return output;
}
