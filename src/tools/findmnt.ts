/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { fromErrno } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Only mounts containing these paths." })),
    fsType: Type.Optional(Type.String({ description: "Only this filesystem type." })),
    noHeader: Type.Optional(Type.Boolean({ description: "Omit the header row." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface Mount {
  target: string;
  source: string;
  fsType: string;
  options: string;
}

export const findmntTool: ToolSpec<Input> = {
  name: "findmnt",
  description:
    "List mounted filesystems from /proc/self/mountinfo with target, source, type, and options (`-T`, `-t`, `-n`).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    await ctx.permission.assertTrusted(["*"]);
    let text: string;
    try {
      text = await fs.readFile("/proc/self/mountinfo", "utf8");
    } catch (error) {
      /* v8 ignore next -- /proc/self/mountinfo exists on Linux */
      throw fromErrno(error);
    }
    const mounts = text.split("\n").filter(Boolean).map(parseMount);
    const filters = (input.paths ?? []).map((value) => value.replace(/\/+$/, "") || "/");
    const rows = mounts
      .filter((mount) => input.fsType === undefined || mount.fsType === input.fsType)
      .filter((mount) => filters.length === 0 || filters.some((path) =>
        mount.target === path ||
        mount.target === "/" ||
        path.startsWith(`${mount.target}/`) ||
        mount.target.startsWith(`${path}/`)))
      .map((mount) => `${mount.target} ${mount.source} ${mount.fsType} ${mount.options}`);

    const header = "TARGET SOURCE FSTYPE OPTIONS";
    const lines = input.noHeader === true ? rows : [header, ...rows];
    return textResult(lines.length > 0 ? `${lines.join("\n")}\n` : "", { mounts: rows.length });
  },
};

export function parseMount(line: string): Mount {
  const fields = line.split(" ");
  const separator = fields.indexOf("-");
  const decode = (value: string): string =>
    value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)));
  return {
    target: decode(fields[4] as string),
    options: fields[5] as string,
    fsType: fields[separator + 1] as string,
    source: decode(fields[separator + 2] as string),
  };
}
