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
    const archive = await ctx.sandbox.resolveForCreate(input.archive);
    const useGzip = input.gzip ?? /\.(?:tgz|tar\.gz)$/i.test(input.archive);
    const excludes = input.exclude === undefined ? undefined : picomatch(input.exclude, { dot: true, basename: true });
    const names: string[] = [];

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
        await ctx.permission.assert([{ target: archive, boundary: archive.full }]);
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
        /* v8 ignore next 3 */
        await fs.writeFile(archive.full, buffer).catch((error) => {
          throw fromErrno(error);
        });
        return textResult(input.verbose === true ? `${header.name}\n` : "", {
          archive: input.archive,
          members: [header.name],
        });
      }
      const members: Array<{ name: string; full: string; stats: Awaited<ReturnType<typeof fs.lstat>> }> = [];
      for (const requested of input.paths) {
        const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
        const stats = await ctx.sandbox.lstat(target.full, requested);
        const base = path.basename(path.resolve(requested));
        members.push({ name: base, full: target.full, stats });
        if (stats.isDirectory()) {
          await collectMembers(target.full, base, members, excludes);
        }
      }
      const entries = await Promise.all(
        members.map(async (member) => ({
          target: await ctx.sandbox.resolveExisting(member.full, { allowRoot: true }),
          boundary: member.stats.isDirectory() ? member.full : path.dirname(member.full),
        })),
      );
      await ctx.permission.assert([...entries, { target: archive, boundary: archive.full }]);
      const pack = tar.pack();
      for (const member of members) {
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
      /* v8 ignore next 3 */
      await fs.writeFile(archive.full, buffer).catch((error) => {
        throw fromErrno(error);
      });
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
        names.push(entry.header.name);
        await collect(entry as AsyncIterable<Buffer>);
      }
      return textResult(names.map((name) => `${name}\n`).join(""), { archive: input.archive, members: names });
    }

    const destTarget = input.directory === undefined
      ? await ctx.sandbox.resolveForCreate(".")
      : await ctx.sandbox.resolveForCreate(input.directory);
    const destRoot = destTarget.full;
    await ctx.permission.assert([{ target: destTarget, boundary: destRoot }]);
    await ctx.sandbox.lstat(destRoot).catch(async () => {
      await fs.mkdir(destRoot, { recursive: true });
    });
    const extract = tar.extract();
    extract.end(buffer);
    for await (const entry of extract) {
      const name = safeMember(entry.header.name, input.stripComponents ?? 0);
      if (name === undefined) {
        await collect(entry as AsyncIterable<Buffer>);
        continue;
      }
      const destination = path.join(destRoot, name);
      /* v8 ignore next */
      if (!isInside(destRoot, destination)) throw new FsError(`Blocked archive path: ${entry.header.name}`, "archive");
      if (entry.header.type === "directory") {
        await fs.mkdir(destination, { recursive: true });
        await collect(entry as AsyncIterable<Buffer>);
      } else if (entry.header.type === "symlink") {
        if (path.isAbsolute(entry.header.linkname) || entry.header.linkname.split("/").includes("..")) {
          throw new FsError(`Blocked symlink target: ${entry.header.linkname}`, "archive");
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.symlink(entry.header.linkname, destination);
        await collect(entry as AsyncIterable<Buffer>);
      } else {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const data = await collect(entry as AsyncIterable<Buffer>);
        await fs.writeFile(destination, data, { mode: Number(entry.header.mode) & 0o7777 });
      }
      names.push(name);
    }
    return textResult("", { archive: input.archive, members: names });
  },
};

async function collectMembers(
  full: string,
  name: string,
  members: Array<{ name: string; full: string; stats: Awaited<ReturnType<typeof fs.lstat>> }>,
  excludes: ((value: string) => boolean) | undefined,
): Promise<void> {
  const entries = await fs.readdir(full);
  for (const entry of entries) {
    const child = path.join(full, entry);
    /* v8 ignore next */
    const member = name === "" ? entry : `${name}/${entry}`;
    if (excludes !== undefined && excludes(member)) continue;
    const stats = await fs.lstat(child);
    members.push({ name: member, full: child, stats });
    if (stats.isDirectory()) await collectMembers(child, member, members, excludes);
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

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
