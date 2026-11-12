/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { fromErrno } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Paths to test." }),
    quiet: Type.Optional(Type.Boolean({ description: "Print nothing; use the exit code (`-q`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const mountpointTool: ToolSpec<Input> = {
  name: "mountpoint",
  description:
    "Report whether paths are mount points by comparing device ids with their parent (`-q`).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const targets = [];
    for (const requested of input.paths) {
      const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      targets.push({ requested, full: target.full, target });
    }
    await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));

    const lines: string[] = [];
    let allMounted = true;
    for (const { requested, full } of targets) {
      const mounted = await isMountPoint(full);
      allMounted &&= mounted;
      if (input.quiet !== true) lines.push(`${requested} is ${mounted ? "a" : "not a"} mountpoint`);
    }
    return textResult(lines.length > 0 ? `${lines.join("\n")}\n` : "", { mountpoints: allMounted }, allMounted ? 0 : 1);
  },
};

async function isMountPoint(full: string): Promise<boolean> {
  if (full === path.parse(full).root) return true;
  try {
    const [stats, parent] = await Promise.all([fs.stat(full), fs.stat(path.dirname(full))]);
    return stats.dev !== parent.dev;
  } catch (error) {
    /* v8 ignore next -- stat errors after resolution are rare */
    throw fromErrno(error);
  }
}
