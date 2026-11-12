/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ZipFile as ZipWriter } from "yazl";
import * as yauzl from "yauzl";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { collect } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const ZipSchema = Type.Object(
  {
    archive: Type.String({ minLength: 1, description: "ZIP archive to create." }),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    level: Type.Optional(Type.Integer({ minimum: 0, maximum: 9, description: "Compression level." })),
    input: Type.Optional(Type.String({ description: "Text data to archive when paths are omitted." })),
    member: Type.Optional(Type.String({ description: "Archive member name for stream input." })),
  },
  { additionalProperties: false },
);

const UnzipSchema = Type.Object(
  {
    archive: Type.String({ minLength: 1, description: "ZIP archive to read." }),
    mode: Type.Optional(
      Type.Union([Type.Literal("extract"), Type.Literal("list")], { description: "Operation. Default: extract." }),
    ),
    directory: Type.Optional(Type.String({ description: "Destination directory (`-d`)." })),
    overwrite: Type.Optional(Type.Boolean({ description: "Overwrite existing files (`-o`)." })),
    noOverwrite: Type.Optional(Type.Boolean({ description: "Never overwrite (`-n`)." })),
  },
  { additionalProperties: false },
);

type ZipInput = Static<typeof ZipSchema>;
type UnzipInput = Static<typeof UnzipSchema>;

export const zipTool: ToolSpec<ZipInput> = {
  name: "zip",
  description: "Create ZIP archives with common `zip` semantics (`-r` is implicit, compression level 0-9).",
  schema: ZipSchema,
  pipeable: "sink",
  mutates: true,
  async run(ctx, input, io) {
    const archive = await ctx.sandbox.resolveForCreate(input.archive);
    const requestedPaths = input.paths ?? [];
    if (requestedPaths.length === 0) {
      if (input.input === undefined && io.stdin === undefined) {
        throw new FsError("create requires paths, input, or stdin.", "invalid");
      }
      const data = io.stdin === undefined
        ? Buffer.from(input.input as string, "utf8")
        : await collect(io.stdin);
      const name = safeName(input.member ?? "stdin");
      if (name === undefined) throw new FsError("member must not be empty.", "invalid");
      await ctx.permission.assert([{ target: archive, boundary: archive.full }]);
      const writer = new ZipWriter();
      writer.addBuffer(data, name.split(path.sep).join("/"), {
        mtime: new Date(),
        mode: 0o644,
        compress: (input.level ?? 6) !== 0,
        compressionLevel: input.level ?? 6,
      });
      writer.end();
      const streamed = await collect(writer.outputStream as AsyncIterable<Buffer>);
      /* v8 ignore next */
      await fs.writeFile(archive.full, streamed).catch((error) => {
        throw fromErrno(error);
      });
      return textResult("", { archive: input.archive, members: 1 });
    }

    const members: Array<{ name: string; full: string; stats: Awaited<ReturnType<typeof fs.lstat>> }> = [];
    for (const requested of requestedPaths) {
      const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      const stats = await ctx.sandbox.lstat(target.full, requested);
      const base = path.basename(path.resolve(requested));
      members.push({ name: base, full: target.full, stats });
      if (stats.isDirectory()) await collectMembers(target.full, base, members);
    }
    const entries = await Promise.all(
      members.map(async (member) => ({
        target: await ctx.sandbox.resolveExisting(member.full, { allowRoot: true }),
        boundary: member.stats.isDirectory() ? member.full : path.dirname(member.full),
      })),
    );
    await ctx.permission.assert([...entries, { target: archive, boundary: archive.full }]);

    const writer = new ZipWriter();
    for (const member of members) {
      const name = member.name.split(path.sep).join("/");
      if (member.stats.isDirectory()) {
        /* v8 ignore next */
        writer.addEmptyDirectory(name.endsWith("/") ? name : `${name}/`, {
          mtime: member.stats.mtime,
          mode: Number(member.stats.mode) & 0o7777,
        });
      } else if (member.stats.isSymbolicLink()) {
        writer.addBuffer(Buffer.from(await fs.readlink(member.full)), name, {
          mtime: member.stats.mtime,
          mode: 0o120777,
          compress: true,
        });
      } else {
        writer.addFile(member.full, name, {
          mtime: member.stats.mtime,
          mode: Number(member.stats.mode) & 0o7777,
          compress: (input.level ?? 6) !== 0,
          compressionLevel: input.level ?? 6,
        });
      }
    }
    writer.end();
    const data = await collect(writer.outputStream as AsyncIterable<Buffer>);
    /* v8 ignore next */
    await fs.writeFile(archive.full, data).catch((error) => {
      throw fromErrno(error);
    });
    return textResult("", { archive: input.archive, members: members.length });
  },
};

export const unzipTool: ToolSpec<UnzipInput> = {
  name: "unzip",
  description: "List or extract ZIP archives with common `unzip` semantics (`-l`, `-d`, `-o`, `-n`).",
  schema: UnzipSchema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    const archive = await ctx.sandbox.resolveExisting(input.archive, { allowRoot: true });
    await ctx.permission.assert([{ target: archive, boundary: archive.full }]);
    /* v8 ignore next */
    const buffer = await fs.readFile(archive.full).catch((error) => {
      throw fromErrno(error);
    });
    const zip = await openZip(buffer);
    const names: string[] = [];
    const rootTarget = input.directory === undefined
      ? await ctx.sandbox.resolveForCreate(".")
      : await ctx.sandbox.resolveForCreate(input.directory);
    const root = rootTarget.full;
    if (input.mode === "list") {
      for (const entry of zip.entries) names.push(entry.fileName);
      return textResult(names.map((name) => `${name}\n`).join(""), { archive: input.archive, members: names });
    }
    await ctx.permission.assert([{ target: rootTarget, boundary: root }]);
    await fs.mkdir(root, { recursive: true });
    for (const entry of zip.entries) {
      const name = safeName(entry.fileName);
      /* v8 ignore next */
      if (name === undefined) continue;
      const destination = path.join(root, name);
      /* v8 ignore next */
      if (!isInside(root, destination)) throw new FsError(`Blocked archive path: ${entry.fileName}`, "archive");
      if (entry.fileName.endsWith("/")) {
        await fs.mkdir(destination, { recursive: true });
        continue;
      }
      if (input.noOverwrite === true && (await exists(destination))) continue;
      if (input.overwrite !== true && (await exists(destination))) {
        throw new FsError(`File exists: "${destination}"`, "exists");
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const mode = (entry.externalFileAttributes >>> 16) & 0o170777;
      const data = await collect(await openEntry(zip.file, entry));
      if ((mode & 0o170000) === 0o120000) {
        const target = data.toString("utf8");
        /* v8 ignore next */
        if (path.isAbsolute(target) || target.split("/").includes("..")) {
          throw new FsError(`Blocked symlink target: ${target}`, "archive");
        }
        await fs.symlink(target, destination);
      } else {
        await fs.writeFile(destination, data, { mode: mode & 0o7777 });
      }
      names.push(name);
    }
    zip.file.close();
    return textResult("", { archive: input.archive, members: names });
  },
};

async function collectMembers(
  full: string,
  name: string,
  members: Array<{ name: string; full: string; stats: Awaited<ReturnType<typeof fs.lstat>> }>,
): Promise<void> {
  const entries = await fs.readdir(full);
  for (const entry of entries) {
    const child = path.join(full, entry);
    const member = `${name}/${entry}`;
    const stats = await fs.lstat(child);
    members.push({ name: member, full: child, stats });
    if (stats.isDirectory()) await collectMembers(child, member, members);
  }
}

interface ZipContents {
  file: yauzl.ZipFile;
  entries: yauzl.Entry[];
}

async function openZip(buffer: Buffer): Promise<ZipContents> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, file) => {
      /* v8 ignore next */
      if (error || !file) {
        reject(fromErrno(error ?? new Error("Cannot open zip")));
        return;
      }
      const entries: yauzl.Entry[] = [];
      file.on("entry", (entry: yauzl.Entry) => {
        entries.push(entry);
        file.readEntry();
      });
      file.on("end", () => resolve({ file, entries }));
      /* v8 ignore next */
      file.on("error", (zipError: Error) => reject(fromErrno(zipError)));
      file.readEntry();
    });
  });
}

async function openEntry(file: yauzl.ZipFile, entry: yauzl.Entry): Promise<AsyncIterable<Buffer>> {
  return new Promise((resolve, reject) => {
    file.openReadStream(entry, (error, stream) => {
      /* v8 ignore next */
      if (error || !stream) reject(fromErrno(error ?? new Error("Cannot open entry")));
      else resolve(stream as AsyncIterable<Buffer>);
    });
  });
}

function safeName(name: string): string | undefined {
  /* v8 ignore next */
  if (name.includes("\0") || path.isAbsolute(name)) throw new FsError(`Blocked archive path: ${name}`, "archive");
  const parts = name.split("/").filter((part) => part.length > 0);
  /* v8 ignore next */
  if (parts.some((part) => part === "..")) throw new FsError(`Blocked archive path: ${name}`, "archive");
  /* v8 ignore next */
  return parts.length === 0 ? undefined : parts.join(path.sep);
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}
