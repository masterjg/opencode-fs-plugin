/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as os from "node:os";
import { Type, type Static } from "@sinclair/typebox";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    kernel: Type.Optional(Type.Boolean({ description: "Print the kernel name (`-s`)." })),
    nodename: Type.Optional(Type.Boolean({ description: "Print the hostname (`-n`)." })),
    release: Type.Optional(Type.Boolean({ description: "Print the kernel release (`-r`)." })),
    version: Type.Optional(Type.Boolean({ description: "Print the kernel version (`-v`)." })),
    machine: Type.Optional(Type.Boolean({ description: "Print the machine hardware name (`-m`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const unameTool: ToolSpec<Input> = {
  name: "uname",
  description: "Print system information (`-s`, `-n`, `-r`, `-v`, `-m`); default is all fields.",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    await ctx.permission.assertTrusted(["*"]);
    const selected = [input.kernel, input.nodename, input.release, input.version, input.machine];
    const all = selected.every((value) => value !== true);
    return textResult(`${values(input, all).join(" ")}\n`, {});
  },
};

function values(input: Input, all: boolean): string[] {
  const output: string[] = [];
  if (all || input.kernel === true) output.push(os.type());
  if (all || input.nodename === true) output.push(os.hostname());
  if (all || input.release === true) output.push(os.release());
  if (all || input.version === true) output.push(os.version());
  if (all || input.machine === true) output.push(os.machine());
  return output;
}
