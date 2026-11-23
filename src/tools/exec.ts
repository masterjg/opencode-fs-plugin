/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Type, type Static } from "@sinclair/typebox";
import { FsError, fromErrno } from "../core/errors.js";
import { textResult, type RunContext, type ToolSpec } from "../core/types.js";

export const DEFAULT_EXEC_ALLOWLIST = ["npm", "npx", "uv", "uvx", "pip", "pip3"] as const;

const EXEC_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function isSafeExecName(value: string): boolean {
  return EXEC_NAME.test(value);
}

export function normalizeExecAllowlist(value: unknown): readonly string[] {
  if (value === undefined) return DEFAULT_EXEC_ALLOWLIST;
  if (!Array.isArray(value)) throw new FsError("execAllowlist must be an array of executable names.", "invalid");
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new FsError("execAllowlist entries must be strings.", "invalid");
    const name = entry.trim();
    if (!isSafeExecName(name)) throw new FsError(`Invalid exec allowlist entry: ${entry}`, "invalid");
    names.push(name);
  }
  return [...new Set(names)];
}

const Schema = Type.Object(
  {
    command: Type.String({ minLength: 1, description: "Allowlisted executable name, without a path or shell syntax." }),
    args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed verbatim to the executable." })),
    cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory inside the project. Default: project root." })),
    stdin: Type.Optional(Type.String({ description: "Text for stdin when the tool is not used in a pipe." })),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 100, maximum: 600_000, description: "Timeout in milliseconds. Default: 120000." }),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface ExecOutcome {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export const execTool: ToolSpec<Input> = {
  name: "exec",
  description:
    "Run an allowlisted executable without a shell and return its exit code, stdout, and stderr. " +
    "Direct calls return JSON; pipe stages pass raw stdout. Default allowlist: npm, npx, uv, uvx, pip, pip3.",
  schema: Schema,
  pipeable: "filter",
  mutates: true,
  async run(ctx, input, io) {
    const command = input.command.trim();
    if (!isSafeExecName(command)) {
      throw new FsError(`exec command must be a bare executable name: "${input.command}"`, "invalid");
    }
    if (!ctx.execAllowlist.includes(command)) {
      throw new FsError(`exec command is not allowlisted: "${command}"`, "unsupported");
    }
    const args = input.args ?? [];
    if (args.some((arg) => arg.includes("\0"))) {
      throw new FsError("exec arguments must not contain NUL bytes.", "invalid");
    }

    const requested = input.cwd ?? ".";
    const target = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
    const stats = await ctx.sandbox.stat(target.full, requested);
    if (!stats.isDirectory()) throw new FsError(`exec cwd is not a directory: "${requested}"`, "not-directory");
    await ctx.permission.assert([{ target, boundary: target.full }]);
    if (ctx.signal.aborted) throw new FsError("exec interrupted.", "interrupted");

    const outcome = await runProcess(
      ctx,
      command,
      args,
      target.full,
      input.timeoutMs ?? 120_000,
      input.stdin,
      io.stdin,
    );
    const metadata = {
      command,
      args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      aborted: outcome.aborted,
      stdoutTruncated: outcome.stdoutTruncated,
      stderrTruncated: outcome.stderrTruncated,
    };
    if (io.piped === true) {
      return {
        stdout: outcome.stdout,
        stderr: outcome.stderr.toString("utf8"),
        exitCode: outcome.exitCode === 0 ? 0 : 1,
        metadata,
      };
    }
    const body = {
      ...metadata,
      stdout: outcome.stdout.toString("utf8"),
      stderr: outcome.stderr.toString("utf8"),
    };
    return textResult(JSON.stringify(body, null, 2), metadata, outcome.exitCode === 0 ? 0 : 1);
  },
};

function runProcess(
  ctx: RunContext,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input: string | undefined,
  pipe: AsyncIterable<Buffer> | undefined,
): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    const feed = input !== undefined || pipe !== undefined;
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: [feed ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const cap = ctx.maxOutputBytes;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendCapped(stdout, chunk, cap);
      stdout = next.data;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendCapped(stderr, chunk, cap);
      stderr = next.data;
      stderrTruncated ||= next.truncated;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      forceTimer = setTimeout(() => killTree(child, "SIGKILL"), 2_000);
      forceTimer.unref();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child, "SIGTERM");
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      ctx.signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      /* v8 ignore next */
      if (settled) return;
      settled = true;
      cleanup();
      reject(fromErrno(error));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : aborted ? 130 : (code ?? 1),
        signal,
        timedOut,
        aborted,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    if (feed) void feedStdin(child, input, pipe);
  });
}

async function feedStdin(
  child: ChildProcess,
  input: string | undefined,
  pipe: AsyncIterable<Buffer> | undefined,
): Promise<void> {
  const stdin = child.stdin;
  /* v8 ignore next */
  if (!stdin) return;
  try {
    stdin.on("error", () => undefined);
    if (pipe !== undefined) {
      for await (const chunk of pipe) {
        if (!stdin.write(chunk)) await once(stdin, "drain");
      }
    } else {
      stdin.write(input as string);
    }
    stdin.end();
  } catch {
    /* child closed before the write completed */
  }
}

function appendCapped(current: Buffer, chunk: Buffer, cap: number): { data: Buffer; truncated: boolean } {
  if (current.length >= cap) return { data: current, truncated: true };
  const remaining = cap - current.length;
  if (chunk.length <= remaining) return { data: Buffer.concat([current, chunk]), truncated: false };
  return { data: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  /* v8 ignore next */
  if (!child.pid) return;
  /* v8 ignore next */
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* fall through to child.kill */
    }
  }
  /* v8 ignore next 5 */
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}
