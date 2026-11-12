/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { Type, type Static } from "@sinclair/typebox";
import { FsError } from "../core/errors.js";
import { parseSchema } from "../core/schema.js";
import { writeAll } from "../core/stream.js";
import { textResult, type ToolSpec, type ToolResult } from "../core/types.js";
import { catTool } from "./cat.js";
import { cutTool } from "./cut.js";
import { grepTool } from "./grep.js";
import { gunzipTool, gzipTool } from "./gzip.js";
import { hashTool } from "./hash.js";
import { headTool } from "./head.js";
import { sedTool } from "./sed.js";
import { sortTool } from "./sort.js";
import { tailTool } from "./tail.js";
import { teeTool } from "./tee.js";
import { trTool } from "./tr.js";
import { uniqTool } from "./uniq.js";
import { wcTool } from "./wc.js";

const Stage = Type.Object(
  {
    tool: Type.String({ minLength: 1, description: "Pipe stage tool name, e.g. cat, grep, sort." }),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const Schema = Type.Object(
  {
    stages: Type.Array(Stage, { minItems: 1, maxItems: 50 }),
    input: Type.Optional(Type.String({ description: "Initial stdin text when the first stage reads from stdin." })),
    output: Type.Optional(Type.String({ description: "Write final stdout to this file, like `> file`." })),
    append: Type.Optional(Type.Boolean({ description: "Append to output instead of overwriting, like `>> file`." })),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;
type AnyTool = ToolSpec<any>;

const REGISTRY: ReadonlyMap<string, AnyTool> = new Map(
  [catTool, headTool, tailTool, grepTool, sedTool, sortTool, uniqTool, cutTool, trTool, wcTool, teeTool, hashTool, gzipTool, gunzipTool].map(
    (tool) => [tool.name, tool],
  ),
);

export const pipeTool: ToolSpec<Input> = {
  name: "pipe",
  description:
    "Compose fs tools into a Linux-style pipeline. Stages run sequentially; stdin/stdout are buffers; " +
    "only pipeable tools are allowed. `output` and `append` act as a final tee.",
  schema: Schema,
  pipeable: false,
  mutates: true,
  async run(ctx, input) {
    let data: Buffer | undefined = input.input === undefined ? undefined : Buffer.from(input.input, "utf8");
    const stages: Array<{ tool: string; bytesIn: number; bytesOut: number; exitCode: number }> = [];

    for (let index = 0; index < input.stages.length; index++) {
      const stage = input.stages[index] as Static<typeof Stage>;
      const tool = REGISTRY.get(stage.tool);
      if (tool === undefined) {
        throw new FsError(`Unknown pipe stage: ${stage.tool}`, "unsupported");
      }
      if (tool.pipeable === false) {
        throw new FsError(`Tool "${stage.tool}" cannot be used in a pipe.`, "unsupported");
      }
      if (index > 0 && data === undefined && tool.pipeable !== "source") {
        throw new FsError(`Pipe stage "${stage.tool}" has no input.`, "invalid");
      }
      const parsed = parseSchema(tool.schema, stage.args ?? {}, `${stage.tool} arguments`);
      const gate = ctx.permissionFor(`fs_${tool.name}`);
      const result = await tool.run(
        { ...ctx, permission: gate },
        parsed,
        { ...(data === undefined ? {} : { stdin: fromBuffer(data) }) },
      ) as ToolResult;
      stages.push({
        tool: stage.tool,
        bytesIn: data?.length ?? 0,
        bytesOut: result.stdout.length,
        exitCode: result.exitCode ?? 0,
      });
      data = result.stdout;
    }

    if (input.output !== undefined) {
      const target = await ctx.sandbox.resolveForCreate(input.output);
      const gate = ctx.permissionFor("fs_tee");
      await gate.assert([{ target, boundary: target.full }]);
      await writeAll(target.full, data ?? Buffer.alloc(0), input.append === true);
    }

    return textResult(data?.toString("utf8") ?? "", { stages, output: input.output ?? null });
  },
};

async function* fromBuffer(data: Buffer): AsyncGenerator<Buffer> {
  yield data;
}
