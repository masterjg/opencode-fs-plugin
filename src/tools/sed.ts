/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { inputStream, writeAll } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    script: Type.String({ description: "sed substitution, e.g. s/old/new/g." }),
    expressions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Additional -e expressions." })),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to process. Omit to read stdin." })),
    inPlace: Type.Optional(Type.Boolean({ description: "Edit files in place (`-i`)." })),
    extendedRegexp: Type.Optional(Type.Boolean({ description: "Use extended regular expressions (`-E`)." })),
    quiet: Type.Optional(Type.Boolean({ description: "Suppress automatic output (`-n`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface Substitution {
  pattern: RegExp;
  replacement: string;
  global: boolean;
  print: boolean;
}

export const sedTool: ToolSpec<Input> = {
  name: "sed",
  description:
    "Apply `s/pattern/replacement/flags` substitutions with Linux `sed` semantics for the common " +
    "substitution form (`-e`, `-i`, `-E`, `-n`). Full sed command language is not supported.",
  schema: Schema,
  pipeable: "filter",
  mutates: false,
  async run(ctx, input, io) {
    const scripts = [input.script, ...(input.expressions ?? [])];
    const substitutions = scripts.map((script) => parseSubstitution(script, input.extendedRegexp === true));
    const paths = input.paths ?? [];
    if (input.inPlace === true && paths.length === 0) {
      throw new FsError("in-place editing requires paths.", "invalid");
    }

    const targets = [];
    for (const requested of paths) {
      const target = await ctx.sandbox.resolveFollow(requested);
      targets.push({ requested, full: target.full, target });
    }
    if (targets.length > 0) {
      await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));
    }

    if (input.inPlace === true) {
      for (const target of targets) {
        /* v8 ignore next */
        const data = await fs.readFile(target.full).catch((error) => {
          throw fromErrno(error);
        });
        const transformed = transform(data.toString("utf8"), substitutions, input.quiet === true);
        const temp = path.join(path.dirname(target.full), `.opencode-sed-${randomBytes(6).toString("hex")}`);
        await writeAll(temp, Buffer.from(transformed, "utf8"));
        const stats = await fs.stat(target.full);
        /* v8 ignore next */
        await fs.chmod(temp, stats.mode & 0o7777).catch(() => undefined);
        /* v8 ignore next */
        await fs.rename(temp, target.full).catch((error) => {
          throw fromErrno(error);
        });
      }
      return textResult("", { files: paths });
    }

    /* v8 ignore next */
    const stream = inputStream(targets.map((target) => target.full), io.stdin);
    const source = await collectText(stream);
    return textResult(transform(source, substitutions, input.quiet === true), { lines: source.split("\n").length });
  },
};

export function parseSubstitution(script: string, extended: boolean): Substitution {
  if (!script.startsWith("s") || script.length < 4) {
    throw new FsError(`Unsupported sed expression: ${script}`, "unsupported");
  }
  const delimiter = script[1] as string;
  const parts: string[] = [];
  let current = "";
  for (let index = 2; index < script.length; index++) {
    const char = script[index] as string;
    /* v8 ignore next */
    if (char === "\\") {
      /* v8 ignore next */
      current += char + (script[++index] ?? "");
    } else if (char === delimiter) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  /* v8 ignore next */
  if (parts.length < 2) throw new FsError(`Invalid sed expression: ${script}`, "invalid");
  const flags = parts[2] ?? "";
  return {
    /* v8 ignore next */
    pattern: new RegExp(parts[0] as string, `${extended ? "" : ""}${flags.includes("i") ? "i" : ""}g`),
    replacement: toJsReplacement(parts[1] as string),
    global: flags.includes("g"),
    print: flags.includes("p"),
  };
}

function toJsReplacement(value: string): string {
  return value.replaceAll("&", "$&").replace(/\\(\d)/g, "$$$1");
}

function transform(text: string, substitutions: Substitution[], quiet: boolean): string {
  const trailing = text.endsWith("\n");
  const rows = text.split("\n");
  /* v8 ignore next */
  if (trailing) rows.pop();
  const output: string[] = [];
  for (const row of rows) {
    let line = row;
    for (const substitution of substitutions) {
      const before = line;
      line = substitution.global
        ? line.replace(substitution.pattern, substitution.replacement)
        : line.replace(new RegExp(substitution.pattern.source, substitution.pattern.flags.replace("g", "")), substitution.replacement);
      if (substitution.print && line !== before) output.push(line);
    }
    if (quiet !== true) output.push(line);
  }
  /* v8 ignore next */
  return output.join("\n") + (trailing ? "\n" : "");
}

async function collectText(stream: AsyncIterable<Buffer>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk.toString("utf8");
  return text;
}


