/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as os from "node:os";
import { Type, type TSchema } from "@sinclair/typebox";
import { Plugin } from "@opencode/plugin";
import { FsError } from "./core/errors.js";
import { renderError, renderResult } from "./core/format.js";
import { JobManager } from "./core/jobs.js";
import { PermissionGate, type PermissionAssert } from "./core/permissions.js";
import { clampConcurrency } from "./core/parallel.js";
import { Sandbox } from "./core/sandbox.js";
import { parseSchema } from "./core/schema.js";
import type { ToolSpec } from "./core/types.js";
import { arTool } from "./tools/ar.js";
import { base64Tool } from "./tools/base64.js";
import { catTool } from "./tools/cat.js";
import { chmodTool } from "./tools/chmod.js";
import { chownTool } from "./tools/chown.js";
import { commTool } from "./tools/comm.js";
import { cpTool } from "./tools/cp.js";
import { cpioTool } from "./tools/cpio.js";
import { cutTool } from "./tools/cut.js";
import { dateTool } from "./tools/date.js";
import { ddTool } from "./tools/dd.js";
import { dfTool } from "./tools/df.js";
import { diffTool } from "./tools/diff.js";
import { duTool } from "./tools/du.js";
import { fileTool } from "./tools/file.js";
import { findTool } from "./tools/find.js";
import { findmntTool } from "./tools/findmnt.js";
import { foldTool } from "./tools/fold.js";
import { grepTool } from "./tools/grep.js";
import { gunzipTool, gzipTool } from "./tools/gzip.js";
import { hashTool } from "./tools/hash.js";
import { headTool } from "./tools/head.js";
import { httpRequestTool } from "./tools/http_request.js";
import { idTool } from "./tools/id.js";
import { killTool } from "./tools/kill.js";
import { lnTool } from "./tools/ln.js";
import { lsTool } from "./tools/ls.js";
import { mkdirTool } from "./tools/mkdir.js";
import { mktempTool } from "./tools/mktemp.js";
import { mountpointTool } from "./tools/mountpoint.js";
import { mvTool } from "./tools/mv.js";
import { nlTool } from "./tools/nl.js";
import { odTool } from "./tools/od.js";
import { pasteTool } from "./tools/paste.js";
import { pgrepTool } from "./tools/pgrep.js";
import { pipeTool } from "./tools/pipe.js";
import { psTool } from "./tools/ps.js";
import { readlinkTool } from "./tools/readlink.js";
import { revTool } from "./tools/rev.js";
import { rmTool } from "./tools/rm.js";
import { rmdirTool } from "./tools/rmdir.js";
import { sedTool } from "./tools/sed.js";
import { shufTool } from "./tools/shuf.js";
import { sortTool } from "./tools/sort.js";
import { splitTool } from "./tools/split.js";
import { statTool } from "./tools/stat.js";
import { stringsTool } from "./tools/strings.js";
import { syncTool } from "./tools/sync.js";
import { tacTool } from "./tools/tac.js";
import { tailTool } from "./tools/tail.js";
import { tarTool } from "./tools/tar.js";
import { teeTool } from "./tools/tee.js";
import { touchTool } from "./tools/touch.js";
import { trTool } from "./tools/tr.js";
import { trashTool } from "./tools/trash.js";
import { truncateTool } from "./tools/truncate.js";
import { unameTool } from "./tools/uname.js";
import { uniqTool } from "./tools/uniq.js";
import { uptimeTool } from "./tools/uptime.js";
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
  httpRequestTool,
  psTool,
  pgrepTool,
  killTool,
  fileTool,
  base64Tool,
  odTool,
  stringsTool,
  idTool,
  unameTool,
  uptimeTool,
  dateTool,
  findmntTool,
  mountpointTool,
  tacTool,
  revTool,
  nlTool,
  pasteTool,
  commTool,
  splitTool,
  shufTool,
  foldTool,
  chownTool,
  syncTool,
  ddTool,
  cpioTool,
  arTool,
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

function withBackground(schema: TSchema): TSchema {
  return Type.Composite(
    [
      schema,
      Type.Object({
        background: Type.Optional(
          Type.Boolean({
            description:
              "Run this operation as a background job and return a job id immediately. Use fs.job to wait, inspect, cancel, or list jobs.",
          }),
        ),
      }),
    ],
    { additionalProperties: false },
  );
}

const JOB_SCHEMA = Type.Object(
  {
    id: Type.Optional(Type.String({ description: "Background job id." })),
    wait: Type.Optional(Type.Boolean({ description: "Wait for the job to finish." })),
    cancel: Type.Optional(Type.Boolean({ description: "Abort a running job." })),
    list: Type.Optional(Type.Boolean({ description: "List all jobs, newest first." })),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 600000,
        description: "Maximum wait in milliseconds. Default 600000.",
      }),
    ),
  },
  { additionalProperties: false },
);

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
    const jobs = new JobManager(
      typeof ctx.options?.jobDir === "string" ? { dir: ctx.options.jobDir } : {},
    );

    const registration = await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "fs",
        description: "Linux-style filesystem and text tools with native command semantics.",
      });

      for (const spec of TOOLS) {
        const schema = withBackground(spec.schema);
        editor.add({
          name: spec.name,
          description: spec.description,
          input: schema,
          options: { namespace: "fs", permission: `fs_${spec.name}` },
          execute: async (input, context) => {
            try {
              const parsed = parseSchema<unknown>(schema, input, `${spec.name} input`);
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
              const runSpec = async (signal: AbortSignal) => {
                const result = await spec.run(
                  {
                    sandbox,
                    permission: permissionFor(`fs_${spec.name}`),
                    permissionFor,
                    concurrency,
                    signal,
                    tmpdir: os.tmpdir(),
                    maxOutputBytes,
                  },
                  parsed,
                  {},
                );
                return renderResult(result, maxOutputBytes);
              };

              if ((parsed as { background?: unknown }).background === true) {
                const job = await jobs.start(spec.name, runSpec);
                return {
                  content: JSON.stringify(
                    {
                      jobId: job.id,
                      tool: job.tool,
                      state: job.state,
                      statusPath: job.statusPath,
                    },
                    null,
                    2,
                  ),
                  metadata: {
                    ok: true,
                    background: true,
                    jobId: job.id,
                    statusPath: job.statusPath,
                  },
                };
              }

              return await runSpec(context.signal);
            } catch (error) {
              if (error instanceof FsError) {
                return renderError(error, error.code === "outside");
              }
              throw error;
            }
          },
        });
      }

      editor.add({
        name: "job",
        description:
          "Inspect, wait for, cancel, or list background fs jobs. Jobs are created by passing background: true to any fs tool. wait returns the original tool result when the job completes; a timeout returns the current status.",
        input: JOB_SCHEMA,
        options: { namespace: "fs", permission: "fs_job" },
        execute: async (input, _context) => {
          try {
            const parsed = parseSchema<{
              id?: string;
              wait?: boolean;
              cancel?: boolean;
              list?: boolean;
              timeoutMs?: number;
            }>(JOB_SCHEMA, input, "job input");

            if (parsed.list === true) {
              if (parsed.id !== undefined || parsed.wait === true || parsed.cancel === true) {
                throw new FsError("list cannot be combined with id, wait, or cancel.", "invalid");
              }
              return {
                content: JSON.stringify({ jobs: jobs.list() }, null, 2),
                metadata: { ok: true },
              };
            }

            if (!parsed.id) throw new FsError("job requires id or list.", "invalid");

            if (parsed.cancel === true) {
              if (parsed.wait === true) {
                throw new FsError("cancel and wait are mutually exclusive.", "invalid");
              }
              const status = jobs.cancel(parsed.id);
              return {
                content: JSON.stringify(status, null, 2),
                metadata: { ok: true, jobId: status.id, state: status.state },
              };
            }

            if (parsed.wait === true) {
              const waited = await jobs.wait(parsed.id, parsed.timeoutMs ?? 600000);
              if (waited.result) {
                return {
                  content: waited.result.content,
                  metadata: {
                    ...waited.result.metadata,
                    jobId: waited.status.id,
                    state: waited.status.state,
                    timedOut: waited.timedOut,
                  },
                };
              }
              return {
                content: JSON.stringify({ ...waited.status, timedOut: waited.timedOut }, null, 2),
                metadata: {
                  ok: false,
                  jobId: waited.status.id,
                  state: waited.status.state,
                  timedOut: waited.timedOut,
                },
              };
            }

            const status = jobs.status(parsed.id);
            return {
              content: JSON.stringify(status, null, 2),
              metadata: { ok: true, jobId: status.id, state: status.state },
            };
          } catch (error) {
            if (error instanceof FsError) return renderError(error, error.code === "outside");
            throw error;
          }
        },
      });
    });

    return () => {
      jobs.dispose();
      void registration.dispose();
    };
  },
});
