/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { Violation } from "procage";
import { FsError } from "../core/errors.js";
import { collect } from "../core/stream.js";
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
    network: Type.Optional(
      Type.Boolean({
        description: "Allow IP network after `fs_exec_network` approval. Default: false.",
      }),
    ),
    allowPaths: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String({ minLength: 1, description: "External path to expose after approval." }),
            mode: Type.Optional(
              Type.Union([Type.Literal("ro"), Type.Literal("rw")], { description: "Read-only or read-write. Default: rw." }),
            ),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

type Input = Static<typeof Schema>;

interface PolicyDocument {
  fs: Array<{ access: string; target: { subpath: string } }>;
  net: string;
  [key: string]: unknown;
}

interface ExecOutcome {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  violations: Violation[];
}

let procage: Promise<typeof import("procage")> | undefined;

function loadProcage(): Promise<typeof import("procage")> {
  procage ??= import("procage");
  return procage;
}

export const execTool: ToolSpec<Input> = {
  name: "exec",
  description:
    "Run an allowlisted executable in a procage sandbox without a shell. Direct calls return JSON; " +
    "pipe stages pass raw stdout. Default allowlist: npm, npx, uv, uvx, pip, pip3. Network and external " +
    "paths are denied until approved.",
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
    const cwdTarget = await ctx.sandbox.resolveExisting(requested, { allowRoot: true });
    const cwdStats = await ctx.sandbox.stat(cwdTarget.full, requested);
    if (!cwdStats.isDirectory()) throw new FsError(`exec cwd is not a directory: "${requested}"`, "not-directory");
    await ctx.permission.assert([{ target: cwdTarget, boundary: cwdTarget.full }]);
    if (ctx.signal.aborted) throw new FsError("exec interrupted.", "interrupted");

    if (input.network === true) await ctx.permissionFor("fs_exec_network").assert([]);

    const allowed: Array<{ full: string; mode: "ro" | "rw" }> = [];
    for (const entry of input.allowPaths ?? []) {
      const target = await ctx.sandbox.resolveExisting(entry.path, { allowRoot: true });
      await ctx.permission.assert([{ target, boundary: target.full }]);
      const mode = entry.mode ?? "rw";
      if (!allowed.some((item) => item.full === target.full && item.mode === mode)) {
        allowed.push({ full: target.full, mode });
      }
    }

    const executable = await resolveExecutable(command);
    const tempDir = await fs.mkdtemp(path.join(ctx.tmpdir, "fs-exec-"));
    try {
      const outcome = await runCaged(ctx, {
        command,
        executable,
        args,
        cwd: cwdTarget.full,
        timeoutMs: input.timeoutMs ?? 120_000,
        network: input.network === true,
        allowed,
        tempDir,
        input: io.stdin === undefined
          ? input.stdin === undefined ? undefined : Buffer.from(input.stdin)
          : await collect(io.stdin),
      });
      const metadata = {
        command,
        args,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        stdoutTruncated: outcome.stdoutTruncated,
        stderrTruncated: outcome.stderrTruncated,
        sandboxBlocked: isSandboxBlocked(outcome),
        violations: outcome.violations.length,
        network: input.network === true,
        allowPaths: allowed,
      };
      if (io.piped === true) {
        return {
          stdout: outcome.stdout,
          stderr: outcome.stderr.toString("utf8"),
          exitCode: outcome.exitCode === 0 ? 0 : 1,
          metadata,
        };
      }
      const sandboxBlocked = isSandboxBlocked(outcome);
      const body = {
        ...metadata,
        stdout: outcome.stdout.toString("utf8"),
        stderr: outcome.stderr.toString("utf8"),
        violations: outcome.violations,
        ...(sandboxBlocked
          ? {
              hint:
                "The sandbox denied an external path or network access. Ask the user, then retry with allowPaths or network: true.",
            }
          : {}),
      };
      return textResult(JSON.stringify(body, null, 2), metadata, outcome.exitCode === 0 ? 0 : 1);
    } finally {
      /* v8 ignore next 5 */
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  },
};

interface CagedInput {
  command: string;
  executable: { path: string; real: string };
  args: string[];
  cwd: string;
  timeoutMs: number;
  network: boolean;
  allowed: Array<{ full: string; mode: "ro" | "rw" }>;
  tempDir: string;
  input: Buffer | undefined;
}

async function runCaged(ctx: RunContext, input: CagedInput): Promise<ExecOutcome> {
  let api: typeof import("procage");
  try {
    api = await loadProcage();
  } catch (error) {
    /* v8 ignore next */
    throw new FsError(`exec sandbox is unavailable: ${String(error)}`, "unsupported");
  }

  const doc = api.Policy.preset("agent_workspace", 3, { workspace: ctx.sandbox.root }).toJSON() as PolicyDocument;
  doc.net = input.network ? "ip" : "none";
  addRule(doc, "exec", path.dirname(input.executable.path));
  addRule(doc, "exec", path.dirname(input.executable.real));
  addRule(doc, "exec", path.dirname(process.execPath));
  addRule(doc, "exec", path.resolve(path.dirname(process.execPath), ".."));
  addRule(doc, "exec", path.dirname(input.executable.real));
  addRule(doc, "exec", path.resolve(path.dirname(input.executable.real), ".."));
  for (const root of ["/home/linuxbrew", "/var/home/linuxbrew"]) {
    try {
      await fs.access(root);
      addRule(doc, "read", root);
      addRule(doc, "exec", root);
    } catch {
      // Homebrew is optional.
    }
  }
  addRule(doc, "write", input.tempDir);
  addRule(doc, "write", input.cwd);
  for (const allowed of input.allowed) addRule(doc, allowed.mode === "ro" ? "read" : "write", allowed.full);

  let cage: InstanceType<typeof api.Cage>;
  let policy: ReturnType<typeof api.Policy.fromJSON>;
  try {
    policy = api.Policy.fromJSON(doc);
    cage = new api.Cage(policy, {
      violations: true,
      acceptSpawnSnapshot: true,
      relax: ["signals-same-user"],
    });
  } catch (error) {
    /* v8 ignore next */
    throw new FsError(`exec policy rejected: ${String(error)}`, "unsupported");
  }

  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.TMPDIR = input.tempDir;

  let child;
  try {
    child = await cage.spawn([input.executable.path, ...input.args], {
      cwd: input.cwd,
      env,
      stdin: input.input !== undefined,
    });
  } catch (error) {
    /* v8 ignore next */
    throw new FsError(`exec spawn failed: ${String(error)}`, "unsupported");
  }

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child?.kill();
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const out = await child.output({ timeout: input.timeoutMs, ...(input.input === undefined ? {} : { input: input.input }) });
    const violations = filterViolations(await child.violations());
    const stdout = cap(out.stdout, ctx.maxOutputBytes);
    const stderr = cap(out.stderr, ctx.maxOutputBytes);
    return {
      stdout: stdout.data,
      stderr: stderr.data,
      exitCode: out.timedOut ? 124 : aborted ? 130 : (out.exitCode ?? 1),
      signal: out.signal,
      timedOut: out.timedOut,
      aborted,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      violations,
    };
  } catch (error) {
    /* v8 ignore next 14 */
    if (aborted || ctx.signal.aborted) {
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: 130,
        signal: null,
        timedOut: false,
        aborted: true,
        stdoutTruncated: false,
        stderrTruncated: false,
        violations: [],
      };
    }
    /* v8 ignore next */
    throw new FsError(`exec failed: ${String(error)}`, "unsupported");
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    child.close();
  }
}

function addRule(doc: PolicyDocument, access: string, target: string): void {
  const subpath = path.resolve(target);
  if (doc.fs.some((rule) => rule.access === access && rule.target.subpath === subpath)) return;
  doc.fs.push({ access, target: { subpath } });
}

export function filterViolations(violations: readonly Violation[]): Violation[] {
  return violations.filter((violation) => {
    if (violation.target?.startsWith("/")) return true;
    return /AF_INET|AF_INET6/.test(violation.target ?? "");
  });
}

function isSandboxBlocked(outcome: ExecOutcome): boolean {
  if (outcome.violations.length > 0) return true;
  if (outcome.exitCode === 0) return false;
  return /EACCES|EPERM|EROFS|Permission denied|Read-only file system/i.test(outcome.stderr.toString("utf8"));
}

async function resolveExecutable(command: string): Promise<{ path: string; real: string }> {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, command);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return { path: candidate, real: await fs.realpath(candidate) };
    } catch {
      // keep searching PATH
    }
  }
  throw new FsError(`exec command not found: "${command}"`, "not-found");
}

function cap(data: Buffer, limit: number): { data: Buffer; truncated: boolean } {
  if (data.length <= limit) return { data, truncated: false };
  return { data: data.subarray(0, limit), truncated: true };
}
