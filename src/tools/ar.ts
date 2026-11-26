/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { num } from "../core/fsutil.js";
import { mapLimit } from "../core/parallel.js";
import {
  assertArchivePlan,
  outputBoundary,
  resolveArchiveTarget,
  resolveOutputTarget,
  safeMode,
  throwIfAborted,
  writeOutput,
} from "../core/safe-output.js";
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
      ? await resolveOutputTarget(ctx.sandbox, input.archive)
      : await ctx.sandbox.resolveFollow(input.archive);
    await ctx.permission.assert([{ target: archive, boundary: outputBoundary(archive.full) }]);

    if (input.mode === "create") {
      if (input.paths === undefined || input.paths.length === 0) {
        throw new FsError("create requires paths.", "invalid");
      }
      const members: Member[] = [];
      for (const requested of input.paths) {
        throwIfAborted(ctx.signal);
        const target = await ctx.sandbox.resolveFollow(requested);
        await ctx.permission.assert([{ target, boundary: outputBoundary(target.full) }]);
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
      throwIfAborted(ctx.signal);
      await writeOutput(archive.full, encode(members), false, 0o666, ctx.signal);
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

    const root = input.directory === undefined
      ? await resolveOutputTarget(ctx.sandbox, ".")
      : await resolveOutputTarget(ctx.sandbox, input.directory);
    const planned = await mapLimit(selected, ctx.concurrency, async (member) => {
      throwIfAborted(ctx.signal);
      const target = await resolveArchiveTarget(
        ctx.sandbox,
        root.full,
        path.join(root.full, safeName(member.name)),
        "file",
      );
      return { member, target, kind: "file" as const };
    }, ctx.signal);
    throwIfAborted(ctx.signal);
    await assertArchivePlan(ctx.permission, planned, { target: root, boundary: root.full });
    for (const { member, target } of planned) {
      throwIfAborted(ctx.signal);
      /* v8 ignore next 4 -- write errors are environment-dependent */
      try {
        await fs.mkdir(path.dirname(target.full), { recursive: true });
      } catch (error) {
        throw fromErrno(error);
      }
      const mode = safeMode(member.mode);
      await writeOutput(target.full, member.data, false, mode, ctx.signal, mode);
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
    const size = decimalField(header.slice(48, 58), "size");
    const dataStart = offset + 60;
    const next = dataStart + size + (size % 2);
    if (dataStart + size > data.length || next <= offset) {
      throw new FsError("Truncated ar member.", "archive");
    }
    if (name !== "" && name !== "/" && !name.startsWith("/")) {
      members.push({
        name,
        mtime: decimalField(header.slice(16, 28), "mtime", true),
        uid: decimalField(header.slice(28, 34), "uid", true),
        gid: decimalField(header.slice(34, 40), "gid", true),
        mode: octalField(header.slice(40, 48)),
        data: data.subarray(dataStart, dataStart + size),
      });
    }
    offset = next;
  }
  return members;
}

function decimalField(field: string, label: string, blankDefault = false): number {
  const text = field.trim();
  if (text === "") {
    if (blankDefault) return 0;
    throw new FsError(`Invalid ar ${label} field.`, "archive");
  }
  if (!/^\d+$/.test(text)) throw new FsError(`Invalid ar ${label} field.`, "archive");
  return Number(text);
}

function octalField(field: string): number {
  const text = field.trim();
  if (text === "") return 0o644;
  if (!/^[0-7]+$/.test(text)) throw new FsError("Invalid ar mode field.", "archive");
  return Number.parseInt(text, 8);
}

function safeName(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new FsError(`Unsafe archive member: "${name}".`, "archive");
  }
  return parts.join("/");
}
