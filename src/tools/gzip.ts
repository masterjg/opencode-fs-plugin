/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { gzip as gzipBuffer, gunzip as gunzipBuffer } from "node:zlib";
import { promisify } from "node:util";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { mapLimit } from "../core/parallel.js";
import { collect } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const gzipAsync = promisify(gzipBuffer);
const gunzipAsync = promisify(gunzipBuffer);

const GzipSchema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to compress. Omit to read stdin." })),
    keep: Type.Optional(Type.Boolean({ description: "Keep the input file (`-k`)." })),
    force: Type.Optional(Type.Boolean({ description: "Overwrite existing output (`-f`)." })),
    stdout: Type.Optional(Type.Boolean({ description: "Write compressed data to stdout (`-c`)." })),
    level: Type.Optional(Type.Integer({ minimum: 0, maximum: 9, description: "Compression level (`-1`..`-9`)." })),
  },
  { additionalProperties: false },
);

const GunzipSchema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to decompress. Omit to read stdin." })),
    keep: Type.Optional(Type.Boolean({ description: "Keep the input file (`-k`)." })),
    force: Type.Optional(Type.Boolean({ description: "Overwrite existing output (`-f`)." })),
    stdout: Type.Optional(Type.Boolean({ description: "Write decompressed data to stdout (`-c`)." })),
    suffix: Type.Optional(Type.String({ description: "Input suffix. Default: .gz." })),
  },
  { additionalProperties: false },
);

type GzipInput = Static<typeof GzipSchema>;
type GunzipInput = Static<typeof GunzipSchema>;

export const gzipTool: ToolSpec<GzipInput> = {
  name: "gzip",
  description:
    "Compress files or stdin with gzip semantics (`-k`, `-f`, `-c`, `-1`..`-9`). " +
    "File mode writes `<name>.gz` and removes the source unless keep is true.",
  schema: GzipSchema,
  pipeable: "filter",
  mutates: true,
  async run(ctx, input, io) {
    if (input.paths === undefined || input.paths.length === 0) {
      if (io.stdin === undefined) throw new FsError("no input files and no stdin.", "invalid");
      const compressed = await gzipAsync(await collect(io.stdin), { level: input.level ?? 6 });
      return { stdout: compressed, exitCode: 0, metadata: { stdin: true } };
    }
    const targets = [];
    for (const requested of input.paths) {
      const source = await ctx.sandbox.resolveFollow(requested);
      const destination = await ctx.sandbox.resolveForCreate(input.stdout === true ? requested : `${requested}.gz`);
      targets.push({ requested, source, destination });
    }
    await ctx.permission.assert(
      targets.flatMap(({ source, destination }) => [
        { target: source, boundary: source.full },
        /* v8 ignore next */
        ...(input.stdout === true ? [] : [{ target: destination, boundary: destination.full }]),
      ]),
    );
    const results = await mapLimit(targets, ctx.concurrency, async ({ source, destination }) => {
      /* v8 ignore next */
      const data = await fs.readFile(source.full).catch((error) => {
        throw fromErrno(error);
      });
      const compressed = await gzipAsync(data, { level: input.level ?? 6 });
      if (input.stdout === true) return compressed;
      if (input.force !== true && (await exists(destination.full))) {
        throw new FsError(`Output exists: "${destination.full}"`, "exists");
      }
      /* v8 ignore next */
      await fs.writeFile(destination.full, compressed).catch((error) => {
        throw fromErrno(error);
      });
      /* v8 ignore next */
      if (input.keep !== true) await fs.unlink(source.full).catch(() => undefined);
      return Buffer.alloc(0);
    }, ctx.signal);
    if (input.stdout === true) return { stdout: Buffer.concat(results), exitCode: 0, metadata: { files: input.paths } };
    return textResult("", { files: input.paths });
  },
};

export const gunzipTool: ToolSpec<GunzipInput> = {
  name: "gunzip",
  description:
    "Decompress gzip files or stdin (`-k`, `-f`, `-c`, suffix). File mode strips the suffix and removes the source unless keep is true.",
  schema: GunzipSchema,
  pipeable: "filter",
  mutates: true,
  async run(ctx, input, io) {
    if (input.paths === undefined || input.paths.length === 0) {
      if (io.stdin === undefined) throw new FsError("no input files and no stdin.", "invalid");
      /* v8 ignore next 3 */
      const data = await gunzipAsync(await collect(io.stdin)).catch((error) => {
        throw fromErrno(error);
      });
      return { stdout: data, exitCode: 0, metadata: { stdin: true } };
    }
    const suffix = input.suffix ?? ".gz";
    const targets = [];
    for (const requested of input.paths) {
      if (!requested.endsWith(suffix)) throw new FsError(`"${requested}" does not end with ${suffix}.`, "invalid");
      const source = await ctx.sandbox.resolveFollow(requested);
      const output = requested.slice(0, -suffix.length);
      /* v8 ignore next */
      const destination = await ctx.sandbox.resolveForCreate(input.stdout === true ? requested : output);
      targets.push({ requested, source, destination });
    }
    await ctx.permission.assert(
      targets.flatMap(({ source, destination }) => [
        { target: source, boundary: source.full },
        /* v8 ignore next */
        ...(input.stdout === true ? [] : [{ target: destination, boundary: destination.full }]),
      ]),
    );
    const results = await mapLimit(targets, ctx.concurrency, async ({ source, destination }) => {
      /* v8 ignore next */
      const data = await fs.readFile(source.full).catch((error) => {
        throw fromErrno(error);
      });
      /* v8 ignore next */
      const decompressed = await gunzipAsync(data).catch((error) => {
        throw fromErrno(error);
      });
      /* v8 ignore next */
      if (input.stdout === true) return decompressed;
      /* v8 ignore next */
      if (input.force !== true && (await exists(destination.full))) {
        throw new FsError(`Output exists: "${destination.full}"`, "exists");
      }
      /* v8 ignore next */
      await fs.writeFile(destination.full, decompressed).catch((error) => {
        throw fromErrno(error);
      });
      /* v8 ignore next */
      if (input.keep !== true) await fs.unlink(source.full).catch(() => undefined);
      return Buffer.alloc(0);
    }, ctx.signal);
    /* v8 ignore next */
    if (input.stdout === true) return { stdout: Buffer.concat(results), exitCode: 0, metadata: { files: input.paths } };
    return textResult("", { files: input.paths });
  },
};

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}


