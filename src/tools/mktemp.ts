/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    template: Type.Optional(Type.String({ description: "Template containing at least 3 X characters. Default: tmp.XXXXXXXXXX." })),
    directory: Type.Optional(Type.Boolean({ description: "Create a directory instead of a file (`-d`)." })),
    tmpdir: Type.Optional(Type.String({ description: "Directory for the temporary path (`-p`)." })),
    suffix: Type.Optional(Type.String({ description: "Suffix to append." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const mktempTool: ToolSpec<Input> = {
  name: "mktemp",
  description:
    "Create a unique temporary file or directory with Linux `mktemp` semantics (`-d`, `-p`, `-t`). " +
    "The default directory is the OS temp directory.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const dir = path.resolve(input.tmpdir ?? ctx.tmpdir);
    const template = input.template ?? "tmp.XXXXXXXXXX";
    const tail = /X+$/.exec(template)?.[0] ?? "";
    if (tail.length < 3) throw new FsError("template must end with at least three X characters.", "invalid");
    await ctx.permission.assertTrusted([path.join(dir, "*")]);

    if (input.directory === true) {
      try {
        await fs.mkdir(dir, { recursive: true });
        const created = await fs.mkdtemp(path.join(dir, template.slice(0, -tail.length)));
        const result = input.suffix === undefined ? created : `${created}${input.suffix}`;
        if (input.suffix !== undefined) await fs.rename(created, result);
        return textResult(`${result}\n`, { path: result, directory: true });
      } catch (error) {
        throw fromErrno(error);
      }
    }

    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      throw fromErrno(error);
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = path.join(dir, template.slice(0, -tail.length) + randomToken(tail.length));
      try {
        const handle = await fs.open(candidate, "wx", 0o600);
        await handle.close();
        const result = input.suffix === undefined ? candidate : `${candidate}${input.suffix}`;
        if (input.suffix !== undefined) await fs.rename(candidate, result);
        return textResult(`${result}\n`, { path: result, directory: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
        throw fromErrno(error);
      }
    }
    throw new FsError("could not create a unique temporary path.", "exists");
  },
};

function randomToken(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}
