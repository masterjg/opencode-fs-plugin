/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { listProcesses } from "../core/procfs.js";
import { lookupUser, resolveUid } from "../core/fsutil.js";
import { FsError } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    pids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Only these process ids." })),
    user: Type.Optional(Type.String({ description: "Only processes owned by this user name or uid." })),
    command: Type.Optional(Type.String({ description: "Only processes whose command line matches this regex." })),
    sortBy: Type.Optional(
      Type.Union([Type.Literal("pid"), Type.Literal("rss"), Type.Literal("start")], {
        description: "Sort key. Default: pid.",
      }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum rows." })),
    noHeader: Type.Optional(Type.Boolean({ description: "Omit the header row." })),
    format: Type.Optional(
      Type.Union([Type.Literal("table"), Type.Literal("json")], { description: "Output format. Default: table." }),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const psTool: ToolSpec<Input> = {
  name: "ps",
  description:
    "List processes from /proc with pid, ppid, owner, state, rss and command. " +
    "Filters by pid, user, or command regex; sorts and formats the result.",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    await ctx.permission.assertTrusted(["*"]);
    const uid = input.user === undefined ? undefined : await resolveUid(input.user);
    const regex = input.command === undefined ? undefined : compile(input.command);

    const wanted = input.pids === undefined ? undefined : new Set(input.pids);
    let rows = (await listProcesses(ctx.concurrency, ctx.signal))
      .filter((row) => wanted === undefined || wanted.has(row.pid))
      .filter((row) => uid === undefined || row.uid === uid)
      .filter((row) => regex === undefined || regex.test(row.command));

    const sortBy = input.sortBy ?? "pid";
    rows = rows.sort((a, b) =>
      sortBy === "rss"
        ? b.rssBytes - a.rssBytes
        : sortBy === "start"
          ? a.startTime - b.startTime
          : a.pid - b.pid);
    if (input.limit !== undefined) rows = rows.slice(0, input.limit);

    const withUser = await Promise.all(
      rows.map(async (row) => ({ ...row, user: await lookupUser(row.uid) })),
    );
    if (input.format === "json") {
      return textResult(`${JSON.stringify(withUser, null, 2)}\n`, { processes: withUser.length });
    }

    const table = withUser.map((row) => [
      String(row.pid).padStart(6),
      String(row.ppid).padStart(6),
      row.user.padEnd(10),
      row.state.padEnd(4),
      String(row.rssBytes).padStart(10),
      row.command,
    ].join(" "));
    const header = ["PID".padStart(6), "PPID".padStart(6), "USER".padEnd(10), "STAT".padEnd(4), "RSS".padStart(10), "COMMAND"].join(" ");
    const lines = input.noHeader === true ? table : [header, ...table];
    return textResult(lines.length > 0 ? `${lines.join("\n")}\n` : "", { processes: rows.length });
  },
};

function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new FsError(`Invalid command regex: ${(error as Error).message}`, "invalid");
  }
}
