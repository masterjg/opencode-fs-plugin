/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTwoFilesPatch } from "diff";
import { Type, type Static } from "@sinclair/typebox";
import { fromErrno } from "../core/errors.js";
import { mapLimit } from "../core/parallel.js";
import { outputBoundary, throwIfAborted } from "../core/safe-output.js";
import { textResult, type RunContext, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    left: Type.String({ minLength: 1 }),
    right: Type.String({ minLength: 1 }),
    unified: Type.Optional(Type.Integer({ minimum: 0, description: "Context lines (`-U`). Default: 3." })),
    brief: Type.Optional(Type.Boolean({ description: "Only report whether files differ (`-q`)." })),
    recursive: Type.Optional(Type.Boolean({ description: "Compare directories recursively (`-r`)." })),
    ignoreWhitespace: Type.Optional(Type.Boolean({ description: "Ignore whitespace changes (`-w`)." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Ignore case (`-i`)." })),
    exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Exclude globs for directories." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const diffTool: ToolSpec<Input> = {
  name: "diff",
  description:
    "Compare files or directories with common `diff` semantics (`-u`, `-q`, `-r`, `-w`, `-i`, " +
    "`-U`, `--exclude`). Differences return exit code 1.",
  schema: Schema,
  pipeable: false,
  mutates: false,
  async run(ctx, input) {
    const left = await ctx.sandbox.resolveFollow(input.left);
    const right = await ctx.sandbox.resolveFollow(input.right);
    const leftStats = await ctx.sandbox.lstat(left.full, input.left);
    const rightStats = await ctx.sandbox.lstat(right.full, input.right);
    await ctx.permission.assert([
      {
        target: left,
        boundary: ctx.sandbox.boundaryFor(left.full, leftStats.isDirectory() ? "directory" : "file"),
      },
      {
        target: right,
        boundary: ctx.sandbox.boundaryFor(right.full, rightStats.isDirectory() ? "directory" : "file"),
      },
    ]);
    if (leftStats.isDirectory() || rightStats.isDirectory()) {
      if (leftStats.isDirectory() !== rightStats.isDirectory()) {
        return textResult(`File ${input.left} is a directory while file ${input.right} is not\n`, {}, 1);
      }
      if (input.recursive !== true) {
        return textResult(`Common subdirectories: ${input.left} and ${input.right}\n`, {}, 1);
      }
      const lines = await diffDirs(left.full, right.full, input, ctx);
      return textResult(lines.join(""), { differences: lines.length > 0 }, lines.length > 0 ? 1 : 0);
    }

    /* v8 ignore next */
    const leftData = await fs.readFile(left.full).catch((error) => {
      throw fromErrno(error);
    });
    /* v8 ignore next */
    const rightData = await fs.readFile(right.full).catch((error) => {
      throw fromErrno(error);
    });
    if (leftData.equals(rightData)) return textResult("", { differences: false }, 0);
    if (leftData.includes(0) || rightData.includes(0)) {
      return textResult(`Binary files ${input.left} and ${input.right} differ\n`, { differences: true }, 1);
    }
    if (input.brief === true) {
      return textResult(`Files ${input.left} and ${input.right} differ\n`, { differences: true }, 1);
    }
    let oldText = leftData.toString("utf8");
    let newText = rightData.toString("utf8");
    if (input.ignoreCase === true) {
      oldText = oldText.toLowerCase();
      newText = newText.toLowerCase();
    }
    if (input.ignoreWhitespace === true) {
      oldText = oldText.replace(/\s+/g, "");
      newText = newText.replace(/\s+/g, "");
    }
    if (oldText === newText) return textResult("", { differences: false }, 0);
    const patch = createTwoFilesPatch(input.left, input.right, oldText, newText, "", "", {
      context: input.unified ?? 3,
    });
    return textResult(patch, { differences: true }, 1);
  },
};

type DiffItem =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "file"; readonly left: string; readonly right: string };

async function diffDirs(
  left: string,
  right: string,
  input: Input,
  ctx: RunContext,
): Promise<string[]> {
  const items: DiffItem[] = [];
  await planDir(left, right, input, items, ctx.signal);

  const files = items.filter((item): item is Extract<DiffItem, { kind: "file" }> => item.kind === "file");
  const patches = await mapLimit(files, Math.max(1, ctx.concurrency), async (item) => {
    const [leftData, rightData] = await Promise.all([
      readDiffFile(ctx, item.left),
      readDiffFile(ctx, item.right),
    ]);
    /* v8 ignore next */
    if (leftData.equals(rightData)) return undefined;
    return createTwoFilesPatch(
      item.left,
      item.right,
      leftData.toString("utf8"),
      rightData.toString("utf8"),
      "",
      "",
      { context: input.unified ?? 3 },
    );
  }, ctx.signal);

  const output: string[] = [];
  let index = 0;
  for (const item of items) {
    if (item.kind === "text") {
      output.push(item.text);
      continue;
    }
    const patch = patches[index++];
    if (patch !== undefined) output.push(patch);
  }
  return output;
}

async function planDir(
  left: string,
  right: string,
  input: Input,
  items: DiffItem[],
  signal: AbortSignal,
): Promise<void> {
  const names = new Set<string>();
  for (const dir of [left, right]) {
    throwIfAborted(signal);
    for (const name of await fs.readdir(dir)) {
      throwIfAborted(signal);
      if (input.exclude?.some((pattern) => name.includes(pattern.replaceAll("*", ""))) === true) continue;
      names.add(name);
    }
  }
  for (const name of [...names].sort()) {
    throwIfAborted(signal);
    const leftPath = path.join(left, name);
    const rightPath = path.join(right, name);
    const leftExists = await exists(leftPath);
    const rightExists = await exists(rightPath);
    if (!leftExists || !rightExists) {
      /* v8 ignore next */
      items.push({ kind: "text", text: `Only in ${leftExists ? left : right}: ${name}\n` });
      continue;
    }
    const leftStats = await fs.lstat(leftPath);
    const rightStats = await fs.lstat(rightPath);
    if (leftStats.isDirectory() && rightStats.isDirectory()) {
      await planDir(leftPath, rightPath, input, items, signal);
    /* v8 ignore next 4 */
    } else if (leftStats.isDirectory() !== rightStats.isDirectory()) {
      /* v8 ignore next */
      items.push({ kind: "text", text: `File ${leftPath} is a directory while file ${rightPath} is not\n` });
    } else {
      items.push({ kind: "file", left: leftPath, right: rightPath });
    }
  }
}

/**
 * Recursive diff reads regular children directly. A symlink child is resolved
 * and gated first, so an external link cannot read without permission.
 */
async function readDiffFile(ctx: RunContext, file: string): Promise<Buffer> {
  const stats = await fs.lstat(file);
  if (!stats.isSymbolicLink()) return fs.readFile(file);
  const target = await ctx.sandbox.resolveFollow(file);
  await ctx.permission.assert([{ target, boundary: outputBoundary(target.full) }]);
  return fs.readFile(target.full);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}
