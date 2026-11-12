/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { fromErrno } from "../core/errors.js";
import { detectFileType } from "../core/magic.js";
import { mapLimit } from "../core/parallel.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Files to inspect.",
    }),
    mime: Type.Optional(Type.Boolean({ description: "Print MIME types instead of descriptions." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const fileTool: ToolSpec<Input> = {
  name: "file",
  description:
    "Identify file types by content magic (ELF, images, archives, compression, SQLite, wasm, text, data).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const targets = [];
    for (const requested of input.paths) {
      const target = await ctx.sandbox.resolveFollow(requested);
      targets.push({ requested, full: target.full, target });
    }
    await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));

    const lines = await mapLimit(targets, ctx.concurrency, async ({ requested, full }) => {
      const sample = await readSample(full);
      const type = detectFileType(sample);
      return `${requested}: ${input.mime === true ? type.mime : type.description}`;
    }, ctx.signal);
    return textResult(`${lines.join("\n")}\n`, { files: lines.length });
  },
};

async function readSample(full: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(full, "r");
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    throw fromErrno(error);
  } finally {
    await handle?.close();
  }
}
