/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, errnoCode, fromErrno } from "../core/errors.js";
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
    const template = input.template ?? "tmp.XXXXXXXXXX";
    const tail = /X+$/.exec(template)?.[0] ?? "";
    if (tail.length < 3) throw new FsError("template must end with at least three X characters.", "invalid");
    assertComponent(template, "template");
    if (input.suffix !== undefined) assertComponent(input.suffix, "suffix");

    const userTarget = input.tmpdir === undefined
      ? undefined
      : await ctx.sandbox.resolveForWrite(input.tmpdir);
    const dir = userTarget?.full ?? path.resolve(ctx.tmpdir);
    if (userTarget === undefined) {
      await ctx.permission.assertTrusted([path.join(dir, "*")]);
    } else {
      const relative = ctx.sandbox.resource(dir);
      await ctx.permission.assert([
        {
          target: { ...userTarget, full: path.join(dir, "*") },
          boundary: dir,
          resource: relative === "." ? "./*" : `${relative}/*`,
        },
      ]);
    }

    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      /* v8 ignore next */
      throw fromErrno(error);
    }

    const prefix = template.slice(0, -tail.length);
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = path.join(dir, `${prefix}${randomToken(tail.length)}${input.suffix ?? ""}`);
      try {
        if (input.directory === true) {
          await fs.mkdir(candidate, { mode: 0o700 });
        } else {
          const handle = await fs.open(candidate, "wx", 0o600);
          await handle.close();
        }
        return textResult(`${candidate}\n`, { path: candidate, directory: input.directory === true });
      } catch (error) {
        if (errnoCode(error) === "EEXIST") continue;
        throw fromErrno(error);
      }
    }
    throw new FsError("could not create a unique temporary path.", "exists");
  },
};

function assertComponent(value: string, label: string): void {
  if (
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new FsError(`${label} must be a single path component.`, "invalid");
  }
}

function randomToken(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}
