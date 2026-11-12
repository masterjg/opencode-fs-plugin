/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { num } from "../core/fsutil.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    mode: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("extract")], {
      description: "Operation.",
    }),
    archive: Type.String({ minLength: 1, description: "Archive path." }),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to archive (create)." })),
    directory: Type.Optional(Type.String({ description: "Extraction directory. Default: current." })),
    members: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Only these members." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface Member {
  readonly name: string;
  readonly mode: number;
  readonly mtime: number;
  readonly uid: number;
  readonly gid: number;
  readonly data: Buffer;
}

const MAGIC = "!<arch>\n";

export const arTool: ToolSpec<Input> = {
  name: "ar",
  description:
    "Create, list, or extract Unix `ar` archives (GNU short names, mode and mtime preserved on create).",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const archive = input.mode === "create"
      ? await ctx.sandbox.resolveForCreate(input.archive)
      : await ctx.sandbox.resolveFollow(input.archive);
    await ctx.permission.assert([{ target: archive, boundary: archive.full }]);

    if (input.mode === "create") {
      if (input.paths === undefined || input.paths.length === 0) {
        throw new FsError("create requires paths.", "invalid");
      }
      const members: Member[] = [];
      for (const requested of input.paths) {
        const target = await ctx.sandbox.resolveFollow(requested);
        await ctx.permission.assert([{ target, boundary: target.full }]);
        const stats = await ctx.sandbox.stat(target.full, requested);
        if (!stats.isFile()) throw new FsError(`Not a regular file: "${requested}".`, "not-file");
        const name = path.basename(requested);
        if (Buffer.byteLength(name) > 16) {
          throw new FsError(`Member name too long for the short ar format: "${name}".`, "invalid");
        }
        members.push({
          name,
          mode: Number(stats.mode) & 0o7777,
          mtime: Math.floor(num(stats.mtimeMs) / 1000),
          uid: Number(stats.uid),
          gid: Number(stats.gid),
          /* v8 ignore next 3 -- reading a stat-ed file normally succeeds */
          data: await fs.readFile(target.full).catch((error: unknown) => {
            throw fromErrno(error);
          }),
        });
      }
      /* v8 ignore next 4 -- write errors are environment-dependent */
      try {
        await fs.writeFile(archive.full, encode(members));
      } catch (error) {
        throw fromErrno(error);
      }
      return textResult("", { archive: input.archive, members: members.map((member) => member.name) });
    }

    let data: Buffer;
    /* v8 ignore next 4 -- read errors are environment-dependent */
    try {
      data = await fs.readFile(archive.full);
    } catch (error) {
      throw fromErrno(error);
    }
    const all = decode(data);
    const wanted = input.members === undefined ? undefined : new Set(input.members);
    const selected = wanted === undefined ? all : all.filter((member) => wanted.has(member.name));

    if (input.mode === "list") {
      return textResult(`${selected.map((member) => member.name).join("\n")}\n`, { members: selected.length });
    }

    const base = input.directory === undefined
      ? (await ctx.sandbox.resolveForCreate(".")).full
      : (await ctx.sandbox.resolveForCreate(input.directory)).full;
    for (const member of selected) {
      const target = path.join(base, safeName(member.name));
      await ctx.permission.assert([{
        target: { full: target, outside: false, requested: target, realAncestor: base },
        boundary: target,
      }]);
      /* v8 ignore next 5 -- write errors are environment-dependent */
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, member.data);
        await fs.chmod(target, member.mode);
      } catch (error) {
        throw fromErrno(error);
      }
    }
    return textResult("", { extracted: selected.length });
  },
};

function encode(members: readonly Member[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(MAGIC, "ascii")];
  for (const member of members) {
    const header = [
      `${member.name}/`.padEnd(16, " "),
      String(member.mtime).padStart(12, " ").slice(-12),
      String(member.uid).padStart(6, " ").slice(-6),
      String(member.gid).padStart(6, " ").slice(-6),
      member.mode.toString(8).padStart(8, " ").slice(-8),
      String(member.data.length).padStart(10, " ").slice(-10),
      "`\n",
    ].join("");
    chunks.push(Buffer.from(header, "ascii"), member.data);
    if (member.data.length % 2 === 1) chunks.push(Buffer.from("\n", "ascii"));
  }
  return Buffer.concat(chunks);
}

function decode(data: Buffer): Member[] {
  if (data.subarray(0, MAGIC.length).toString("ascii") !== MAGIC) {
    throw new FsError("Not an ar archive.", "archive");
  }
  const members: Member[] = [];
  let offset = MAGIC.length;
  while (offset + 60 <= data.length) {
    const header = data.subarray(offset, offset + 60).toString("ascii");
    if (header.slice(58, 60) !== "`\n") throw new FsError("Corrupt ar header.", "archive");
    const name = header.slice(0, 16).trim().replace(/\/$/, "");
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    const dataStart = offset + 60;
    if (Number.isNaN(size) || dataStart + size > data.length) {
      throw new FsError("Truncated ar member.", "archive");
    }
    if (name !== "" && name !== "/" && !name.startsWith("/")) {
      members.push({
        name,
        mtime: Number.parseInt(header.slice(16, 28).trim(), 10) || 0,
        uid: Number.parseInt(header.slice(28, 34).trim(), 10) || 0,
        gid: Number.parseInt(header.slice(34, 40).trim(), 10) || 0,
        mode: Number.parseInt(header.slice(40, 48).trim(), 8) || 0o644,
        data: data.subarray(dataStart, dataStart + size),
      });
    }
    offset = dataStart + size + (size % 2);
  }
  return members;
}

function safeName(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new FsError(`Unsafe archive member: "${name}".`, "archive");
  }
  return parts.join("/");
}
