/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzip as gzipBuffer, gunzip as gunzipBuffer } from "node:zlib";
import { promisify } from "node:util";
import * as tar from "tar-stream";
import picomatch from "picomatch";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { walkAll } from "../core/fsutil.js";
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
import type { ResolvedTarget } from "../core/sandbox.js";
import { collect } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const gzipAsync = promisify(gzipBuffer);
const gunzipAsync = promisify(gunzipBuffer);

const Schema = Type.Object(
  {
    mode: Type.Union([Type.Literal("create"), Type.Literal("extract"), Type.Literal("list")], {
      description: "Tar operation (`-c`, `-x`, `-t`).",
    }),
    archive: Type.String({ minLength: 1, description: "Archive path (`-f`)." }),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Members to create, or paths to list/extract." })),
    directory: Type.Optional(Type.String({ description: "Working directory (`-C`)." })),
    gzip: Type.Optional(Type.Boolean({ description: "Use gzip compression (`-z`). Inferred from .gz/.tgz." })),
    stripComponents: Type.Optional(Type.Integer({ minimum: 0, description: "Strip leading path components (`--strip-components`)." })),
    exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Exclude globs." })),
    verbose: Type.Optional(Type.Boolean({ description: "List processed members (`-v`)." })),
    input: Type.Optional(Type.String({ description: "Text data to archive when paths are omitted." })),
    member: Type.Optional(Type.String({ description: "Archive member name for stream input." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const tarTool: ToolSpec<Input> = {
  name: "tar",
  description:
    "Create, list or extract tar archives with common `tar` semantics (`-c`, `-x`, `-t`, `-f`, " +
    "`-z`, `-C`, `--strip-components`, `--exclude`). Create accepts `input`/`member` stream data " +
    "and can consume pipe stdin; extraction rejects path escapes.",
  schema: Schema,
  pipeable: "sink",
  mutates: true,
  async run(ctx, input, io) {
    const archive = input.mode === "create"
      ? await resolveOutputTarget(ctx.sandbox, input.archive)
      : await ctx.sandbox.resolveFollow(input.archive);
    const useGzip = input.gzip ?? /\.(?:tgz|tar\.gz)$/i.test(input.archive);
    const excludes = input.exclude === undefined ? undefined : picomatch(input.exclude, { dot: true, basename: true });
    const names: string[] = [];
    if (input.mode !== "create") {
      await ctx.permission.assert([{ target: archive, boundary: outputBoundary(archive.full) }]);
    }

    if (input.mode === "create") {
      if (input.paths === undefined || input.paths.length === 0) {
        if (input.input === undefined && io.stdin === undefined) {
          throw new FsError("create requires paths, input, or stdin.", "invalid");
        }
        const data = io.stdin === undefined
          ? Buffer.from(input.input as string, "utf8")
          : await collect(io.stdin);
        const name = safeMember(input.member ?? "stdin", 0);
        if (name === undefined) throw new FsError("member must not be empty.", "invalid");
        await ctx.permission.assert([{ target: archive, boundary: outputBoundary(archive.full) }]);
        const pack = tar.pack();
        const header: tar.Header = {
          name: name.split(path.sep).join("/"),
          size: data.length,
          mode: 0o644,
          mtime: new Date(),
          type: "file",
          linkname: "",
          uid: 0,
          gid: 0,
          uname: "",
          gname: "",
          devmajor: 0,
          devminor: 0,
        };
        pack.entry(header, data);
        pack.finalize();
        let buffer = await collect(pack as AsyncIterable<Buffer>);
        if (useGzip) buffer = await gzipAsync(buffer);
        await writeOutput(archive.full, buffer, false, 0o666, ctx.signal);
        return textResult(input.verbose === true ? `${header.name}\n` : "", {
          archive: input.archive,
          members: [header.name],
        });
      }
      const createBase = input.directory === undefined
        ? ctx.sandbox.root
        : (await ctx.sandbox.resolveFollow(input.directory)).full;
      const members: Array<{ name: string; full: string; stats: Awaited<ReturnType<typeof fs.lstat>> }> = [];
      for (const requested of input.paths) {
        throwIfAborted(ctx.signal);
        const source = path.isAbsolute(requested) ? requested : path.join(createBase, requested);
        const target = await ctx.sandbox.resolveExisting(source, { allowRoot: true });
        const stats = await ctx.sandbox.lstat(target.full, requested);
        const name = archiveSourceName(requested, target.full, createBase, ctx.sandbox.root);
        members.push({ name, full: target.full, stats });
        if (stats.isDirectory()) {
          await collectMembers(
            target.full,
            name,
            members,
            excludes,
            ctx.concurrency,
            ctx.signal,
          );
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
      const pack = tar.pack();
      for (const member of members) {
        throwIfAborted(ctx.signal);
        const header: tar.Header = {
          name: member.name.split(path.sep).join("/"),
          size: member.stats.isFile() ? Number(member.stats.size) : 0,
          mode: Number(member.stats.mode) & 0o7777,
          mtime: member.stats.mtime,
          type: member.stats.isDirectory() ? "directory" : member.stats.isSymbolicLink() ? "symlink" : "file",
          linkname: member.stats.isSymbolicLink() ? await fs.readlink(member.full) : "",
          uid: Number(member.stats.uid),
          gid: Number(member.stats.gid),
          uname: "",
          gname: "",
          devmajor: 0,
          devminor: 0,
        };
        if (member.stats.isFile()) {
          pack.entry(header, await fs.readFile(member.full));
        } else {
          pack.entry(header);
        }
        names.push(header.name);
      }
      pack.finalize();
      let buffer = await collect(pack as AsyncIterable<Buffer>);
      if (useGzip) buffer = await gzipAsync(buffer);
      await writeOutput(archive.full, buffer, false, 0o666, ctx.signal);
      return textResult(input.verbose === true ? names.map((name) => `${name}\n`).join("") : "", {
        archive: input.archive,
        members: names,
      });
    }

    /* v8 ignore next 3 */
    const raw = await fs.readFile(archive.full).catch((error) => {
      throw fromErrno(error);
    });
    /* v8 ignore next 3 */
    const buffer = useGzip ? await gunzipAsync(raw).catch((error) => {
      throw fromErrno(error);
    }) : raw;
    if (input.mode === "list") {
      const extract = tar.extract();
      extract.end(buffer);
      for await (const entry of extract) {
        throwIfAborted(ctx.signal);
        names.push(entry.header.name);
        await collect(entry as AsyncIterable<Buffer>);
      }
      return textResult(names.map((name) => `${name}\n`).join(""), { archive: input.archive, members: names });
    }

    const destTarget = input.directory === undefined
      ? await resolveOutputTarget(ctx.sandbox, ".")
      : await resolveOutputTarget(ctx.sandbox, input.directory);
    const destRoot = destTarget.full;
    const planned: Array<{
      header: tar.Header;
      data: Buffer;
      name: string;
      kind: "file" | "directory" | "symlink";
      target: ResolvedTarget;
    }> = [];
    const extract = tar.extract();
    extract.end(buffer);
    for await (const entry of extract) {
      throwIfAborted(ctx.signal);
      const name = safeMember(entry.header.name, input.stripComponents ?? 0);
      const data = await collect(entry as AsyncIterable<Buffer>);
      if (name === undefined) continue;
      const kind = entry.header.type === "directory"
        ? "directory"
        : entry.header.type === "symlink"
          ? "symlink"
          : "file";
      if (kind === "symlink") assertSafeLinkTarget(entry.header.linkname);
      const target = await resolveArchiveTarget(
        ctx.sandbox,
        destRoot,
        path.join(destRoot, name),
        kind,
      );
      planned.push({ header: entry.header, data, name, kind, target });
    }
    throwIfAborted(ctx.signal);
    assertArchiveSymlinkPlan(planned);
    await assertArchivePlan(ctx.permission, planned, { target: destTarget, boundary: destRoot });
    await ctx.sandbox.lstat(destRoot).catch(async () => {
      await fs.mkdir(destRoot, { recursive: true });
    });
    for (const item of planned) {
      throwIfAborted(ctx.signal);
      if (item.kind === "directory") {
        await fs.mkdir(item.target.full, { recursive: true });
      } else if (item.kind === "symlink") {
        await fs.mkdir(path.dirname(item.target.full), { recursive: true });
        await fs.symlink(item.header.linkname, item.target.full);
      } else {
        await fs.mkdir(path.dirname(item.target.full), { recursive: true });
        const mode = safeMode(Number(item.header.mode));
        await writeOutput(
          item.target.full,
          item.data,
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
      await chmodDirectoryNoFollow(
        item.target.full,
        safeDirectoryMode(Number(item.header.mode)),
      );
    }
    return textResult("", { archive: input.archive, members: names });
  },
};

async function collectMembers(
  full: string,
  name: string,
  members: Array<{ name: string; full: string; stats: Awaited<ReturnType<typeof fs.lstat>> }>,
  excludes: ((value: string) => boolean) | undefined,
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
  const excludedDirs: string[] = [];
  for (const entry of walked) {
    if (excludedDirs.some((dir) => entry.path === dir || entry.path.startsWith(dir + path.sep))) {
      continue;
    }
    const relative = path.relative(full, entry.path).split(path.sep).join("/");
    /* v8 ignore next */
    const member = name === "" ? relative : `${name}/${relative}`;
    if (excludes !== undefined && excludes(member)) {
      if (entry.stats.isDirectory()) excludedDirs.push(entry.path);
      continue;
    }
    members.push({ name: member, full: entry.path, stats: entry.stats });
  }
}

function safeMember(name: string, strip: number): string | undefined {
  /* v8 ignore next */
  if (name.includes("\0") || path.isAbsolute(name)) throw new FsError(`Blocked archive path: ${name}`, "archive");
  const parts = name.split("/").filter((part) => part.length > 0);
  if (parts.some((part) => part === "..")) throw new FsError(`Blocked archive path: ${name}`, "archive");
  const stripped = parts.slice(strip);
  return stripped.length === 0 ? undefined : stripped.join(path.sep);
}


