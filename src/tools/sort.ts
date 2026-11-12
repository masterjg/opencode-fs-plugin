/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { FsError } from "../core/errors.js";
import { inputStream } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to sort. Omit to read stdin." })),
    numeric: Type.Optional(Type.Boolean({ description: "Compare numerically (`-n`)." })),
    generalNumeric: Type.Optional(Type.Boolean({ description: "Compare general numeric values, including exponents (`-g`)." })),
    humanNumeric: Type.Optional(Type.Boolean({ description: "Compare human-readable sizes such as 1K, 2M (`-h`)." })),
    version: Type.Optional(Type.Boolean({ description: "Natural version sort (`-V`)." })),
    reverse: Type.Optional(Type.Boolean({ description: "Reverse the result (`-r`)." })),
    unique: Type.Optional(Type.Boolean({ description: "Remove duplicate lines (`-u`)." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Fold case (`-f`)." })),
    dictionary: Type.Optional(Type.Boolean({ description: "Consider only blanks and alphanumerics (`-d`)." })),
    ignoreNonPrinting: Type.Optional(Type.Boolean({ description: "Ignore non-printing characters (`-i`)." })),
    ignoreLeadingBlanks: Type.Optional(Type.Boolean({ description: "Ignore leading blanks (`-b`)." })),
    stable: Type.Optional(Type.Boolean({ description: "Disable the last-resort whole-line comparison (`-s`)." })),
    check: Type.Optional(Type.Boolean({ description: "Check whether input is sorted (`-c`)." })),
    checkQuiet: Type.Optional(Type.Boolean({ description: "Check sortedness without output (`-C`)." })),
    zeroTerminated: Type.Optional(Type.Boolean({ description: "NUL-separated records (`-z`)." })),
    keys: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Sort keys in GNU -k syntax, e.g. 2,2n or 1,1 2.2,2.4.",
      }),
    ),
    field: Type.Optional(Type.Integer({ minimum: 1, description: "Sort by this 1-based field (`-k`)." })),
    separator: Type.Optional(Type.String({ description: "Field separator (`-t`). Default: whitespace." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const sortTool: ToolSpec<Input> = {
  name: "sort",
  description:
    "Sort records with Linux `sort` semantics (`-n`, `-g`, `-h`, `-V`, `-r`, `-u`, `-f`, " +
    "`-d`, `-i`, `-b`, `-s`, `-c`, `-C`, `-z`, `-k` key ranges, `-t`).",
  schema: Schema,
  pipeable: "filter",
  mutates: false,
  async run(ctx, input, io) {
    const keys = input.keys === undefined ? undefined : input.keys.map(parseKey);
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
    const separator = input.zeroTerminated === true ? "\0" : "\n";
    const rows: string[] = [];
    for await (const record of records(stream, separator)) rows.push(record);

    if (input.check === true || input.checkQuiet === true) {
      for (let index = 1; index < rows.length; index++) {
        if (compare(rows[index - 1] as string, rows[index] as string, input, keys) > 0) {
          return textResult(
            input.checkQuiet === true ? "" : `sort: disorder at line ${index + 1}\n`,
            { checked: false, line: index + 1 },
            1,
          );
        }
      }
      return textResult("", { checked: true });
    }

    rows.sort((a, b) => compare(a, b, input, keys));
    const result = input.unique === true ? [...new Set(rows)] : rows;
    return textResult(
      result.map((record) => `${record}${separator}`).join(""),
      { lines: result.length },
    );
  },
};

async function* records(
  stream: AsyncIterable<Buffer>,
  separator: string,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf(separator);
      if (index < 0) break;
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + separator.length);
    }
  }
  if (buffer.length > 0) yield buffer;
}

interface KeySpec {
  startField: number;
  startChar?: number;
  endField?: number;
  endChar?: number;
  modifiers: Set<string>;
}

function parseKey(value: string): KeySpec {
  const match = /^(\d+)(?:\.(\d+))?(?:,(\d+)(?:\.(\d+))?)?([bdfghiMnrV]*)$/.exec(value);
  if (match === null) throw new FsError(`invalid sort key: ${value}`, "invalid");
  return {
    startField: Number(match[1]),
    ...(match[2] === undefined ? {} : { startChar: Number(match[2]) }),
    ...(match[3] === undefined ? {} : { endField: Number(match[3]) }),
    ...(match[4] === undefined ? {} : { endChar: Number(match[4]) }),
    modifiers: new Set((match[5] as string).split("")),
  };
}

function compare(a: string, b: string, input: Input, keys?: KeySpec[]): number {
  if (keys !== undefined && keys.length > 0) {
    for (const spec of keys) {
      const result = compareKey(a, b, spec, input);
      if (result !== 0) return result;
    }
  } else {
    const result = compareValue(key(a, input), key(b, input), input);
    if (result !== 0) return input.reverse === true ? -result : result;
  }

  if (input.stable !== true) {
    const result = a.localeCompare(b);
    return result === 0 ? 0 : input.reverse === true ? -result : result;
  }
  return 0;
}

function compareKey(a: string, b: string, spec: KeySpec, input: Input): number {
  const left = keyText(a, spec, input);
  const right = keyText(b, spec, input);
  const result = compareValue(left, right, input, spec);
  if (result === 0) return 0;
  const reverse = spec.modifiers.has("r") ? !(input.reverse === true) : input.reverse === true;
  return reverse ? -result : result;
}

function keyText(value: string, spec: KeySpec, input: Input): string {
  const fields = input.separator === undefined ? value.split(/\s+/) : value.split(input.separator);
  const joined = fields
    .slice(spec.startField - 1, spec.endField ?? fields.length)
    .join(input.separator ?? " ");
  let text = joined;
  if (spec.startChar !== undefined) text = text.slice(Math.max(0, spec.startChar - 1));
  if (spec.endChar !== undefined) text = text.slice(0, Math.max(0, spec.endChar));
  if (spec.modifiers.has("b") || input.ignoreLeadingBlanks === true) text = text.trimStart();
  return text;
}

function compareValue(left: string, right: string, input: Input, spec?: KeySpec): number {
  if (spec?.modifiers.has("V") === true || input.version === true) {
    return versionCompare(left, right);
  }
  if (spec?.modifiers.has("g") === true || input.generalNumeric === true) {
    return numeric(left) - numeric(right);
  }
  if (spec?.modifiers.has("h") === true || input.humanNumeric === true) {
    return humanNumeric(left) - humanNumeric(right);
  }
  if (spec?.modifiers.has("n") === true || input.numeric === true) {
    return numeric(left) - numeric(right);
  }
  const leftText = normalizeText(left, input, spec);
  const rightText = normalizeText(right, input, spec);
  return leftText.localeCompare(rightText);
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

function normalizeText(value: string, input: Input, spec?: KeySpec): string {
  let text = value;
  if (spec?.modifiers.has("i") === true || input.ignoreNonPrinting === true) {
    text = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  }
  if (spec?.modifiers.has("d") === true || input.dictionary === true) {
    text = text.replace(/[^A-Za-z0-9\s]/g, "");
  }
  if (spec?.modifiers.has("f") === true || input.ignoreCase === true) {
    text = text.toLowerCase();
  }
  return text;
}

function numeric(value: string): number {
  const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(value);
  return match === null ? 0 : Number(match[0]);
}

function humanNumeric(value: string): number {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([KMGTPEZY]?)/i.exec(value);
  if (match === null) return 0;
  const number = Number(match[1]);
  const suffix = String(match[2]).toUpperCase();
  const power = suffix === "" ? 0 : "KMGTPEZY".indexOf(suffix) + 1;
  return number * 1024 ** power;
}

function versionCompare(left: string, right: string): number {
  const leftParts = left.match(/\d+|\D+/g) ?? [];
  const rightParts = right.match(/\d+|\D+/g) ?? [];
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index++) {
    const a = leftParts[index];
    const b = rightParts[index];
    /* v8 ignore next */
    if (a === undefined) return -1;
    /* v8 ignore next */
    if (b === undefined) return 1;
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference;
    } else {
      const result = a.localeCompare(b);
      if (result !== 0) return result;
    }
  }
  return 0;
}
