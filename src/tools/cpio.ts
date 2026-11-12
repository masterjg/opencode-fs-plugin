/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { num, walkAll } from "../core/fsutil.js";
import { collect } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    mode: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("extract")], {
      description: "Operation (`-o`, `-t`, `-i`).",
    }),
    archive: Type.String({ minLength: 1, description: "Archive path (`-F`)." }),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Members to create." })),
    directory: Type.Optional(Type.String({ description: "Base directory for member names or extraction." })),
    members: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Only these members." })),
    input: Type.Optional(Type.String({ description: "Text data to archive when paths are omitted." })),
    member: Type.Optional(Type.String({ description: "Archive member name for stream input." })),
    verbose: Type.Optional(Type.Boolean({ description: "List processed members (`-v`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface Entry {
  readonly name: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly mtime: number;
  readonly data: Buffer;
}

export const cpioTool: ToolSpec<Input> = {
  name: "cpio",
  description:
    "Create, list, or extract newc cpio archives (`-o`, `-t`, `-i`); supports stdin create and traversal-safe extraction.",
  schema: Schema,
  pipeable: "sink",
  mutates: true,
  async run(ctx, input, io) {
    const archive = input.mode === "create"
      ? await ctx.sandbox.resolveForCreate(input.archive)
      : await ctx.sandbox.resolveFollow(input.archive);
    await ctx.permission.assert([{ target: archive, boundary: archive.full }]);

    if (input.mode === "create") {
      const entries = await collectEntries(ctx, input, io);
      const buffer = encode(entries);
      /* v8 ignore next 4 -- write errors are environment-dependent */
      try {
        await fs.writeFile(archive.full, buffer);
      } catch (error) {
        throw fromErrno(error);
      }
      return textResult(input.verbose === true ? `${entries.map((entry) => entry.name).join("\n")}\n` : "", {
        archive: input.archive,
        members: entries.length,
      });
    }

    let data: Buffer;
    /* v8 ignore next 4 -- read errors are environment-dependent */
    try {
      data = await fs.readFile(archive.full);
    } catch (error) {
      throw fromErrno(error);
    }
    const entries = decode(data);
    const wanted = input.members === undefined ? undefined : new Set(input.members);
    const selected = wanted === undefined ? entries : entries.filter((entry) => wanted.has(entry.name));

    if (input.mode === "list") {
      return textResult(`${selected.map((entry) => entry.name).join("\n")}\n`, { members: selected.length });
    }

    const base = input.directory === undefined
      ? (await ctx.sandbox.resolveForCreate(".")).full
      : (await ctx.sandbox.resolveForCreate(input.directory)).full;
    for (const entry of selected) {
      const target = path.join(base, safeName(entry.name));
      await ctx.permission.assert([{
        target: { full: target, outside: false, requested: target, realAncestor: base },
        boundary: target,
      }]);
    }
    for (const entry of selected) {
      const target = path.join(base, safeName(entry.name));
      /* v8 ignore next -- extraction write errors are environment-dependent */
      try {
        if ((entry.mode & 0o170000) === 0o040000) {
          await fs.mkdir(target, { recursive: true });
        } else if ((entry.mode & 0o170000) === 0o120000) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.symlink(entry.data.toString("utf8"), target);
        } else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, entry.data);
          await fs.chmod(target, entry.mode & 0o7777);
        }
      } catch (error) {
        throw fromErrno(error);
      }
    }
    return textResult(input.verbose === true ? `${selected.map((entry) => entry.name).join("\n")}\n` : "", {
      extracted: selected.length,
    });
  },
};

async function collectEntries(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  input: Input,
  io: Parameters<ToolSpec<Input>["run"]>[2],
): Promise<Entry[]> {
  if (input.paths === undefined || input.paths.length === 0) {
    if (input.input === undefined && io.stdin === undefined) {
      throw new FsError("create requires paths, input, or stdin.", "invalid");
    }
    const data = io.stdin === undefined
      ? Buffer.from(input.input as string, "utf8")
      : await collect(io.stdin);
    const name = safeName(input.member ?? "stdin");
    return [{ name, mode: 0o100644, uid: 0, gid: 0, mtime: now(), data }];
  }

  const base = input.directory === undefined
    ? ctx.sandbox.root
    : (await ctx.sandbox.resolveExisting(input.directory, { allowRoot: true })).full;
  const entries: Entry[] = [];
  for (const requested of input.paths) {
    const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
    await ctx.permission.assert([{ target, boundary: target.full }]);
    const stats = await ctx.sandbox.lstat(target.full, requested);
    entries.push(await entryFor(target.full, path.relative(base, target.full), stats));
    if (stats.isDirectory()) {
      for (const child of await walkAll(target.full, {
        recursive: true,
        includeHidden: true,
        concurrency: ctx.concurrency,
        signal: ctx.signal,
      })) {
        entries.push(await entryFor(child.path, path.relative(base, child.path), child.stats));
      }
    }
  }
  return entries;
}

async function entryFor(
  full: string,
  name: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
): Promise<Entry> {
  const data = stats.isSymbolicLink()
    ? Buffer.from(await fs.readlink(full), "utf8")
    : stats.isFile()
      ? await fs.readFile(full)
      : Buffer.alloc(0);
  return {
    name: name.split(path.sep).join("/"),
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    mtime: Math.floor(num(stats.mtimeMs) / 1000),
    data,
  };
}

function encode(entries: readonly Entry[]): Buffer {
  const chunks: Buffer[] = [];
  let inode = 1;
  for (const entry of entries) {
    const name = Buffer.from(`${entry.name}\0`, "utf8");
    const header = [
      "070701",
      octal(inode++),
      octal(entry.mode),
      octal(entry.uid),
      octal(entry.gid),
      octal(1),
      octal(entry.mtime),
      octal(entry.data.length),
      octal(0),
      octal(0),
      octal(0),
      octal(0),
      octal(name.length),
      octal(0),
    ].join("");
    chunks.push(Buffer.from(header, "ascii"), name, pad4(name.length), entry.data, pad4(entry.data.length));
  }
  const trailer = Buffer.from("TRAILER!!!\0", "utf8");
  chunks.push(
    Buffer.from(
      ["070701", octal(0), octal(0), octal(0), octal(0), octal(1), octal(now()), octal(0), octal(0), octal(0), octal(0), octal(0), octal(trailer.length), octal(0)].join(""),
      "ascii",
    ),
    trailer,
    pad4(trailer.length),
  );
  return Buffer.concat(chunks);
}

function decode(data: Buffer): Entry[] {
  const entries: Entry[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 110 > data.length) throw new FsError("Truncated cpio header.", "archive");
    if (data.subarray(offset, offset + 6).toString("ascii") !== "070701") {
      throw new FsError("Unsupported cpio format.", "archive");
    }
    const field = (index: number): number => Number.parseInt(data.subarray(offset + 6 + index * 8, offset + 14 + index * 8).toString("ascii"), 8);
    const mode = field(1);
    const uid = field(2);
    const gid = field(3);
    const mtime = field(5);
    const size = field(6);
    const nameSize = field(11);
    const nameStart = offset + 110;
    const name = data.subarray(nameStart, nameStart + nameSize - 1).toString("utf8");
    const dataStart = nameStart + nameSize + align4(nameSize);
    if (name === "TRAILER!!!") return entries;
    entries.push({ name, mode, uid, gid, mtime, data: data.subarray(dataStart, dataStart + size) });
    offset = dataStart + size + align4(size);
  }
}

function safeName(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new FsError(`Unsafe archive member: "${name}".`, "archive");
  }
  return parts.join("/");
}

function octal(value: number): string {
  return value.toString(8).padStart(8, "0").slice(-8);
}

function align4(value: number): number {
  return (4 - (value % 4)) % 4;
}

function pad4(value: number): Buffer {
  return Buffer.alloc(align4(value), 0);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
