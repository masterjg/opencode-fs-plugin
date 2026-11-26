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
import { walkAll } from "../core/fsutil.js";
import { mapLimit } from "../core/parallel.js";
import {
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
  description:
    "Create ZIP archives with common `zip` semantics (`-r` is implicit, compression level 0-9). " +
    "Accepts `input`/`member` stream data and can consume pipe stdin.",
  schema: ZipSchema,
  pipeable: "sink",
  mutates: true,
  async run(ctx, input, io) {
    const archive = await resolveOutputTarget(ctx.sandbox, input.archive);
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
      await ctx.permission.assert([{ target: archive, boundary: outputBoundary(archive.full) }]);
      const writer = new ZipWriter();
      writer.addBuffer(data, name.split(path.sep).join("/"), {
        mtime: new Date(),
        mode: 0o644,
        compress: (input.level ?? 6) !== 0,
        compressionLevel: input.level ?? 6,
      });
      writer.end();
      const streamed = await collect(writer.outputStream as AsyncIterable<Buffer>);
      await writeOutput(archive.full, streamed, false, 0o666, ctx.signal);
      return textResult("", { archive: input.archive, members: 1 });
    }

    const members: Array<{ name: string; full: string; stats: Awaited<ReturnType<typeof fs.lstat>> }> = [];
    for (const requested of requestedPaths) {
      throwIfAborted(ctx.signal);
      const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
      const stats = await ctx.sandbox.lstat(target.full, requested);
      const base = path.basename(path.resolve(requested));
      members.push({ name: base, full: target.full, stats });
      if (stats.isDirectory()) {
        await collectMembers(target.full, base, members, ctx.concurrency, ctx.signal);
      }
    }
    const entries = await mapLimit(
      members,
      ctx.concurrency,
      async (member) => ({
        target: await ctx.sandbox.resolveExisting(member.full, { allowRoot: true }),
        boundary: member.stats.isDirectory() ? member.full : path.dirname(member.full),
      }),
      ctx.signal,
    );
    await ctx.permission.assert([...entries, { target: archive, boundary: outputBoundary(archive.full) }]);

    const writer = new ZipWriter();
    for (const member of members) {
      throwIfAborted(ctx.signal);
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
    await writeOutput(archive.full, data, false, 0o666, ctx.signal);
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
    const archive = await ctx.sandbox.resolveFollow(input.archive);
    await ctx.permission.assert([{ target: archive, boundary: outputBoundary(archive.full) }]);
    /* v8 ignore next */
    const buffer = await fs.readFile(archive.full).catch((error) => {
      throw fromErrno(error);
    });
    const zip = await openZip(buffer);
    const names: string[] = [];
    const rootTarget = input.directory === undefined
      ? await resolveOutputTarget(ctx.sandbox, ".")
      : await resolveOutputTarget(ctx.sandbox, input.directory);
    const root = rootTarget.full;
    if (input.mode === "list") {
      for (const entry of zip.entries) {
        throwIfAborted(ctx.signal);
        names.push(entry.fileName);
      }
      return textResult(names.map((name) => `${name}\n`).join(""), { archive: input.archive, members: names });
    }
    const planned: Array<{
      entry: yauzl.Entry;
      name: string;
      kind: "file" | "directory" | "symlink";
      target: Awaited<ReturnType<typeof resolveArchiveTarget>>;
      linkname: string | undefined;
      mode: number;
    }> = [];
    const plannedPaths = new Set<string>();
    for (const entry of zip.entries) {
      throwIfAborted(ctx.signal);
      const name = safeName(entry.fileName);
      /* v8 ignore next */
      if (name === undefined) continue;
      const unixMode = entry.externalFileAttributes >>> 16;
      const hasUnixMode = unixMode !== 0;
      const kind = entry.fileName.endsWith("/")
        ? "directory"
        : hasUnixMode && (unixMode & 0o170000) === 0o120000
          ? "symlink"
          : "file";
      const mode = hasUnixMode ? unixMode & 0o7777 : kind === "directory" ? 0o755 : 0o644;
      const target = await resolveArchiveTarget(
        ctx.sandbox,
        root,
        path.join(root, name),
        kind,
      );
      if (kind !== "directory") {
        if (input.noOverwrite === true && (plannedPaths.has(target.full) || (await exists(target.full)))) {
          continue;
        }
        if (input.overwrite !== true && (await exists(target.full))) {
          throw new FsError(`File exists: "${target.full}"`, "exists");
        }
      }
      let linkname: string | undefined;
      if (kind === "symlink") {
        linkname = (await collect(await openEntry(zip.file, entry))).toString("utf8");
        assertSafeLinkTarget(linkname);
      }
      plannedPaths.add(target.full);
      planned.push({ entry, name, kind, target, linkname, mode });
    }
    throwIfAborted(ctx.signal);
    assertArchiveSymlinkPlan(planned);
    await assertArchivePlan(ctx.permission, planned, { target: rootTarget, boundary: root });
    await fs.mkdir(root, { recursive: true });
    for (const item of planned) {
      throwIfAborted(ctx.signal);
      if (item.kind === "directory") {
        await fs.mkdir(item.target.full, { recursive: true });
      } else if (item.kind === "symlink") {
        await fs.mkdir(path.dirname(item.target.full), { recursive: true });
        await fs.symlink(item.linkname as string, item.target.full);
      } else {
        const data = await collect(await openEntry(zip.file, item.entry));
        await fs.mkdir(path.dirname(item.target.full), { recursive: true });
        const mode = safeMode(item.mode);
        await writeOutput(
          item.target.full,
          data,
          false,
          mode,
          ctx.signal,
          mode,
        );
      }
      names.push(item.name);
    }
    const directories = finalDirectoryPlans(planned);
    for (const item of directories) {
      throwIfAborted(ctx.signal);
      await chmodDirectoryNoFollow(item.target.full, safeDirectoryMode(item.mode));
    }
    zip.file.close();
    return textResult("", { archive: input.archive, members: names });
  },
};

async function collectMembers(
  full: string,
  name: string,
  members: Array<{ name: string; full: string; stats: Awaited<ReturnType<typeof fs.lstat>> }>,
  concurrency: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const walked = await walkAll(full, {
    recursive: true,
    includeHidden: true,
    concurrency,
    signal,
  });
  for (const entry of walked) {
    const relative = path.relative(full, entry.path).split(path.sep).join("/");
    members.push({ name: `${name}/${relative}`, full: entry.path, stats: entry.stats });
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



async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}
