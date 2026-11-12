/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as os from "node:os";
import { Plugin } from "@opencode/plugin";
import { FsError } from "./core/errors.js";
import { renderError, renderResult } from "./core/format.js";
import { PermissionGate, type PermissionAssert } from "./core/permissions.js";
import { clampConcurrency } from "./core/parallel.js";
import { Sandbox } from "./core/sandbox.js";
import { parseSchema } from "./core/schema.js";
import type { ToolSpec } from "./core/types.js";
import { mkdirTool } from "./tools/mkdir.js";
import { rmdirTool } from "./tools/rmdir.js";
import { rmTool } from "./tools/rm.js";

type AnyTool = ToolSpec<any>;

const TOOLS: readonly AnyTool[] = [mkdirTool, rmdirTool, rmTool];

const DEFAULT_MAX_OUTPUT = 1024 * 1024;

export default Plugin.define({
  id: "opencode-fs-plugin",
  async setup(ctx) {
    const rawRoot =
      (typeof ctx.options?.root === "string" && ctx.options.root) ||
      ctx.location?.project?.canonical ||
      ctx.location?.directory ||
      "";
    if (!rawRoot) {
      throw new Error("opencode-fs-plugin: could not determine a sandbox root.");
    }

    const sandbox = await Sandbox.create(rawRoot);
    const concurrency = clampConcurrency(
      typeof ctx.options?.concurrency === "number" ? ctx.options.concurrency : undefined,
    );
    const maxOutputBytes =
      typeof ctx.options?.maxOutputBytes === "number" && ctx.options.maxOutputBytes > 0
        ? Math.trunc(ctx.options.maxOutputBytes)
        : DEFAULT_MAX_OUTPUT;

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "fs",
        description: "Linux-style filesystem and text tools with native command semantics.",
      });

      for (const spec of TOOLS) {
        editor.add({
          name: spec.name,
          description: spec.description,
          input: spec.schema,
          options: { namespace: "fs", permission: `fs_${spec.name}` },
          execute: async (input, context) => {
            try {
              const parsed = parseSchema<unknown>(spec.schema, input, `${spec.name} input`);
              const assertPermission: PermissionAssert = async (request) => {
                await ctx.permission.assert(
                  request as unknown as Parameters<typeof ctx.permission.assert>[0],
                );
              };
              const gate = new PermissionGate(
                {
                  sessionID: context.sessionID,
                  agent: context.agent,
                  messageID: context.messageID,
                  id: context.id,
                },
                `fs_${spec.name}`,
                (full) => sandbox.resource(full),
                assertPermission,
              );
              const result = await spec.run(
                {
                  sandbox,
                  permission: gate,
                  concurrency,
                  signal: context.signal,
                  tmpdir: os.tmpdir(),
                  maxOutputBytes,
                },
                parsed,
                {},
              );
              return renderResult(result, maxOutputBytes);
            } catch (error) {
              if (error instanceof FsError) {
                return renderError(error, error.code === "outside");
              }
              throw error;
            }
          },
        });
      }
    });
  },
});
