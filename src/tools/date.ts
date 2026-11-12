/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { FsError } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    value: Type.Optional(Type.String({ description: "Date string parsed by Date.parse, or @epoch seconds (`-d`)." })),
    utc: Type.Optional(Type.Boolean({ description: "Use UTC (`-u`)." })),
    format: Type.Optional(
      Type.Union(
        [Type.Literal("iso"), Type.Literal("unix"), Type.Literal("rfc"), Type.Literal("date")],
        { description: "Output style. Default: iso." },
      ),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const dateTool: ToolSpec<Input> = {
  name: "date",
  description: "Print the current date or a parsed date as ISO, Unix seconds, RFC 2822, or JS date text (`-u`, `-d`, `-I`).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    await ctx.permission.assertTrusted(["*"]);
    const date = parseDate(input.value);
    const utc = input.utc === true;
    const format = input.format ?? "iso";
    if (format === "unix") return textResult(`${Math.floor(date.getTime() / 1000)}\n`, { epoch: date.getTime() });
    if (format === "rfc") return textResult(`${date.toUTCString()}\n`, { epoch: date.getTime() });
    if (format === "date") {
      return textResult(`${utc ? date.toUTCString() : date.toString()}\n`, { epoch: date.getTime() });
    }
    return textResult(`${utc ? date.toISOString() : localIso(date)}\n`, { epoch: date.getTime() });
  },
};

function parseDate(value: string | undefined): Date {
  if (value === undefined) return new Date();
  const date = value.startsWith("@")
    ? new Date(Number(value.slice(1)) * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) throw new FsError(`Invalid date: "${value}".`, "invalid");
  return date;
}

export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}${sign}${hours}:${minutes}`;
}
