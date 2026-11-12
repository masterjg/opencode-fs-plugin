/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { fromErrno } from "../core/errors.js";
import { humanSize } from "../core/format.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Filesystems to report. Default: ['.']." })),
    human: Type.Optional(Type.Boolean({ description: "Human-readable sizes (`-h`)." })),
    inodes: Type.Optional(Type.Boolean({ description: "Report inode usage (`-i`)." })),
    printType: Type.Optional(Type.Boolean({ description: "Print the filesystem type (`-T`)." })),
    all: Type.Optional(Type.Boolean({ description: "Include pseudo filesystems (`-a`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const dfTool: ToolSpec<Input> = {
  name: "df",
  description:
    "Report filesystem space usage with Linux `df` semantics (`-h`, `-i`, `-T`, `-a`).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const paths = input.paths ?? ["."];
    const rows: string[] = [];
    const typeHeader = input.printType === true ? "Type " : "";
    rows.push(
      input.inodes === true
        ? `${typeHeader}Filesystem Inodes IUsed IFree IUse% Mounted on`
        : `${typeHeader}Filesystem Size Used Avail Use% Mounted on`,
    );
    for (const requested of paths) {
      const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      await ctx.permission.assert([{ target, boundary: target.full }]);
      let stats;
      try {
        stats = await fs.statfs(target.full);
      } catch (error) {
        /* v8 ignore next */
        throw fromErrno(error, "access");
      }
      const type = input.printType === true ? `${Number(stats.type).toString(16)} ` : "";
      if (input.inodes === true) {
        const used = stats.files - stats.ffree;
        /* v8 ignore next */
        const percent = stats.files === 0 ? 0 : Math.ceil((used / stats.files) * 100);
        rows.push(`${type}${requested} ${stats.files} ${used} ${stats.ffree} ${percent}% ${requested}`);
      } else {
        const total = stats.blocks * stats.bsize;
        const free = stats.bfree * stats.bsize;
        const available = stats.bavail * stats.bsize;
        const used = total - free;
        /* v8 ignore next */
        const percent = total === 0 ? 0 : Math.ceil((used / total) * 100);
        rows.push(
          `${type}${requested} ${size(total, input.human === true)} ${size(used, input.human === true)} ${size(available, input.human === true)} ${percent}% ${requested}`,
        );
      }
    }
    return textResult(rows.join("\n") + "\n", { paths });
  },
};

function size(bytes: number, human: boolean): string {
  if (human) return humanSize(bytes);
  return String(Math.ceil(bytes / 1024));
}


