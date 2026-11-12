/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { mapLimit } from "../core/parallel.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to hash. Omit to hash stdin." })),
    algorithm: Type.Optional(
      Type.Union(
        [Type.Literal("md5"), Type.Literal("sha1"), Type.Literal("sha256"), Type.Literal("sha512")],
        { description: "Hash algorithm. Default: sha256." },
      ),
    ),
    tag: Type.Optional(Type.Boolean({ description: "Use BSD-style tagged output (`--tag`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const hashTool: ToolSpec<Input> = {
  name: "hash",
  description:
    "Compute file checksums like `sha256sum`/`md5sum` (`md5`, `sha1`, `sha256`, `sha512`). " +
    "Hashes multiple files in parallel; omit files to hash stdin.",
  schema: Schema,
  pipeable: "sink",
  mutates: false,
  async run(ctx, input, io) {
    const algorithm = input.algorithm ?? "sha256";
    if (input.files === undefined || input.files.length === 0) {
      if (io.stdin === undefined) throw new FsError("no input files and no stdin.", "invalid");
      const hash = await hashStream(algorithm, io.stdin);
      return textResult(`${hash}  -\n`, { algorithm, stdin: true });
    }

    const targets = [];
    for (const requested of input.files) {
      const target = await ctx.sandbox.resolveFollow(requested);
      targets.push({ requested, target });
    }
    await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));

    const results = await mapLimit(
      targets,
      ctx.concurrency,
      async ({ requested, target }) => {
        try {
          const hash = await hashFile(algorithm, target.full);
          return input.tag === true
            ? `${algorithm.toUpperCase()} (${requested}) = ${hash}`
            : `${hash}  ${requested}`;
        } catch (error) {
          throw fromErrno(error);
        }
      },
      ctx.signal,
    );
    return textResult(results.join("\n") + "\n", { algorithm, files: input.files });
  },
};

async function hashFile(algorithm: string, file: string): Promise<string> {
  const hash = createHash(algorithm);
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function hashStream(algorithm: string, stream: AsyncIterable<Buffer>): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

void fsp;
