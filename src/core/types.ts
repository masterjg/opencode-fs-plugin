/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import type { TSchema } from "@sinclair/typebox";
import type { EnvFileSource } from "./env-file.js";
import type { Sandbox } from "./sandbox.js";
import type { PermissionGate } from "./permissions.js";

export type PipeMode = "source" | "filter" | "sink" | false;

export interface IO {
  /** Piped input when the tool is used as a pipe stage. */
  readonly stdin?: AsyncIterable<Buffer>;
  /** True when the tool is running inside `fs.pipe`. */
  readonly piped?: boolean;
}

export interface ToolResult {
  readonly stdout: Buffer;
  readonly stderr?: string;
  readonly exitCode?: 0 | 1 | 2;
  readonly metadata?: Record<string, unknown>;
}

export interface RunContext {
  readonly sandbox: Sandbox;
  readonly permission: PermissionGate;
  readonly permissionFor: (action: string) => PermissionGate;
  readonly concurrency: number;
  readonly signal: AbortSignal;
  readonly tmpdir: string;
  /**
   * Canonical trusted executable directories configured with the plugin
   * `commandPaths` option. They are prepended to PATH for `fs.command` only.
   */
  readonly commandPaths: readonly string[];
  /**
   * Validated extra environment entries configured with the plugin
   * `commandEnvVars` option. They are added to every `fs.command` child and
   * override same-named proxy or preset values; `PATH` and `TMPDIR` stay
   * plugin-managed.
   */
  readonly commandEnvVars: Readonly<Record<string, string>>;
  /**
   * Configured `commandEnvFiles` entries in merge order, each retaining its
   * original option index. `fs.command` reads them once per call, before the
   * first spawn attempt, so a rotated file applies to the next call without a
   * plugin reload and a relay fallback reuses the same snapshot. The plugin
   * reads them itself; the child sandbox gets no read rule for them.
   */
  readonly commandEnvFiles: readonly EnvFileSource[];
}

export interface ToolSpec<I> {
  readonly name: string;
  readonly description: string;
  readonly schema: TSchema;
  readonly pipeable: PipeMode;
  readonly mutates: boolean;
  readonly run: (ctx: RunContext, input: I, io: IO) => Promise<ToolResult>;
}

export function textResult(
  text: string,
  metadata: Record<string, unknown> = {},
  exitCode: 0 | 1 | 2 = 0,
): ToolResult {
  return { stdout: Buffer.from(text, "utf8"), exitCode, metadata };
}


