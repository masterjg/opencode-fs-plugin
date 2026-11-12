/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    force: Type.Optional(Type.Boolean({ description: "Trash even when a target looks unusual." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const trashTool: ToolSpec<Input> = {
  name: "trash",
  description:
    "Move files or directories to the XDG home trash instead of deleting them permanently. " +
    "Cross-filesystem moves are refused; use `rm` or a mount trash helper for those.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
    const trash = path.join(dataHome, "Trash");
    const filesDir = path.join(trash, "files");
    const infoDir = path.join(trash, "info");
    await ctx.permission.assertTrusted([`${trash}/*`]);
    try {
      await fs.mkdir(filesDir, { recursive: true });
      await fs.mkdir(infoDir, { recursive: true });
    } catch (error) {
      throw fromErrno(error);
    }

    const trashed: string[] = [];
    for (const requested of input.paths) {
      const target = await ctx.sandbox.resolveExisting(requested);
      ctx.sandbox.assertSafeToDelete(target.full);
      await ctx.permission.assert([{ target, boundary: target.full }]);
      const name = await uniqueName(filesDir, path.basename(target.full));
      const info = path.join(infoDir, `${name}.trashinfo`);
      const body = `[Trash Info]\nPath=${encodeURIComponent(target.full)}\nDeletionDate=${new Date().toISOString()}\n`;
      await fs.writeFile(info, body, { mode: 0o600 }).catch((error) => {
        throw fromErrno(error);
      });
      try {
        await fs.rename(target.full, path.join(filesDir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EXDEV") {
          await fs.unlink(info).catch(() => undefined);
          throw new FsError(`Cannot trash across filesystems: "${requested}".`, "cross-device");
        }
        throw fromErrno(error);
      }
      trashed.push(requested);
    }
    return textResult("", { trashed, trash });
  },
};

async function uniqueName(dir: string, base: string): Promise<string> {
  let candidate = base;
  for (let index = 1; ; index++) {
    try {
      await fs.lstat(path.join(dir, candidate));
      candidate = `${base}.${index}`;
    } catch {
      return candidate;
    }
  }
}
