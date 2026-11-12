/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Type, type Static } from "@sinclair/typebox";
import { lookupGroup, lookupUser } from "../core/fsutil.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    only: Type.Optional(
      Type.Union([Type.Literal("user"), Type.Literal("group"), Type.Literal("groups")], {
        description: "Print only uid, gid, or group list (`-u`, `-g`, `-G`).",
      }),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const idTool: ToolSpec<Input> = {
  name: "id",
  description: "Print the current uid, gid, and group memberships with names (`-u`, `-g`, `-G`).",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    await ctx.permission.assertTrusted(["*"]);
    /* v8 ignore next -- process.getuid exists on supported platforms */
    const uid = process.getuid?.() ?? os.userInfo().uid;
    /* v8 ignore next -- process.getgid exists on supported platforms */
    const gid = process.getgid?.() ?? os.userInfo().gid;
    const user = await lookupUser(uid);
    const groups = await groupsFor(user, gid);

    if (input.only === "user") return textResult(`${uid}\n`, { uid });
    if (input.only === "group") return textResult(`${gid}\n`, { gid });
    if (input.only === "groups") return textResult(`${groups.map((entry) => entry.gid).join(" ")}\n`, { groups });
    return textResult(
      `uid=${uid}(${user}) gid=${gid}(${await lookupGroup(gid)}) groups=${groups.map((entry) => `${entry.gid}(${entry.name})`).join(",")}\n`,
      { uid, gid, groups },
    );
  },
};

async function groupsFor(
  user: string,
  primary: number,
): Promise<Array<{ gid: number; name: string }>> {
  const entries = new Map<number, string>();
  /* v8 ignore next -- /etc/group exists on supported Linux systems */
  const text = await fs.readFile("/etc/group", "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 4) continue;
    const gid = Number(fields[2]);
    if (gid === primary || (fields[3] as string).split(",").includes(user)) {
      entries.set(gid, fields[0] as string);
    }
  }
  /* v8 ignore next -- the primary group is normally present in /etc/group */
  if (!entries.has(primary)) entries.set(primary, await lookupGroup(primary));
  return [...entries.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([gid, name]) => ({ gid, name }));
}
