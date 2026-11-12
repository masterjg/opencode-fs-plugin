/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import type { TSchema } from "@sinclair/typebox";
import type { Sandbox } from "./sandbox.js";
import type { PermissionGate } from "./permissions.js";

export type PipeMode = "source" | "filter" | "sink" | false;

export interface IO {
  /** Piped input when the tool is used as a pipe stage. */
  readonly stdin?: AsyncIterable<Buffer>;
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
  readonly concurrency: number;
  readonly signal: AbortSignal;
  readonly tmpdir: string;
  readonly maxOutputBytes: number;
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

export function emptyResult(metadata: Record<string, unknown> = {}): ToolResult {
  return { stdout: Buffer.alloc(0), exitCode: 0, metadata };
}
