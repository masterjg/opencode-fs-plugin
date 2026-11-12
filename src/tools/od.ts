/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to dump. Omit to read stdin." })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Start byte offset. Default: 0." })),
    length: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum bytes to dump." })),
    width: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 64, description: "Bytes per line. Default: 16." }),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const odTool: ToolSpec<Input> = {
  name: "od",
  description:
    "Hex dump files or stdin with offsets and an ASCII column (`-j`, `-N`, `-w`).",
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
    const data = await collect(inputStream(targets.map((target) => target.full), io.stdin));
    const offset = input.offset ?? 0;
    const end = input.length === undefined ? data.length : Math.min(data.length, offset + input.length);
    const slice = data.subarray(offset, end);
    const width = input.width ?? 16;
    const lines: string[] = [];
    for (let position = 0; position < slice.length; position += width) {
      const row = slice.subarray(position, position + width);
      const groups: string[] = [];
      for (let index = 0; index < row.length; index += 2) {
        groups.push(row.subarray(index, index + 2).toString("hex").padEnd(4, " "));
      }
      const hex = groups.join(" ").padEnd(width * 3 - 1, " ");
      const ascii = [...row].map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".")).join("");
      lines.push(`${(offset + position).toString(16).padStart(8, "0")}: ${hex}  ${ascii}`);
    }
    return textResult(lines.length > 0 ? `${lines.join("\n")}\n` : "", { bytes: slice.length });
  },
};
