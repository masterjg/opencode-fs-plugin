/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { FsError } from "../core/errors.js";
import { collect, inputStream } from "../core/stream.js";
import { textResult, type ToolSpec, type ToolResult } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to read. Omit to read stdin." })),
    decode: Type.Optional(Type.Boolean({ description: "Decode base64 instead of encoding (`-d`)." })),
    wrap: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 4096, description: "Encoded line width; 0 disables wrapping. Default: 76." }),
    ),
    ignoreGarbage: Type.Optional(Type.Boolean({ description: "Drop non-base64 characters while decoding (`-i`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const base64Tool: ToolSpec<Input> = {
  name: "base64",
  description:
    "Encode files or stdin as base64, or decode base64 (`-d`, `-i`, `-w`). Decoded bytes may be binary.",
  schema: Schema,
  pipeable: "source",
  mutates: false,
  async run(ctx, input, io): Promise<ToolResult> {
    const targets = [];
    for (const requested of input.paths ?? []) {
      const target = await ctx.sandbox.resolveFollow(requested);
      targets.push({ requested, full: target.full, target });
    }
    if (targets.length > 0) {
      await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));
    }
    const data = await collect(
      inputStream(targets.map((target) => target.full), io.stdin),
    );

    if (input.decode !== true) {
      const wrap = input.wrap ?? 76;
      const encoded = data.toString("base64");
      const body = wrap > 0
        ? encoded.replace(new RegExp(`.{1,${wrap}}`, "g"), "$&\n")
        : `${encoded}\n`;
      return textResult(body, { encoded: true, bytes: data.length });
    }

    const cleaned = input.ignoreGarbage === true
      ? data.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "")
      : data.toString("latin1").replace(/\s+/g, "");
    if (cleaned.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
      throw new FsError("Invalid base64 input.", "invalid");
    }
    const decoded = Buffer.from(cleaned, "base64");
    return { stdout: decoded, exitCode: 0, metadata: { encoded: false, bytes: decoded.length } };
  },
};
