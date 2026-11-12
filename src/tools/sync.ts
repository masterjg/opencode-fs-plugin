/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { fromErrno } from "../core/errors.js";
import { mapLimit } from "../core/parallel.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { description: "Files or directories to fsync. Default: ['.']." }),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const syncTool: ToolSpec<Input> = {
  name: "sync",
  description:
    "Flush file or directory data to disk with fsync. Defaults to the project root; Node has no global sync syscall.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const targets = [];
    for (const requested of input.paths ?? ["."]) {
      const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      targets.push({ requested, full: target.full, target });
    }
    await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));
    await mapLimit(targets, ctx.concurrency, async ({ full }) => {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(full, "r");
        await handle.sync();
      } catch (error) {
        /* v8 ignore next -- fsync errors are environment-dependent */
        throw fromErrno(error);
      } finally {
        await handle?.close();
      }
    }, ctx.signal);
    return textResult("", { synced: targets.length });
  },
};
