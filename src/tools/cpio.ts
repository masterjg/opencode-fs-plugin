/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { num, walkAll } from "../core/fsutil.js";
import { mapLimit } from "../core/parallel.js";
import {
  archiveSourceName,
  assertArchivePlan,
  assertArchiveSymlinkPlan,
  assertSafeLinkTarget,
  chmodDirectoryNoFollow,
  finalDirectoryPlans,
  outputBoundary,
  resolveArchiveTarget,
  resolveOutputTarget,
  safeDirectoryMode,
  safeMode,
  throwIfAborted,
  writeOutput,
} from "../core/safe-output.js";
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
      ? await resolveOutputTarget(ctx.sandbox, input.archive)
      : await ctx.sandbox.resolveFollow(input.archive);
    await ctx.permission.assert([{ target: archive, boundary: outputBoundary(archive.full) }]);

    if (input.mode === "create") {
      const entries = await collectEntries(ctx, input, io);
      throwIfAborted(ctx.signal);
      await writeOutput(archive.full, encode(entries), false, 0o666, ctx.signal);
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

    const root = input.directory === undefined
      ? await resolveOutputTarget(ctx.sandbox, ".")
      : await resolveOutputTarget(ctx.sandbox, input.directory);

    const plan = await mapLimit(selected, ctx.concurrency, async (entry) => {
      throwIfAborted(ctx.signal);
      const name = safeName(entry.name);
      const kind: "file" | "directory" | "symlink" = (entry.mode & 0o170000) === 0o040000
        ? "directory"
        : (entry.mode & 0o170000) === 0o120000
          ? "symlink"
          : "file";
      if (kind === "symlink") assertSafeLinkTarget(entry.data.toString("utf8"));
      const target = await resolveArchiveTarget(
        ctx.sandbox,
        root.full,
        path.join(root.full, name),
        kind,
      );
      return { entry, name, kind, target };
    }, ctx.signal);
    throwIfAborted(ctx.signal);
    assertArchiveSymlinkPlan(plan);
    await assertArchivePlan(ctx.permission, plan, { target: root, boundary: root.full });
    for (const { entry, kind, target } of plan) {
      throwIfAborted(ctx.signal);
      if (kind === "directory") {
        try {
          await fs.mkdir(target.full, { recursive: true });
        } catch (error) {
          throw fromErrno(error);
        }
      } else if (kind === "symlink") {
        /* v8 ignore next 3 -- extraction write errors are environment-dependent */
        try {
          await fs.mkdir(path.dirname(target.full), { recursive: true });
          await fs.symlink(entry.data.toString("utf8"), target.full);
        } catch (error) {
          throw fromErrno(error);
        }
      } else {
        /* v8 ignore next 3 -- extraction write errors are environment-dependent */
        try {
          await fs.mkdir(path.dirname(target.full), { recursive: true });
        } catch (error) {
          throw fromErrno(error);
        }
        const mode = safeMode(entry.mode);
        await writeOutput(target.full, entry.data, false, mode, ctx.signal, mode);
      }
    }
    const directories = finalDirectoryPlans(plan);
    for (const item of directories) {
      throwIfAborted(ctx.signal);
      await chmodDirectoryNoFollow(
        item.target.full,
        safeDirectoryMode(item.entry.mode),
      );
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
    throwIfAborted(ctx.signal);
    const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
    const stats = await ctx.sandbox.lstat(target.full, requested);
    await ctx.permission.assert([{
      target,
      boundary: ctx.sandbox.boundaryFor(target.full, stats.isDirectory() ? "directory" : "file"),
    }]);
    const name = archiveSourceName(requested, target.full, base, ctx.sandbox.root);
    entries.push(await entryFor(target.full, name, stats));
    if (stats.isDirectory()) {
      for (const child of await walkAll(target.full, {
        recursive: true,
        includeHidden: true,
        concurrency: ctx.concurrency,
        signal: ctx.signal,
      })) {
        throwIfAborted(ctx.signal);
        const childName = path.join(name, path.relative(target.full, child.path));
        entries.push(await entryFor(child.path, childName, child.stats));
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
      hexField(inode++),
      hexField(entry.mode),
      hexField(entry.uid),
      hexField(entry.gid),
      hexField(1),
      hexField(entry.mtime),
      hexField(entry.data.length),
      hexField(0),
      hexField(0),
      hexField(0),
      hexField(0),
      hexField(name.length),
      hexField(0),
    ].join("");
    chunks.push(Buffer.from(header, "ascii"), name, pad4(110 + name.length), entry.data, pad4(entry.data.length));
  }
  const trailer = Buffer.from("TRAILER!!!\0", "utf8");
  chunks.push(
    Buffer.from(
      ["070701", hexField(0), hexField(0), hexField(0), hexField(0), hexField(1), hexField(now()), hexField(0), hexField(0), hexField(0), hexField(0), hexField(0), hexField(trailer.length), hexField(0)].join(""),
      "ascii",
    ),
    trailer,
    pad4(110 + trailer.length),
  );
  return Buffer.concat(chunks);
}

function decode(data: Buffer): Entry[] {
  let firstError: unknown;
  try {
    return decodeWithPadding(data, false);
  } catch (error) {
    firstError = error;
  }
  try {
    return decodeWithPadding(data, true);
  } catch {
    throw firstError;
  }
}

function decodeWithPadding(data: Buffer, legacyNamePadding: boolean): Entry[] {
  const entries: Entry[] = [];
  let offset = 0;
  let radix: 8 | 16 | undefined;
  for (;;) {
    if (offset + 110 > data.length) throw new FsError("Truncated cpio header.", "archive");
    if (data.subarray(offset, offset + 6).toString("ascii") !== "070701") {
      throw new FsError("Unsupported cpio format.", "archive");
    }
    const decoded = decodeFields(data, offset, radix);
    radix ??= decoded.radix;
    const fields = decoded.fields;
    const mode = fields[1] as number;
    const uid = fields[2] as number;
    const gid = fields[3] as number;
    const mtime = fields[5] as number;
    const size = fields[6] as number;
    const nameSize = fields[11] as number;
    const nameStart = offset + 110;
    if (nameSize < 1 || nameStart + nameSize > data.length || data[nameStart + nameSize - 1] !== 0) {
      throw new FsError("Truncated cpio name.", "archive");
    }
    const namePadding = legacyNamePadding ? align4(nameSize) : align4(nameStart + nameSize);
    const dataStart = nameStart + nameSize + namePadding;
    if (dataStart > data.length || dataStart + size > data.length) {
      throw new FsError("Truncated cpio member.", "archive");
    }
    const name = data.subarray(nameStart, nameStart + nameSize - 1).toString("utf8");
    const dataPadding = legacyNamePadding ? align4(size) : align4(dataStart + size);
    if (name === "TRAILER!!!") {
      const trailerEnd = dataStart + size + dataPadding;
      if (data.subarray(trailerEnd).some((byte) => byte !== 0)) {
        throw new FsError("Trailing cpio data.", "archive");
      }
      return entries;
    }
    if ((mode & 0o170000) === 0) throw new FsError("Invalid cpio mode field.", "archive");
    const next = dataStart + size + dataPadding;
    if (next > data.length || next <= offset) throw new FsError("Truncated cpio member.", "archive");
    entries.push({ name, mode, uid, gid, mtime, data: data.subarray(dataStart, dataStart + size) });
    offset = next;
  }
}

/**
 * Newc stores every numeric field as eight hexadecimal digits. Archives written
 * by earlier releases of this plugin used octal, so a header whose hexadecimal
 * mode has no file-type bits is parsed as legacy octal instead.
 */
function decodeFields(
  data: Buffer,
  offset: number,
  preferred?: 8 | 16,
): { fields: number[]; radix: 8 | 16 } {
  const raw = (index: number): string =>
    data.subarray(offset + 6 + index * 8, offset + 14 + index * 8).toString("ascii");
  let radix = preferred;
  if (radix === undefined) {
    const modeText = raw(1);
    const hexMode = parseField(modeText, 16);
    radix = 16;
    if ((hexMode & 0xf000) === 0) {
      const octalMode = parseField(modeText, 8);
      if (hexMode === 0 && octalMode === 0) {
        const nameText = raw(11);
        const hexName = parseField(nameText, 16);
        const octalName = /^[0-7]{8}$/.test(nameText) ? Number.parseInt(nameText, 8) : undefined;
        if (nameFits(data, offset, hexName)) {
          radix = 16;
        } else if (octalName !== undefined && nameFits(data, offset, octalName)) {
          radix = 8;
        } else {
          throw new FsError("Truncated cpio name.", "archive");
        }
      } else if ((octalMode & 0o170000) !== 0) {
        radix = 8;
      } else {
        throw new FsError("Invalid cpio mode field.", "archive");
      }
    }
  }
  const fields = Array.from({ length: 13 }, (_, index) => parseField(raw(index), radix as 8 | 16));
  return { fields, radix };
}

function nameFits(data: Buffer, offset: number, size: number): boolean {
  const start = offset + 110;
  return size >= 1 && start + size <= data.length && data[start + size - 1] === 0;
}

function parseField(text: string, radix: 8 | 16): number {
  const valid = radix === 16 ? /^[0-9a-fA-F]{8}$/.test(text) : /^[0-7]{8}$/.test(text);
  if (!valid) throw new FsError("Invalid cpio numeric field.", "archive");
  return Number.parseInt(text, radix);
}

function safeName(name: string): string {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.includes("..")) {
    throw new FsError(`Unsafe archive member: "${name}".`, "archive");
  }
  return parts.join("/");
}

/** Encode one newc numeric field, rejecting values the format cannot hold. */
export function hexField(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new FsError(`cpio field out of range: ${value}`, "invalid");
  }
  return value.toString(16).padStart(8, "0");
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
