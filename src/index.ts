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
import { catTool } from "./tools/cat.js";
import { chmodTool } from "./tools/chmod.js";
import { cpTool } from "./tools/cp.js";
import { cutTool } from "./tools/cut.js";
import { dfTool } from "./tools/df.js";
import { diffTool } from "./tools/diff.js";
import { duTool } from "./tools/du.js";
import { findTool } from "./tools/find.js";
import { grepTool } from "./tools/grep.js";
import { gunzipTool, gzipTool } from "./tools/gzip.js";
import { hashTool } from "./tools/hash.js";
import { headTool } from "./tools/head.js";
import { lnTool } from "./tools/ln.js";
import { lsTool } from "./tools/ls.js";
import { mkdirTool } from "./tools/mkdir.js";
import { mktempTool } from "./tools/mktemp.js";
import { mvTool } from "./tools/mv.js";
import { pipeTool } from "./tools/pipe.js";
import { readlinkTool } from "./tools/readlink.js";
import { rmTool } from "./tools/rm.js";
import { rmdirTool } from "./tools/rmdir.js";
import { sedTool } from "./tools/sed.js";
import { sortTool } from "./tools/sort.js";
import { statTool } from "./tools/stat.js";
import { tailTool } from "./tools/tail.js";
import { tarTool } from "./tools/tar.js";
import { teeTool } from "./tools/tee.js";
import { touchTool } from "./tools/touch.js";
import { trTool } from "./tools/tr.js";
import { trashTool } from "./tools/trash.js";
import { truncateTool } from "./tools/truncate.js";
import { uniqTool } from "./tools/uniq.js";
import { wcTool } from "./tools/wc.js";
import { unzipTool, zipTool } from "./tools/zip.js";

type AnyTool = ToolSpec<any>;

const TOOLS: readonly AnyTool[] = [
  mkdirTool,
  rmdirTool,
  rmTool,
  cpTool,
  mvTool,
  lsTool,
  statTool,
  touchTool,
  truncateTool,
  lnTool,
  readlinkTool,
  chmodTool,
  hashTool,
  duTool,
  dfTool,
  findTool,
  mktempTool,
  trashTool,
  gzipTool,
  gunzipTool,
  tarTool,
  zipTool,
  unzipTool,
  diffTool,
  catTool,
  headTool,
  tailTool,
  teeTool,
  wcTool,
  sortTool,
  uniqTool,
  cutTool,
  trTool,
  sedTool,
  grepTool,
  pipeTool,
];

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
              const permissionFor = (action: string) =>
                new PermissionGate(
                  {
                    sessionID: context.sessionID,
                    agent: context.agent,
                    messageID: context.messageID,
                    id: context.id,
                  },
                  action,
                  /* v8 ignore next */
                  (full) => sandbox.resource(full),
                  assertPermission,
                );
              const result = await spec.run(
                {
                  sandbox,
                  permission: permissionFor(`fs_${spec.name}`),
                  permissionFor,
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
