/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { CageOptions, Relaxation, Violation } from "procage";
import { FsError, errorMessage } from "../core/errors.js";
import { RelayControlServer } from "../core/relay-control.js";
import { collect } from "../core/stream.js";
import { textResult, type RunContext, type ToolSpec } from "../core/types.js";

/**
 * Proxy settings the child may inherit in addition to the preset's own
 * environment allowlist. They are passed explicitly because the policy's
 * allowlist does not name them. No other caller environment variable is
 * forwarded explicitly, but the preset's allowlist still applies, and a proxy
 * variable may itself carry proxy credentials.
 */
export const EXEC_PROXY_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_http_proxy",
  "npm_config_noproxy",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "NPM_CONFIG_HTTP_PROXY",
  "NPM_CONFIG_NOPROXY",
] as const;

const EXEC_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function isSafeExecName(value: string): boolean {
  return EXEC_NAME.test(value);
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

export interface PolicyDocument {
  fs: Array<{ access: string; target: { subpath: string } }>;
  net: string;
  ipc: { unix_sockets: string[] };
  [key: string]: unknown;
}

/**
 * How a run reaches the network: procage's transparent relay on Linux T1, or
 * no networking at all. There is no proxy or all-IP fallback.
 */
export type NetworkMode = "relay" | "disabled";

/** A relay control endpoint handed to procage's cage options. */
export interface RelaySettings {
  readonly socketPath: string;
  /** Unsigned 64-bit run id, as a decimal string on the wire. */
  readonly runId: bigint;
}

/** The `net-relay` gap an unsupported backend reports, if this error is one. */
export function relayGapReason(error: unknown, api: typeof import("procage")): string | undefined {
  if (!(error instanceof api.CapabilityGapError)) return undefined;
  const unsupported = error.gaps.some((gap) => gap.construct === "net-relay" && gap.kind === "unsupported");
  if (!unsupported) return undefined;
  const message = error.message.trim();
  return message.length > 0 ? message : "the transparent relay is unavailable on this host";
}

/** A recognized unsupported relay backend; the run retries with networking off. */
class RelayUnsupportedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RelayUnsupportedError";
  }
}

/** Why a blocked run failed, and what to do about it. */
export function blockedHint(mode: NetworkMode): string {
  return mode === "relay"
    ? "The sandbox denied a path or refused a network flow. Approve the denied path, or the refused resource in fs_exec_network, and retry."
    : "Networking is disabled in this sandbox. Approve the denied external path in the permission prompt and retry; relayed networking needs Linux tier T1.";
}

export interface ExecOutcome {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  /** The mode the sandbox actually ran. */
  networkMode: NetworkMode;
  violations: Violation[];
}

let procage: Promise<typeof import("procage")> | undefined;

function loadProcage(): Promise<typeof import("procage")> {
  procage ??= import("procage");
  return procage;
}

export const commandTool: ToolSpec<Input> = {
  name: "command",
  description:
    "Run an executable allowed by fs_command in a procage sandbox without a shell. Direct calls return JSON; " +
    "pipe stages pass raw stdout. On Linux tier T1 every network flow is named to the transparent relay, " +
    "which asks fs_exec_network for its exact resource; elsewhere networking is disabled.",
  schema: Schema,
  pipeable: "filter",
  mutates: true,
  async run(ctx, input, io) {
    const command = input.command.trim();
    if (!isSafeExecName(command)) {
      throw new FsError(`command must be a bare executable name: "${input.command}"`, "invalid");
    }
    const args = input.args ?? [];
    if (args.some((arg) => arg.includes("\0"))) {
      throw new FsError("arguments must not contain NUL bytes.", "invalid");
    }
    await ctx.permission.assertTrusted([command]);

    const requested = input.cwd ?? ".";
    // Follow a final symlink: the child is started in the canonical directory,
    // so a project link to an outside directory must assert that real boundary
    // and the policy write rule must name the same canonical path.
    const cwdTarget = await ctx.sandbox.resolveFollow(requested);
    const cwdStats = await ctx.sandbox.stat(cwdTarget.full, requested);
    if (!cwdStats.isDirectory()) throw new FsError(`cwd is not a directory: "${requested}"`, "not-directory");
    await ctx.permission.assertExternal([{ target: cwdTarget, boundary: cwdTarget.full }]);
    if (ctx.signal.aborted) throw new FsError("command interrupted.", "interrupted");

    const executable = await resolveExecutable(command);
    const tempDir = await fs.mkdtemp(path.join(ctx.tmpdir, "fs-exec-"));
    try {
      const inputData = io.stdin === undefined
        ? input.stdin === undefined ? undefined : Buffer.from(input.stdin)
        : await collect(io.stdin);
      const approvedResources: string[] = [];
      const approved: Array<{ full: string }> = [];
      const assertNetwork = async (resource: string) => {
        await ctx.permissionFor("fs_exec_network").assertTrusted([resource]);
        if (!approvedResources.includes(resource)) approvedResources.push(resource);
      };
      const base = {
        command,
        executable,
        args,
        cwd: cwdTarget.full,
        timeoutMs: input.timeoutMs ?? 120_000,
        allowed: approved,
        tempDir,
        input: inputData,
      };

      let attempt: RelayAttempt | undefined;
      for (let round = 0; round < 12; round++) {
        attempt = await runAttempt(ctx, base, assertNetwork);
        const deniedPaths = discoverExternalPaths(ctx, attempt.outcome)
          .filter((candidate) => !approved.some((entry) => entry.full === candidate));
        let added = false;
        for (const candidate of deniedPaths) {
          const target = await existingBoundary(ctx, candidate);
          if (target === undefined) continue;
          /* v8 ignore next */
          const stats = await ctx.sandbox.stat(target.full, candidate).catch(() => undefined);
          /* v8 ignore next */
          if (stats === undefined) continue;
          const boundary = stats.isDirectory() ? target.full : path.dirname(target.full);
          const dirTarget = await ctx.sandbox.resolveExisting(boundary, { allowRoot: true });
          if (approved.some((entry) => entry.full === dirTarget.full)) continue;
          await ctx.permission.assertExternal([{ target: dirTarget, boundary: dirTarget.full }]);
          approved.push({ full: dirTarget.full });
          added = true;
        }
        if (!added) break;
      }

      /* v8 ignore next */
      if (attempt === undefined) throw new FsError("command produced no result.", "io");
      const outcome = attempt.outcome;
      const networkMode = attempt.mode;
      const networkReason = attempt.reason;

      const metadata = {
        command,
        args,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        sandboxBlocked: isSandboxBlocked(outcome),
        violations: outcome.violations.length,
        network: networkMode === "relay",
        networkMode,
        networkHosts: approvedResources,
        ...(networkReason === undefined ? {} : { networkReason }),
        externalPaths: approved.map((entry) => entry.full),
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
        ...(sandboxBlocked ? { hint: blockedHint(networkMode) } : {}),
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
  allowed: Array<{ full: string }>;
  tempDir: string;
  input: Buffer | undefined;
  relay?: RelaySettings;
}

interface RelayAttempt {
  outcome: ExecOutcome;
  mode: NetworkMode;
  reason?: string;
}

/**
 * One spawn attempt. The relay control server starts before the cage is built
 * and stays open until the run ends; a recognized unsupported relay backend
 * closes it and retries the same attempt with networking off. A control server
 * that cannot start is treated the same way: without it every flow is refused,
 * so the run keeps networking off instead of failing outright.
 */
async function runAttempt(
  ctx: RunContext,
  base: Omit<CagedInput, "relay">,
  assertNetwork: (resource: string) => Promise<void>,
): Promise<RelayAttempt> {
  if (ctx.signal.aborted) throw interruptedError();
  const runId = randomBytes(8).readBigUInt64BE(0);
  const control = new RelayControlServer({ runId, assertNetwork });
  let socketPath: string;
  try {
    socketPath = await control.start();
  } catch (error) {
    // An abort during relay setup must not fall through to an offline child.
    if (ctx.signal.aborted) throw interruptedError();
    // Nothing is granted without the relay, so this fallback cannot mask a
    // denial; it only reports why networking is disabled.
    return {
      outcome: await runCaged(ctx, base),
      mode: "disabled",
      reason: errorMessage(error),
    };
  }
  try {
    if (ctx.signal.aborted) throw interruptedError();
    try {
      return { outcome: await runCaged(ctx, { ...base, relay: { runId, socketPath } }), mode: "relay" };
    } catch (error) {
      if (!(error instanceof RelayUnsupportedError)) throw error;
      return { outcome: await runCaged(ctx, base), mode: "disabled", reason: error.message };
    }
  } finally {
    await control.close();
  }
}

function interruptedError(): FsError {
  return new FsError("exec interrupted.", "interrupted");
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
  // Networking is off unless procage's relay replaces this policy value with
  // `Network::Relay`; the plugin never grants IP networking or resolver sockets.
  doc.net = "none";
  addRule(doc, "exec", path.dirname(input.executable.path));
  addRule(doc, "exec", path.dirname(input.executable.real));
  addRule(doc, "exec", path.dirname(process.execPath));
  addRule(doc, "exec", path.resolve(path.dirname(process.execPath), ".."));
  addRule(doc, "exec", path.dirname(input.executable.real));
  addRule(doc, "exec", path.resolve(path.dirname(input.executable.real), ".."));
  await addOptionalRoots(doc, ["/home/linuxbrew", "/var/home/linuxbrew"], (root) => fs.access(root));
  addRule(doc, "write", input.tempDir);
  addRule(doc, "write", input.cwd);
  for (const allowed of input.allowed) addRule(doc, "write", allowed.full);

  const cageOptions: CageOptions = {
    violations: true,
    acceptSpawnSnapshot: true,
    relax: ["waive:trust-handoff", "signals-same-user", "no-unix-sockets"] as Relaxation[],
    ...(input.relay === undefined
      ? {}
      : {
          relay_control_socket: input.relay.socketPath,
          relay_run_id: input.relay.runId.toString(),
        }),
  };

  let cage: InstanceType<typeof api.Cage>;
  let policy: ReturnType<typeof api.Policy.fromJSON>;
  try {
    policy = api.Policy.fromJSON(doc);
    cage = new api.Cage(policy, cageOptions);
  } catch (error) {
    if (input.relay !== undefined) {
      const reason = relayGapReason(error, api);
      if (reason !== undefined) throw new RelayUnsupportedError(reason);
    }
    throw new FsError(`exec policy rejected: ${errorMessage(error)}`, "unsupported");
  }

  // The policy's allowlist supplies HOME, LANG, LC_ALL, PATH, TERM, TMPDIR and
  // USER. Explicit values win over that allowlist, so pass only the tool's own
  // TMPDIR and proxy settings: forwarding process.env would defeat the
  // preset's secret filtering. The transparent relay treats a connection to the
  // proxy as the proxy's own destination (never its CONNECT target), so the
  // proxy's address, or its cached DNS name, is authorized through
  // fs_exec_network; the target URL behind the proxy is never treated as
  // approved.
  const env: Record<string, string> = { TMPDIR: input.tempDir };
  for (const name of EXEC_PROXY_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  // Attach the listener before the spawn: an abort during the spawn await must
  // still reach the child once it exists. The flag also captures an abort that
  // already arrived during relay setup or cage construction, which a listener
  // attached afterwards would never see.
  let child!: Awaited<ReturnType<typeof cage.spawn>>;
  let aborted = ctx.signal.aborted;
  const onAbort = () => {
    aborted = true;
    child?.kill();
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    // An abort that arrived during relay setup or cage construction must not
    // start a child at all.
    if (aborted) throw interruptedError();
    try {
      child = await cage.spawn([input.executable.path, ...input.args], {
        cwd: input.cwd,
        env,
        stdin: input.input !== undefined,
      });
    } catch (error) {
      if (aborted || ctx.signal.aborted) throw interruptedError();
      throw new FsError(`exec spawn failed: ${String(error)}`, "unsupported");
    }

    // The abort listener could not kill a child that did not exist yet.
    if (aborted) child.kill();

    try {
      const out = await child.output({ timeout: input.timeoutMs, ...(input.input === undefined ? {} : { input: input.input }) });
      const violations = filterViolations(await child.violations());
      return {
        stdout: out.stdout,
        stderr: out.stderr,
        exitCode: out.timedOut ? 124 : aborted ? 130 : (out.exitCode ?? 1),
        signal: out.signal,
        timedOut: out.timedOut,
        aborted,
        networkMode: input.relay === undefined ? "disabled" : "relay",
        violations,
      };
    } catch (error) {
      /* v8 ignore next 15 */
      if (aborted || ctx.signal.aborted) {
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 130,
          signal: null,
          timedOut: false,
          aborted: true,
          networkMode: input.relay === undefined ? "disabled" : "relay",
          violations: [],
        };
      }
      /* v8 ignore next */
      throw new FsError(`exec failed: ${String(error)}`, "unsupported");
    } finally {
      child.close();
    }
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Resolve a denied path to the nearest existing ancestor, so a missing
 * directory or a redacted temp name still yields an approvable boundary.
 * The filesystem root is never exposed.
 */
async function existingBoundary(ctx: RunContext, candidate: string) {
  let current = candidate;
  for (;;) {
    /* v8 ignore next */
    const target = await ctx.sandbox.resolveExisting(current, { allowRoot: true }).catch(() => undefined);
    if (target !== undefined) {
      return target.full === path.parse(target.full).root ? undefined : target;
    }
    current = path.dirname(current);
  }
}

function addRule(doc: PolicyDocument, access: string, target: string): void {
  const subpath = path.resolve(target);
  if (doc.fs.some((rule) => rule.access === access && rule.target.subpath === subpath)) return;
  doc.fs.push({ access, target: { subpath } });
}

/**
 * Grant read and exec on each optional root that exists on this host. The
 * predicate is injected so tests can simulate present and absent roots without
 * touching the real filesystem layout.
 */
export async function addOptionalRoots(
  doc: PolicyDocument,
  roots: readonly string[],
  access: (root: string) => Promise<void>,
): Promise<void> {
  for (const root of roots) {
    try {
      await access(root);
      addRule(doc, "read", root);
      addRule(doc, "exec", root);
    } catch {
      // Optional root: the preset stays portable without it.
    }
  }
}

export function filterViolations(violations: readonly Violation[]): Violation[] {
  return violations.filter((violation) => {
    if (violation.operation === "network-outbound") return true;
    if (violation.target?.startsWith("/")) return true;
    return /AF_INET|AF_INET6/.test(violation.target ?? "");
  });
}

export function isSandboxBlocked(outcome: ExecOutcome): boolean {
  if (outcome.violations.length > 0) return true;
  if (outcome.exitCode === 0) return false;
  return /EACCES|EPERM|EROFS|Permission denied|Read-only file system/i.test(outcome.stderr.toString("utf8"));
}

export function discoverExternalPaths(ctx: RunContext, outcome: ExecOutcome): string[] {
  const found = new Set<string>();
  for (const violation of outcome.violations) {
    // Only a structured write denial may become a write grant. Seatbelt names
    // that family `file-write-*`; a read, exec, network, or unknown operation
    // must never widen the boundary, even when its target is an absolute path.
    if (!violation.operation.startsWith("file-write-")) continue;
    if (violation.target?.startsWith("/")) found.add(violation.target);
  }

  // Only structured violation targets are grant candidates. The child controls
  // stdout and stderr, so a path printed there (even next to an EACCES string)
  // must never widen the permission boundary.
  const root = ctx.sandbox.root;
  return [...found]
    .map((candidate) => path.resolve(candidate))
    .map((candidate) => candidate.replace(/\/\*+$/, ""))
    .filter((candidate) => candidate !== root && !candidate.startsWith(`${root}${path.sep}`))
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
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
