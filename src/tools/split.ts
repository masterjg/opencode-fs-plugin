/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { mapLimit } from "../core/parallel.js";
import { collect, inputStream, lines } from "../core/stream.js";
import type { ResolvedTarget } from "../core/sandbox.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    input: Type.Optional(Type.String({ description: "File to split. Omit to read stdin." })),
    prefix: Type.Optional(Type.String({ description: "Output name prefix. Default: x." })),
    lines: Type.Optional(Type.Integer({ minimum: 1, description: "Lines per chunk (`-l`)." })),
    bytes: Type.Optional(Type.Integer({ minimum: 1, description: "Bytes per chunk (`-b`)." })),
    suffixLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: "Suffix length (`-a`). Default: 2." })),
    numeric: Type.Optional(Type.Boolean({ description: "Numeric suffixes (`-d`)." })),
    additionalSuffix: Type.Optional(Type.String({ description: "Extra suffix appended to every name (`--additional-suffix`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const splitTool: ToolSpec<Input> = {
  name: "split",
  description:
    "Split a file into line or byte chunks with alphabetic or numeric suffixes (`-l`, `-b`, `-a`, `-d`).",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input, io) {
    if ((input.lines === undefined) === (input.bytes === undefined)) {
      throw new FsError("exactly one of lines or bytes is required.", "invalid");
    }
    const prefix = input.prefix ?? "x";
    const suffixLength = input.suffixLength ?? 2;
    const additional = input.additionalSuffix ?? "";
    let inputPath: string | undefined;
    if (input.input !== undefined) {
      const target = await ctx.sandbox.resolveFollow(input.input);
      await ctx.permission.assert([{ target, boundary: target.full }]);
      inputPath = target.full;
    }
    const data = await collect(inputStream(inputPath === undefined ? [] : [inputPath], io.stdin));
    const chunks = input.lines === undefined
      ? byteChunks(data, input.bytes as number)
      : await lineChunks(data, input.lines);

    const names = chunks.map((_chunk, index) => `${prefix}${suffix(index, suffixLength, input.numeric === true)}${additional}`);
    const targets: ResolvedTarget[] = [];
    for (const name of names) {
      const target = await ctx.sandbox.resolveForCreate(name);
      targets.push(target);
    }
    await ctx.permission.assert(targets.map((target) => ({ target, boundary: target.full })));
    await mapLimit(chunks, ctx.concurrency, async (chunk, index) => {
      try {
        await fs.writeFile((targets[index] as { full: string }).full, chunk);
      } catch (error) {
        /* v8 ignore next -- write errors are environment-dependent */
        throw fromErrno(error);
      }
    }, ctx.signal);
    return textResult("", { files: names, chunks: chunks.length });
  },
};

function byteChunks(data: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += size) chunks.push(data.subarray(offset, offset + size));
  return chunks.length === 0 ? [Buffer.alloc(0)] : chunks;
}

async function lineChunks(data: Buffer, size: number): Promise<Buffer[]> {
  const chunks: string[] = [];
  let current: string[] = [];
  for await (const line of lines({ async *[Symbol.asyncIterator]() { yield data; } })) {
    current.push(line.text + (line.newline ? "\n" : ""));
    if (current.length === size) {
      chunks.push(current.join(""));
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current.join(""));
  if (chunks.length === 0) chunks.push("");
  return chunks.map((chunk) => Buffer.from(chunk, "utf8"));
}

function suffix(index: number, length: number, numeric: boolean): string {
  if (numeric) return String(index).padStart(length, "0");
  let value = index;
  let text = "";
  for (let position = 0; position < length; position++) {
    text = String.fromCharCode(97 + (value % 26)) + text;
    value = Math.floor(value / 26);
  }
  return text;
}
