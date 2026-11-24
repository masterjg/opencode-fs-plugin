/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { Relaxation, Violation } from "procage";
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
 * Sockets used by the name-service resolvers on common Linux systems:
 * systemd-resolved, nscd, and SSSD. Plain glibc/musl DNS over UDP needs none.
 * Landlock ignores paths that do not exist on the host.
 */
export const RESOLVER_SOCKETS = ["/run/systemd/resolve", "/run/nscd", "/var/lib/sss/pipes"] as const;

/** The proxy allowlist must not be empty; this name never resolves. */
export const PROXY_SENTINEL = "procage.invalid";

/** How a run reaches the network: the per-host proxy, or all-IP. */
export type NetworkMode = "proxy" | "ip";

/** `ip` adds all-IP networking; both modes get the local resolver sockets. */
export function applyNetworkPolicy(doc: PolicyDocument, mode: NetworkMode): void {
  doc.ipc.unix_sockets = [...RESOLVER_SOCKETS];
  if (mode === "ip") doc.net = "ip";
}

/** A host the run's proxy refused. */
export interface ProxyHost {
  /** Host without a port, for the permission resource. */
  host: string;
  /** `host:port`, for the allowlist entry. */
  entry: string;
}

/** The refused host in a proxy violation, if this violation is one. */
export function proxyHostOf(violation: Violation): ProxyHost | undefined {
  if (violation.operation !== "network-outbound") return undefined;
  const match = /^(\[[^\]]+\]|[^\s:]+)(?::(\d+))? \(not on the allowlist\)$/.exec(violation.target ?? "");
  if (match === null) return undefined;
  const raw = match[1]!;
  const host = raw.startsWith("[") ? raw.slice(1, -1) : raw;
  return { host, entry: match[2] === undefined ? raw : `${raw}:${match[2]}` };
}

/**
 * Ask `fs_exec_network` for every host the run's proxy refused, and add the
 * approved ones to `hosts`. Returns whether the list grew.
 */
export async function approveProxyHosts(
  ctx: Pick<RunContext, "permissionFor">,
  outcome: ExecOutcome,
  hosts: string[],
): Promise<boolean> {
  if (outcome.networkMode !== "proxy") return false;
  let added = false;
  for (const violation of outcome.violations) {
    const host = proxyHostOf(violation);
    if (host === undefined || hosts.includes(host.entry)) continue;
    await ctx.permissionFor("fs_exec_network").assertTrusted([host.host]);
    hosts.push(host.entry);
    added = true;
  }
  return added;
}

/** Whether the host cannot keep a run to a proxy-only route (Linux T2). */
export function isProxyGap(error: unknown, api: typeof import("procage")): boolean {
  return error instanceof api.CapabilityGapError && error.gaps.some((gap) => gap.construct === "net-proxy");
}

/** The host cannot build a proxy-only route, so the run needs all-IP. */
export class ProxyUnavailableError extends Error {
  constructor() {
    super("egress proxy is unavailable on this host");
    this.name = "ProxyUnavailableError";
  }
}

/** Whether a failed proxy attempt should retry with all-IP networking. */
export function shouldEscalateIp(error: unknown, mode: NetworkMode): boolean {
  return mode === "proxy" && error instanceof ProxyUnavailableError;
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\[[0-9a-fA-F:]+\]/g;
const URL_HOST = /[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/\s:'"?#]+)/gi;
const HOST_PORT = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|localhost):\d{1,5}\b/gi;
const CONNECT_HOST = /\b(?:connect(?:ing|ion)? to|host|url|address)[\s'"]+((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
const GETADDRINFO_HOST = /\bgetaddrinfo\b[^\n]*?\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
const AT_HOST = /(?:^|\s)@(?:\[([^\]]+)\]|((?:[a-z0-9-]+\.)+[a-z]{2,}))/gi;
const ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)$/i;

function stripBrackets(value: string): string {
  const host = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return host.toLowerCase().replace(/\.$/, "");
}

/** Addresses that name no peer: unspecified binds, never approval targets. */
function isUnspecified(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "::0";
}

/** Hosts and addresses named in run output or arguments, for network approval. */
export function networkTargetsOf(...texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(URL_HOST)) found.add(stripBrackets(match[1]!));
    for (const match of text.matchAll(HOST_PORT)) found.add(match[1]!.toLowerCase());
    for (const match of text.matchAll(CONNECT_HOST)) found.add(match[1]!.toLowerCase());
    for (const match of text.matchAll(GETADDRINFO_HOST)) found.add(match[1]!.toLowerCase());
    for (const match of text.matchAll(AT_HOST)) found.add(stripBrackets((match[1] ?? match[2])!.toLowerCase()));
    for (const match of text.matchAll(IPV4)) found.add(match[0]);
    for (const match of text.matchAll(IPV6)) found.add(stripBrackets(match[0]));
  }
  return [...found].filter((target) => !isUnspecified(target));
}

/** Prefer named hosts over addresses when both appear; addresses are the fallback. */
export function escalationTargets(...texts: readonly string[]): string[] {
  const targets = networkTargetsOf(...texts);
  const named = targets.filter((target) => !ADDRESS.test(target));
  return named.length > 0 ? named : targets;
}

/** Ask for all-IP networking after the run cannot use the proxy. */
export async function approveIpFallback(
  ctx: Pick<RunContext, "permissionFor">,
  targets: readonly string[],
): Promise<void> {
  await ctx.permissionFor("fs_exec_network").assertTrusted(targets.length === 0 ? ["*"] : [...targets]);
}

/** Why a blocked run failed, and what to do about it. */
export function blockedHint(mode: NetworkMode): string {
  return mode === "proxy"
    ? "The run's network is proxy-only and a program tried to bypass it. Approve the refused host, or allow all networking (`fs_exec_network` resource `*`) to retry with all-IP."
    : "The sandbox denied an external path or network access. Approve the path or network in the permission prompt and retry.";
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

export const execTool: ToolSpec<Input> = {
  name: "exec",
  description:
    "Run an allowlisted executable in a procage sandbox without a shell. Direct calls return JSON; " +
    "pipe stages pass raw stdout. Default allowlist: npm, npx, uv, uvx, pip, pip3. Network is forced " +
    "through the run's allowlist proxy by default; a refused host asks fs_exec_network.",
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

    const executable = await resolveExecutable(command);
    const tempDir = await fs.mkdtemp(path.join(ctx.tmpdir, "fs-exec-"));
    try {
      const inputData = io.stdin === undefined
        ? input.stdin === undefined ? undefined : Buffer.from(input.stdin)
        : await collect(io.stdin);
      let networkMode: NetworkMode = "proxy";
      const proxyHosts: string[] = [];
      const approved: Array<{ full: string }> = [];
      let outcome: ExecOutcome | undefined;

      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          outcome = await runCaged(ctx, {
            command,
            executable,
            args,
            cwd: cwdTarget.full,
            timeoutMs: input.timeoutMs ?? 120_000,
            networkMode,
            proxyHosts,
            allowed: approved,
            tempDir,
            input: inputData,
          });
        } catch (error) {
          /* v8 ignore start -- Linux T2 has no proxy route to trigger this here */
          if (shouldEscalateIp(error, networkMode)) {
            await approveIpFallback(ctx, escalationTargets(...args));
            networkMode = "ip";
            continue;
          }
          /* v8 ignore stop */
          /* v8 ignore next */
          throw error;
        }

        if (networkMode === "proxy") {
          if (await approveProxyHosts(ctx, outcome, proxyHosts)) continue;
          if (detectsNetworkDenial(outcome)) {
            await approveIpFallback(ctx, escalationTargets(outcome.stderr.toString("utf8"), ...args));
            networkMode = "ip";
            continue;
          }
        }

        let added = false;
        const deniedPaths = discoverExternalPaths(ctx, outcome)
          .filter((candidate) => !approved.some((entry) => entry.full === candidate));
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
          await ctx.permission.assert([{ target: dirTarget, boundary: dirTarget.full }]);
          approved.push({ full: dirTarget.full });
          added = true;
        }
        if (!added) break;
      }

      /* v8 ignore next */
      if (outcome === undefined) throw new FsError("exec produced no result.", "io");
      const metadata = {
        command,
        args,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        sandboxBlocked: isSandboxBlocked(outcome),
        violations: outcome.violations.length,
        network: networkMode === "ip" || proxyHosts.length > 0,
        networkMode,
        networkHosts: proxyHosts,
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
  networkMode: NetworkMode;
  proxyHosts: readonly string[];
  allowed: Array<{ full: string }>;
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
  applyNetworkPolicy(doc, input.networkMode);
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
  for (const allowed of input.allowed) addRule(doc, "write", allowed.full);

  const cageOptions = {
    violations: true,
    acceptSpawnSnapshot: true,
    relax: ["waive:trust-handoff", "signals-same-user", "no-unix-sockets"] as Relaxation[],
    ...(input.networkMode === "proxy"
      ? { proxy: { allowlist: [...input.proxyHosts, PROXY_SENTINEL] } }
      : {}),
  };

  let cage: InstanceType<typeof api.Cage>;
  let policy: ReturnType<typeof api.Policy.fromJSON>;
  try {
    policy = api.Policy.fromJSON(doc);
    cage = new api.Cage(policy, cageOptions);
  } catch (error) {
    /* v8 ignore next */
    if (input.networkMode === "proxy" && isProxyGap(error, api)) throw new ProxyUnavailableError();
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
    return {
      stdout: out.stdout,
      stderr: out.stderr,
      exitCode: out.timedOut ? 124 : aborted ? 130 : (out.exitCode ?? 1),
      signal: out.signal,
      timedOut: out.timedOut,
      aborted,
      networkMode: input.networkMode,
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
        networkMode: input.networkMode,
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

export function filterViolations(violations: readonly Violation[]): Violation[] {
  return violations.filter((violation) => {
    if (proxyHostOf(violation) !== undefined) return true;
    if (violation.target?.startsWith("/")) return true;
    return /AF_INET|AF_INET6/.test(violation.target ?? "");
  });
}

export function isSandboxBlocked(outcome: ExecOutcome): boolean {
  if (outcome.violations.length > 0) return true;
  if (outcome.exitCode === 0) return false;
  return /EACCES|EPERM|EROFS|Permission denied|Read-only file system/i.test(outcome.stderr.toString("utf8"));
}

export function detectsNetworkDenial(outcome: ExecOutcome): boolean {
  if (outcome.violations.some((violation) => /AF_INET|AF_INET6/.test(violation.target ?? ""))) return true;
  const text = `${outcome.stderr.toString("utf8")}\n${outcome.stdout.toString("utf8")}`;
  return /(?:EACCES|EPERM|Operation not permitted)[^\n]*(?:connect|bind|socket)|(?:connect|bind|socket)[^\n]*(?:EACCES|EPERM|Operation not permitted)|EAI_AGAIN|getaddrinfo|ENETUNREACH|EHOSTUNREACH|Failed to connect|Could not connect|Network is unreachable/i.test(
    text,
  );
}

export function discoverExternalPaths(ctx: RunContext, outcome: ExecOutcome): string[] {
  const found = new Set<string>();
  for (const violation of outcome.violations) {
    if (violation.target?.startsWith("/")) found.add(violation.target);
  }

  const stderr = outcome.stderr.toString("utf8");
  if (/EACCES|EPERM|EROFS|Permission denied|Read-only file system|error writing|not written|cannot open|failed to open/i.test(stderr)) {
    for (const line of stderr.split("\n")) {
      for (const match of line.matchAll(/(?:^|[\s'"`(])(\/[^\s'"`),]+)/g)) {
        found.add(match[1]!);
      }
    }
  }
  for (const match of stderr.matchAll(/path:\s*['"]([^'"]+)['"]/g)) {
    found.add(match[1]!);
  }

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
