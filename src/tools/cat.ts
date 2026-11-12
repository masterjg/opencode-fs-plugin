/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { collect, inputStream, lines } from "../core/stream.js";
import { textResult, type ToolSpec } from "../core/types.js";

const Schema = Type.Object(
  {
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Files to concatenate. Omit to read stdin." })),
    number: Type.Optional(Type.Boolean({ description: "Number all output lines (`-n`)." })),
    numberNonBlank: Type.Optional(Type.Boolean({ description: "Number only non-blank lines (`-b`)." })),
    squeezeBlank: Type.Optional(Type.Boolean({ description: "Collapse repeated blank lines (`-s`)." })),
    showEnds: Type.Optional(Type.Boolean({ description: "Show line ends as `$` (`-E`)." })),
    showTabs: Type.Optional(Type.Boolean({ description: "Show tabs as `^I` (`-T`)." })),
    showNonPrinting: Type.Optional(Type.Boolean({ description: "Show non-printing characters (`-v`)." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

export const catTool: ToolSpec<Input> = {
  name: "cat",
  description:
    "Concatenate files or stdin with Linux `cat` semantics (`-n`, `-b`, `-s`, `-E`, `-T`, `-A`, `-v`).",
  schema: Schema,
  pipeable: "source",
  mutates: false,
  async run(ctx, input, io) {
    const paths = await resolvePaths(ctx, input.paths ?? []);
    const stream = inputStream(paths.map((entry) => entry.full), io.stdin);
    if (
      input.number !== true &&
      input.numberNonBlank !== true &&
      input.squeezeBlank !== true &&
      input.showEnds !== true &&
      input.showTabs !== true &&
      input.showNonPrinting !== true
    ) {
      return { stdout: await collect(stream), exitCode: 0, metadata: { paths: input.paths ?? [] } };
    }

    const output: string[] = [];
    let number = 0;
    let blank = false;
    for await (const line of lines(stream)) {
      if (input.squeezeBlank === true && line.text === "") {
        if (blank) continue;
        blank = true;
      } else {
        blank = false;
      }
      let text = line.text;
      if (input.showTabs === true || input.showNonPrinting === true) text = text.replaceAll("\t", "^I");
      if (input.showNonPrinting === true) text = visible(text);
      if (input.showEnds === true) text += "$";
      if ((input.number === true || input.numberNonBlank === true) && (input.numberNonBlank !== true || text.length > 0)) {
        number++;
        text = `${String(number).padStart(6)}  ${text}`;
      }
      output.push(text + (line.newline ? "\n" : ""));
    }
    return textResult(output.join(""), { paths: input.paths ?? [] });
  },
};

async function resolvePaths(
  ctx: Parameters<ToolSpec<Input>["run"]>[0],
  paths: readonly string[],
): Promise<Array<{ requested: string; full: string }>> {
  const targets = [];
  for (const requested of paths) {
    const target = await ctx.sandbox.resolveFollow(requested);
    targets.push({ requested, full: target.full, target });
  }
  await ctx.permission.assert(targets.map(({ target }) => ({ target, boundary: target.full })));
  return targets;
}

function visible(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (char) => {
    const code = char.charCodeAt(0);
    return `^${String.fromCharCode(code === 127 ? 63 : code + 64)}`;
  });
}


