/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    input: Type.Optional(Type.String({ description: "Input file. Omit to read stdin (`if=`)." })),
    output: Type.Optional(Type.String({ description: "Output file. Omit to write stdout (`of=`)." })),
    blockSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 16_777_216, description: "Block size in bytes (`bs=`). Default: 512." })),
    count: Type.Optional(Type.Integer({ minimum: 1, description: "Copy at most this many blocks (`count=`)." })),
    skip: Type.Optional(Type.Integer({ minimum: 0, description: "Skip this many input blocks (`skip=`)." })),
    seek: Type.Optional(Type.Integer({ minimum: 0, description: "Seek this many output blocks (`seek=`)." })),
    status: Type.Optional(Type.Boolean({ description: "Print a transfer summary (`status=progress`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const ddTool: ToolSpec<Input> = {
  name: "dd",
  description:
    "Copy bytes with block size, count, skip and seek (`bs=`, `count=`, `skip=`, `seek=`, `status=`).",
  schema: Schema,
  pipeable: "source",
  mutates: true,
  async run(ctx, input, io) {
    const block = input.blockSize ?? 512;
    let inputPath: string | undefined;
    if (input.input !== undefined) {
      const target = await ctx.sandbox.resolveFollow(input.input);
      await ctx.permission.assert([{ target, boundary: target.full }]);
      inputPath = target.full;
    }
    let outputPath: string | undefined;
    if (input.output !== undefined) {
      const target = await ctx.sandbox.resolveForCreate(input.output);
      await ctx.permission.assert([{ target, boundary: target.full }]);
      outputPath = target.full;
    }
    const source = inputPath === undefined ? io.stdin : fileChunks(inputPath, block);
    if (source === undefined) throw new FsError("no input file and no stdin.", "invalid");

    const skipBytes = (input.skip ?? 0) * block;
    const seekBytes = (input.seek ?? 0) * block;
    const maxBytes = input.count === undefined ? Number.POSITIVE_INFINITY : input.count * block;
    const chunks: Buffer[] = [];
    let skipped = 0;
    let copied = 0;
    for await (const chunk of source) {
      let data = chunk;
      if (skipped < skipBytes) {
        const drop = Math.min(skipBytes - skipped, data.length);
        skipped += drop;
        data = data.subarray(drop);
      }
      if (data.length === 0) continue;
      const room = maxBytes - copied;
      if (data.length > room) data = data.subarray(0, room);
      chunks.push(data);
      copied += data.length;
      if (copied >= maxBytes) break;
    }
    const data = Buffer.concat(chunks);

    if (outputPath !== undefined) {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(outputPath, "w");
        if (data.length > 0) await handle.write(data, 0, data.length, seekBytes);
      } catch (error) {
        /* v8 ignore next -- write errors are environment-dependent */
        throw fromErrno(error);
      } finally {
        await handle?.close();
      }
    } else if (seekBytes > 0) {
      chunks.unshift(Buffer.alloc(seekBytes));
    }

    const records = Math.ceil(copied / block);
    if (input.status === true) {
      return textResult(
        `${records}+0 records in\n${records}+0 records out\n${copied} bytes copied\n`,
        { bytes: copied, records, blockSize: block },
      );
    }
    return {
      stdout: outputPath === undefined ? Buffer.concat(chunks) : Buffer.alloc(0),
      exitCode: 0,
      metadata: { bytes: copied, records, blockSize: block },
    };
  },
};

async function* fileChunks(full: string, block: number): AsyncGenerator<Buffer> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(full, "r");
    let position = 0;
    for (;;) {
      const buffer = Buffer.alloc(block);
      const { bytesRead } = await handle.read(buffer, 0, block, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } catch (error) {
    /* v8 ignore next -- read errors after a successful open are rare */
    throw fromErrno(error);
  } finally {
    await handle?.close();
  }
}
