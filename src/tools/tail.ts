/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream, readFiles } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";
import { FsError } from "../core/errors.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to read. Omit to read stdin." })),
    lines: Type.Optional(Type.Integer({ minimum: 1, description: "Number of lines. Default: 10 (`-n`)." })),
    bytes: Type.Optional(Type.Integer({ minimum: 1, description: "Number of bytes from the end (`-c`)." })),
    fromStart: Type.Optional(Type.Boolean({ description: "Treat lines as a 1-based starting line (`-n +N`)." })),
    quiet: Type.Optional(Type.Boolean({ description: "Never print file headers (`-q`)." })),
    verbose: Type.Optional(Type.Boolean({ description: "Always print file headers (`-v`)." })),
    follow: Type.Optional(Type.Boolean({ description: "Follow appended data for a bounded interval (`-f`)." })),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 100, maximum: 600_000, description: "Follow duration. Default: 10000." }),
    ),
    intervalMs: Type.Optional(
      Type.Integer({ minimum: 50, maximum: 10_000, description: "Follow poll interval. Default: 250." }),
    ),
    maxBytes: Type.Optional(
      Type.Integer({ minimum: 1, description: "Maximum appended bytes to return. Default: 1048576." }),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const tailTool: ToolSpec<Input> = {
  name: "tail",
  description:
    "Output the last part of files or stdin with Linux `tail` semantics (`-n`, `-n +N`, `-c`, `-q`, `-v`). " +
    "Bounded follow mode (`-f`) requires one file and a timeout.",
  schema: Schema,
  pipeable: "filter",
  mutates: false,
  async run(ctx, input, io) {
    if (input.lines !== undefined && input.bytes !== undefined) {
      throw new FsError("tail accepts either lines or bytes, not both.", "invalid");
    }
    const count = input.bytes ?? input.lines ?? 10;
    const paths = input.paths ?? [];
    const targets = [];
    for (const requested of paths) {
      const target = await ctx.sandbox.resolveFollow(requested).catch(async (error) => {
        if (input.follow === true && error instanceof FsError && error.code === "not-found") {
          return ctx.sandbox.resolveForCreate(requested);
        }
        throw error;
      });
      targets.push({ requested, full: target.full, target });
    }
    if (targets.length > 0) {
      await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));
    }

    if (input.follow === true && targets.length !== 1) {
      throw new FsError("follow requires exactly one file.", "invalid");
    }

    const output: Buffer[] = [];
    if (input.follow === true) {
      const target = targets[0] as (typeof targets)[number];
      if (input.quiet !== true && input.verbose === true) {
        output.push(Buffer.from(`==> ${target.requested} <==\n`));
      }
      output.push(await follow(target.full, count, input, ctx.signal));
    } else if (targets.length === 0) {
      const data = await collect(await inputStream([], io.stdin));
      output.push(tailBuffer(data, count, input));
    } else {
      for (const target of targets) {
        if (input.quiet !== true && (targets.length > 1 || input.verbose === true)) {
          output.push(Buffer.from(`==> ${target.requested} <==\n`));
        }
        const data = await collect(readFiles([target.full]));
        output.push(tailBuffer(data, count, input));
      }
    }
    return textResult(Buffer.concat(output).toString("utf8"), { paths });
  },
};

async function follow(
  full: string,
  count: number,
  input: Input,
  signal: AbortSignal,
): Promise<Buffer> {
  const timeoutMs = Math.min(600_000, Math.max(100, input.timeoutMs ?? 10_000));
  const intervalMs = Math.min(10_000, Math.max(50, input.intervalMs ?? 250));
  const maxBytes = input.maxBytes ?? 1024 * 1024;
  const deadline = Date.now() + timeoutMs;
  const output: Buffer[] = [];
  let offset = 0;
  let appended = 0;
  if (signal.aborted) return Buffer.alloc(0);

  try {
    const initial = await fs.readFile(full);
    output.push(tailBuffer(initial, count, input));
    offset = initial.length;
  } catch {
    // Follow starts when the file appears.
  }

  while (Date.now() < deadline && !signal.aborted && appended < maxBytes) {
    let stats: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      stats = await fs.stat(full);
    } catch {
      offset = 0;
      await delay(intervalMs, signal);
      continue;
    }
    if (stats.size < offset) offset = 0;
    if (stats.size > offset) {
      const length = Math.min(stats.size - offset, maxBytes - appended);
      const data = await readRange(full, offset, length);
      /* v8 ignore next -- the file can shrink between stat and read */
      if (data.length > 0) {
        output.push(data);
        offset += data.length;
        appended += data.length;
      }
    }
    await delay(intervalMs, signal);
  }
  return Buffer.concat(output);
}

async function readRange(full: string, start: number, length: number): Promise<Buffer> {
  const handle = await fs.open(full, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, length));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    /* v8 ignore next 4 -- follow checks the signal before calling delay */
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function tailBuffer(data: Buffer, count: number, input: Input): Buffer {
  if (input.bytes !== undefined) return data.subarray(Math.max(0, data.length - count));
  const text = data.toString("utf8");
  const trailing = text.endsWith("\n");
  const parts = text.split("\n");
  if (trailing) parts.pop();
  /* v8 ignore next */
  if (input.fromStart === true) return Buffer.from(parts.slice(count - 1).join("\n") + (trailing ? "\n" : ""), "utf8");
  return Buffer.from(parts.slice(Math.max(0, parts.length - count)).join("\n") + (trailing ? "\n" : ""), "utf8");
}
