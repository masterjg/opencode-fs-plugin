/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { listProcesses } from "../core/procfs.js";
import { resolveUid } from "../core/fsutil.js";
import { FsError } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    pattern: Type.String({ minLength: 1, description: "Process name or command-line regex." }),
    full: Type.Optional(Type.Boolean({ description: "Match the full command line instead of the name." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive match." })),
    user: Type.Optional(Type.String({ description: "Only processes owned by this user name or uid." })),
    newest: Type.Optional(Type.Boolean({ description: "Return only the newest match." })),
    oldest: Type.Optional(Type.Boolean({ description: "Return only the oldest match." })),
    count: Type.Optional(Type.Boolean({ description: "Print only the match count." })),
    delimiter: Type.Optional(Type.String({ description: "Separator between pids. Default: newline." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const pgrepTool: ToolSpec<Input> = {
  name: "pgrep",
  description:
    "Find processes by name or command-line regex using /proc (`-f`, `-i`, `-u`, `-n`, `-o`, `-c`).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    await ctx.permission.assertTrusted([input.pattern]);
    if (input.newest === true && input.oldest === true) {
      throw new FsError("newest and oldest are mutually exclusive.", "invalid");
    }
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.ignoreCase === true ? "i" : "");
    } catch (error) {
      throw new FsError(`Invalid pattern: ${(error as Error).message}`, "invalid");
    }
    const uid = input.user === undefined ? undefined : await resolveUid(input.user);
    let matches = (await listProcesses(ctx.concurrency, ctx.signal))
      .filter((row) => uid === undefined || row.uid === uid)
      .filter((row) => regex.test(input.full === true ? row.command : row.comm));

    if (input.newest === true) matches = matches.sort((a, b) => b.startTime - a.startTime).slice(0, 1);
    if (input.oldest === true) matches = matches.sort((a, b) => a.startTime - b.startTime).slice(0, 1);
    if (input.count === true) return textResult(`${matches.length}\n`, { matched: matches.length });

    const delimiter = input.delimiter ?? "\n";
    const text = matches.length === 0 ? "" : `${matches.map((row) => row.pid).join(delimiter)}${delimiter}`;
    return textResult(text, { matched: matches.length }, matches.length > 0 ? 0 : 1);
  },
};
