/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { FsError, fromErrno } from "./errors.js";

export async function* readFiles(paths: readonly string[]): AsyncGenerator<Buffer> {
  for (const file of paths) {
    const stream = createReadStream(file);
    try {
      for await (const chunk of stream) yield chunk as Buffer;
    } catch (error) {
      throw fromErrno(error);
    }
  }
}

export async function* inputStream(
  paths: readonly string[],
  stdin: AsyncIterable<Buffer> | undefined,
): AsyncGenerator<Buffer> {
  if (paths.length > 0) {
    yield* readFiles(paths);
    return;
  }
  if (stdin === undefined) throw new FsError("no input files and no stdin.", "invalid");
  yield* stdin;
}

export async function collect(
  stream: AsyncIterable<Buffer>,
  limit = Number.POSITIVE_INFINITY,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    if (total + chunk.length > limit) {
      chunks.push(chunk.subarray(0, Math.max(0, limit - total)));
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks);
}

export async function* lines(
  stream: AsyncIterable<Buffer>,
): AsyncGenerator<{ text: string; newline: boolean }> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      yield { text: buffer.slice(0, index), newline: true };
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer.length > 0) yield { text: buffer, newline: false };
}

export async function writeAll(path: string, data: AsyncIterable<Buffer> | Buffer, append = false): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, append ? "a" : "w");
    if (Buffer.isBuffer(data)) {
      await handle.write(data);
    } else {
      for await (const chunk of data) await handle.write(chunk);
    }
  } catch (error) {
    throw fromErrno(error);
  } finally {
    await handle?.close();
  }
}

export function toBuffer(text: string): Buffer {
  return Buffer.from(text, "utf8");
}
