/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import picomatch from "picomatch";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { walkAll } from "../core/fsutil.js";
import { mapLimit } from "../core/parallel.js";
import { collect, inputStream } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    pattern: Type.String({ description: "Search pattern." }),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files or directories. Omit to read stdin." })),
    recursive: Type.Optional(Type.Boolean({ description: "Search directories recursively (`-r`)." })),
    include: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Only search matching globs (`--include`)." })),
    exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Skip matching globs (`--exclude`)." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (`-i`)." })),
    invert: Type.Optional(Type.Boolean({ description: "Select non-matching lines (`-v`)." })),
    lineNumbers: Type.Optional(Type.Boolean({ description: "Print line numbers (`-n`)." })),
    withFilename: Type.Optional(Type.Boolean({ description: "Prefix matches with filenames (`-H`)." })),
    noFilename: Type.Optional(Type.Boolean({ description: "Never print filenames (`-h`)." })),
    filesWithMatches: Type.Optional(Type.Boolean({ description: "Only print matching filenames (`-l`)." })),
    filesWithoutMatch: Type.Optional(Type.Boolean({ description: "Only print non-matching filenames (`-L`)." })),
    count: Type.Optional(Type.Boolean({ description: "Print match counts (`-c`)." })),
    onlyMatching: Type.Optional(Type.Boolean({ description: "Print only the matching parts (`-o`)." })),
    word: Type.Optional(Type.Boolean({ description: "Match whole words (`-w`)." })),
    line: Type.Optional(Type.Boolean({ description: "Match whole lines (`-x`)." })),
    fixed: Type.Optional(Type.Boolean({ description: "Treat the pattern as literal text (`-F`)." })),
    extended: Type.Optional(Type.Boolean({ description: "Extended regular expressions (`-E`)." })),
    context: Type.Optional(Type.Integer({ minimum: 0, description: "Lines of context (`-C`)." })),
    before: Type.Optional(Type.Integer({ minimum: 0, description: "Lines before (`-B`)." })),
    after: Type.Optional(Type.Integer({ minimum: 0, description: "Lines after (`-A`)." })),
    maxCount: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum matches per file (`-m`)." })),
    noMessages: Type.Optional(Type.Boolean({ description: "Suppress error messages (`-s`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface Target {
  requested: string;
  full: string;
}

export const grepTool: ToolSpec<Input> = {
  name: "grep",
  description:
    "Search file contents with Linux `grep` semantics (`-i`, `-v`, `-n`, `-H`, `-h`, `-l`, `-L`, " +
    "`-c`, `-o`, `-w`, `-x`, `-F`, `-r`, `-A/-B/-C`, `--include`, `--exclude`).",
  schema: Schema,
  pipeable: "filter",
  mutates: false,
  async run(ctx, input, io) {
    const regex = buildRegex(input);
    const include = input.include?.length ? picomatch(input.include, { dot: true, basename: true }) : undefined;
    const exclude = input.exclude?.length ? picomatch(input.exclude, { dot: true, basename: true }) : undefined;
    const isIncluded = (file: string): boolean => {
      if (include !== undefined && !include(file)) return false;
      if (exclude !== undefined && exclude(file)) return false;
      return true;
    };
    const paths = input.paths ?? [];
    const targets: Target[] = [];
    if (paths.length > 0) {
      for (const requested of paths) {
        let target;
        try {
          target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
        } catch (error) {
          /* v8 ignore next 3 */
          if (input.noMessages === true) continue;
          /* v8 ignore next */
          throw error;
        }
        await ctx.permission.assert([{ target, boundary: target.full }]);
        const stats = await ctx.sandbox.lstat(target.full, requested);
        if (stats.isDirectory()) {
          if (input.recursive !== true) {
            throw new FsError(`"${requested}" is a directory; recursive is required.`, "not-file");
          }
          for (const entry of await walkAll(target.full, {
            recursive: true,
            includeHidden: true,
            signal: ctx.signal,
            concurrency: ctx.concurrency,
          })) {
            /* v8 ignore next */
            if (!entry.stats.isFile()) continue;
            const resource = entry.path;
            if (!isIncluded(resource)) continue;
            targets.push({ requested: resource, full: entry.path });
          }
        /* v8 ignore next */
        } else if (isIncluded(target.full)) {
          targets.push({ requested, full: target.full });
        }
      }
    }

    const output: string[] = [];
    let matchedAny = false;
    if (paths.length > 0 && targets.length === 0) {
      return textResult("", { matched: false, files: 0 }, 1);
    }
    if (targets.length === 0) {
      const data = await collect(await inputStream([], io.stdin));
      const result = search("(standard input)", data, regex, input, false);
      output.push(...result.lines);
      matchedAny = result.matched;
    } else {
      const showName = input.noFilename !== true && (input.withFilename === true || targets.length > 1 || input.recursive === true);
      const results = await mapLimit(
        targets,
        ctx.concurrency,
        async (target) => {
          let data: Buffer;
          try {
            data = await fs.readFile(target.full);
          } catch (error) {
            /* v8 ignore next 3 */
            if (input.noMessages === true) return undefined;
            /* v8 ignore next */
            throw fromErrno(error);
          }
          return search(target.requested, data, regex, input, showName);
        },
        ctx.signal,
      );
      for (const result of results) {
        /* v8 ignore next */
        if (result === undefined) continue;
        output.push(...result.lines);
        matchedAny ||= result.matched;
      }
    }
    return textResult(output.map((line) => `${line}\n`).join(""), { matched: matchedAny, files: targets.length }, matchedAny ? 0 : 1);
  },
};

function buildRegex(input: Input): RegExp {
  let pattern = input.fixed === true ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern;
  if (input.word === true) pattern = `\\b(?:${pattern})\\b`;
  if (input.line === true) pattern = `^(?:${pattern})$`;
  try {
    return new RegExp(pattern, `${input.ignoreCase === true ? "i" : ""}${input.onlyMatching === true ? "g" : ""}`);
  } catch (error) {
    throw new FsError(`Invalid pattern: ${(error as Error).message}`, "invalid");
  }
}

function search(
  name: string,
  data: Buffer,
  regex: RegExp,
  input: Input,
  showName: boolean,
): { lines: string[]; matched: boolean } {
  if (data.includes(0)) {
    /* v8 ignore next */
    return { lines: regex.test(data.toString("utf8")) ? [`Binary file ${name} matches`] : [], matched: regex.test(data.toString("utf8")) };
  }
  const rows = data.toString("utf8").split("\n");
  /* v8 ignore next */
  if (rows[rows.length - 1] === "") rows.pop();
  const before = input.before ?? input.context ?? 0;
  const after = input.after ?? input.context ?? 0;
  const lines: string[] = [];
  let matched = false;
  let count = 0;
  let lastPrinted = -1;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as string;
    regex.lastIndex = 0;
    const hit = input.invert === true ? !regex.test(row) : regex.test(row);
    if (!hit) continue;
    matched = true;
    count++;
    if (input.filesWithMatches === true && !lines.includes(name)) lines.push(name);
    if (input.maxCount !== undefined && count >= input.maxCount) break;
    if (input.filesWithMatches === true) continue;
    /* v8 ignore next */
    if (input.filesWithoutMatch === true) continue;
    /* v8 ignore next */
    if (input.count === true) continue;
    if (input.onlyMatching === true) {
      regex.lastIndex = 0;
      for (const match of row.matchAll(regex)) {
        /* v8 ignore next */
        lines.push(`${showName ? `${name}:` : ""}${input.lineNumbers === true ? `${index + 1}:` : ""}${match[0]}`);
      }
    } else {
      const start = Math.max(0, index - before);
      const end = Math.min(rows.length - 1, index + after);
      for (let context = start; context <= end; context++) {
        /* v8 ignore next */
        if (context <= lastPrinted) continue;
        const separator = context === index ? ":" : "-";
        const prefix = showName ? `${name}${separator}` : "";
        const lineNumber = input.lineNumbers === true ? `${context + 1}${separator}` : "";
        lines.push(`${prefix}${lineNumber}${rows[context]}`);
        lastPrinted = context;
      }
    }
  }
  /* v8 ignore next */
  if (input.count === true) lines.push(`${showName ? `${name}:` : ""}${Math.min(count, input.maxCount ?? count)}`);
  if (input.filesWithoutMatch === true && !matched) lines.push(name);
  return { lines, matched };
}
