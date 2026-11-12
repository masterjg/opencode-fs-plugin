/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { fromErrno } from "../core/errors.js";
import { SIGNALS } from "../core/procfs.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    pids: Type.Array(Type.Integer({ minimum: 2 }), {
      minItems: 1,
      description: "Process ids to signal. Pid 0, 1, and negative groups are rejected.",
    }),
    signal: Type.Optional(
      Type.Union(
        Object.keys(SIGNALS).map((name) => Type.Literal(name)),
        { description: "Signal name. Default: TERM." },
      ),
    ),
    dryRun: Type.Optional(Type.Boolean({ description: "Report targets without signalling them." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const killTool: ToolSpec<Input> = {
  name: "kill",
  description:
    "Send a signal to processes (`HUP`, `INT`, `QUIT`, `KILL`, `TERM`, `USR1`, `USR2`, `STOP`, `CONT`). " +
    "Pid 1 and process groups are never targeted.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    await ctx.permission.assertTrusted(input.pids.map(String));
    const name = input.signal ?? "TERM";
    const signal = SIGNALS[name] as NodeJS.Signals;
    const signalled: number[] = [];
    for (const pid of input.pids) {
      if (input.dryRun === true) {
        signalled.push(pid);
        continue;
      }
      try {
        process.kill(pid, signal);
      } catch (error) {
        throw fromErrno(error);
      }
      signalled.push(pid);
    }
    return textResult(
      input.dryRun === true ? signalled.map((pid) => `would signal ${pid} (${name})`).join("\n") + "\n" : "",
      { signalled, signal: name, dryRun: input.dryRun === true },
    );
  },
};
