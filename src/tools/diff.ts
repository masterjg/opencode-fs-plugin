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
import { textResult, type ToolSpec } from "../core/types.js";

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
    const left = await ctx.sandbox.resolveExisting(input.left, { allowRoot: true });
    const right = await ctx.sandbox.resolveExisting(input.right, { allowRoot: true });
    await ctx.permission.assert([
      { target: left, boundary: left.full },
      { target: right, boundary: right.full },
    ]);
    const leftStats = await ctx.sandbox.lstat(left.full, input.left);
    const rightStats = await ctx.sandbox.lstat(right.full, input.right);
    if (leftStats.isDirectory() || rightStats.isDirectory()) {
      if (leftStats.isDirectory() !== rightStats.isDirectory()) {
        return textResult(`File ${input.left} is a directory while file ${input.right} is not\n`, {}, 1);
      }
      if (input.recursive !== true) {
        return textResult(`Common subdirectories: ${input.left} and ${input.right}\n`, {}, 1);
      }
      const lines = await diffDirs(left.full, right.full, input, ctx.concurrency);
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
  concurrency: number,
): Promise<string[]> {
  const items: DiffItem[] = [];
  await planDir(left, right, input, items);

  const files = items.filter((item): item is Extract<DiffItem, { kind: "file" }> => item.kind === "file");
  const patches = await mapLimit(files, Math.max(1, concurrency), async (item) => {
    const [leftData, rightData] = await Promise.all([fs.readFile(item.left), fs.readFile(item.right)]);
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
  });

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

async function planDir(left: string, right: string, input: Input, items: DiffItem[]): Promise<void> {
  const names = new Set<string>();
  for (const dir of [left, right]) {
    for (const name of await fs.readdir(dir)) {
      if (input.exclude?.some((pattern) => name.includes(pattern.replaceAll("*", ""))) === true) continue;
      names.add(name);
    }
  }
  for (const name of [...names].sort()) {
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
      await planDir(leftPath, rightPath, input, items);
    /* v8 ignore next 4 */
    } else if (leftStats.isDirectory() !== rightStats.isDirectory()) {
      /* v8 ignore next */
      items.push({ kind: "text", text: `File ${leftPath} is a directory while file ${rightPath} is not\n` });
    } else {
      items.push({ kind: "file", left: leftPath, right: rightPath });
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}
