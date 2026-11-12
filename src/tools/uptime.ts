/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as os from "node:os";
import { Type, type Static } from "@sinclair/typebox";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    pretty: Type.Optional(Type.Boolean({ description: "Human-readable duration instead of seconds (`-p`)." })),
    loadAverage: Type.Optional(Type.Boolean({ description: "Append the 1/5/15-minute load averages." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const uptimeTool: ToolSpec<Input> = {
  name: "uptime",
  description: "Print system uptime in seconds or human-readable form, optionally with load averages.",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    await ctx.permission.assertTrusted(["*"]);
    const seconds = os.uptime();
    const base = input.pretty === true ? pretty(seconds) : `${seconds.toFixed(2)} seconds`;
    const load = input.loadAverage === true
      ? ` load average: ${os.loadavg().map((value) => value.toFixed(2)).join(", ")}`
      : "";
    return textResult(`${base}${load}\n`, { seconds, load: os.loadavg() });
  },
};

export function pretty(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return `up ${parts.join(", ")}`;
}
