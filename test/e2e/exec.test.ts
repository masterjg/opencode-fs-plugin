/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FsError } from "../../src/core/errors.js";
import { Sandbox } from "../../src/core/sandbox.js";
import {
  DEFAULT_EXEC_ALLOWLIST,
  RESOLVER_SOCKETS,
  applyNetworkPolicy,
  approveIpFallback,
  approveProxyHosts,
  blockedHint,
  detectsNetworkDenial,
  discoverExternalPaths,
  escalationTargets,
  execTool,
  filterViolations,
  isProxyGap,
  isSandboxBlocked,
  networkTargetsOf,
  normalizeExecAllowlist,
  proxyHostOf,
  ProxyUnavailableError,
  shouldEscalateIp,
  type ExecOutcome,
} from "../../src/tools/exec.js";
import { pipeTool } from "../../src/tools/pipe.js";
import { makeOutside, makeRoot, pathExists, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot("fs-exec-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

function parsed(result: { result: { stdout: Buffer } }): Record<string, unknown> {
  return JSON.parse(result.result.stdout.toString()) as Record<string, unknown>;
}

describe("exec", () => {
  it("runs an allowlisted command and returns JSON", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "process.stdout.write('ok')"] },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ command: "node", exitCode: 0, timedOut: false, stdout: "ok", stderr: "" });
    expect(result.requests.some((request) => request.action === "fs_exec")).toBe(true);
  });

  it("captures stderr and a non-zero exit code", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "console.error('bad'); process.exit(3)"] },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ exitCode: 3, stderr: "bad\n", stdout: "" });
    expect(result.result.exitCode).toBe(1);
  });

  it("rejects commands outside the allowlist", async () => {
    const { sb } = await setup();
    await expect(runSpec(execTool, { command: "rm", args: ["-rf", "."] }, sb)).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(
      runSpec(execTool, { command: "node", args: ["-e", ""] }, sb, { execAllowlist: [] }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("rejects paths and shell syntax in the command name", async () => {
    const { sb } = await setup();
    for (const command of ["/bin/node", "node -e x", "node;rm", "../node"]) {
      await expect(runSpec(execTool, { command }, sb, { execAllowlist: [command] })).rejects.toMatchObject({
        code: "invalid",
      });
    }
  });

  it("passes arguments verbatim without a shell", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      {
        command: "node",
        args: ["-e", "console.log(process.argv.slice(1).join('|'))", "a;b", "c|d", "$HOME"],
      },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result).stdout).toBe("a;b|c|d|$HOME\n");
  });

  it("resolves cwd inside the sandbox", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "sub"));
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "process.stdout.write(process.cwd())"], cwd: "sub" },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result).stdout).toMatch(/\/sub$/);
    await fs.writeFile(path.join(root, "file"), "x");
    await expect(
      runSpec(execTool, { command: "node", args: ["-e", ""], cwd: "file" }, sb, { execAllowlist: ["node"] }),
    ).rejects.toMatchObject({ code: "not-directory" });
  });

  it("feeds direct stdin", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "process.stdin.pipe(process.stdout)"], stdin: "hello" },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result).stdout).toBe("hello");
  });

  it("times out and kills the process", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 100 },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ timedOut: true, exitCode: 124 });
  });

  it("aborts on the signal and refuses a pre-aborted signal", async () => {
    const { sb } = await setup();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 5000 },
      sb,
      { execAllowlist: ["node"], signal: controller.signal },
    );
    expect(parsed(result)).toMatchObject({ aborted: true, exitCode: 130 });

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      runSpec(execTool, { command: "node", args: ["-e", ""] }, sb, {
        execAllowlist: ["node"],
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ code: "interrupted" });
  });

  it("returns the full stdout", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      {
        command: "node",
        args: ["-e", "process.stdout.write('abc'); setTimeout(() => process.stdout.write('def'), 10)"],
      },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result).stdout).toBe("abcdef");
  });

  it("rejects an allowlisted command that does not exist", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(execTool, { command: "definitely-not-a-command" }, sb, {
        execAllowlist: ["definitely-not-a-command"],
      }),
    ).rejects.toBeInstanceOf(FsError);
  });

  it("rejects NUL bytes in arguments", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(execTool, { command: "node", args: ["a\0b"] }, sb, { execAllowlist: ["node"] }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("returns exit code 1 when the child is killed by a signal", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "process.kill(process.pid, 'SIGTERM')"] },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ exitCode: 1, signal: "SIGTERM" });
  });

  it("returns the full stderr", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "process.stderr.write('abcdef')"] },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result).stderr).toBe("abcdef");
  });

  it("forces SIGKILL when the child ignores SIGTERM", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      {
        command: "node",
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        timeoutMs: 500,
      },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ timedOut: true, exitCode: 124 });
  });

  it("survives a child closing stdin before the write completes", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "process.exit(0)"], stdin: "x".repeat(1_000_000) },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ exitCode: 0 });
  });

  it("works as a pipe source", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "exec", args: { command: "node", args: ["-e", "process.stdout.write('abc')"] } },
          { tool: "cat" },
        ],
      },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(result.result.stdout.toString()).toBe("abc");
  });

  it("auto-approves a denied external path", async () => {
    const { sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const file = path.join(outside.dir, "out.txt");
    await fs.writeFile(file, "old\n");
    const result = await runSpec(
      execTool,
      {
        command: "node",
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(file)}, "ok")`],
      },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result).exitCode).toBe(0);
    expect(result.requests.some((request) => request.action === "external_directory")).toBe(true);
    expect(parsed(result).externalPaths).toContain(outside.dir);
    expect(await fs.readFile(file, "utf8")).toBe("ok");
  });

  it("approves a denied directory boundary", async () => {
    const { sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const script = `console.error('EACCES ' + ${JSON.stringify(outside.dir)}); process.exit(1);`;
    const result = await runSpec(execTool, { command: "node", args: ["-e", script] }, sb, {
      execAllowlist: ["node"],
    });
    expect(result.requests.some((request) => request.action === "external_directory")).toBe(true);
    expect(parsed(result).externalPaths).toContain(outside.dir);
  });

  it("reports a path that remains denied after approval", async () => {
    const { sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const file = path.join(outside.dir, "readonly.txt");
    await fs.writeFile(file, "ro\n");
    await fs.chmod(file, 0o444);
    const result = await runSpec(
      execTool,
      {
        command: "node",
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(file)}, "no")`],
      },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ sandboxBlocked: true, exitCode: 1 });
    expect(parsed(result).stderr).toMatch(/EACCES|EPERM|EROFS/);
    expect(parsed(result).externalPaths).toContain(outside.dir);
  });

  it("approves the nearest existing ancestor of a missing path", async () => {
    const { sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const missing = path.join(outside.dir, "missing", "nested", "***");
    const script = `console.error('EACCES ' + ${JSON.stringify(missing)}); process.exit(1);`;
    const result = await runSpec(execTool, { command: "node", args: ["-e", script] }, sb, {
      execAllowlist: ["node"],
    });
    expect(parsed(result).externalPaths).toContain(outside.dir);
  });

  it("escalates a proxied run that needs a direct route to all-IP", async () => {
    const { sb } = await setup();
    const script =
      "const n=require('net');const s=n.connect(443,'1.1.1.1');" +
      "s.on('connect',()=>process.exit(0));" +
      "s.on('error',(e)=>{console.error(e.message);process.exit(0)});" +
      "setTimeout(()=>process.exit(0),3000);";
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", script] },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(
      result.requests.some(
        (request) => request.action === "fs_exec_network" && request.resources.includes("1.1.1.1"),
      ),
    ).toBe(true);
    expect(parsed(result)).toMatchObject({ network: true, networkMode: "ip" });
  });

  it("escalates UDP to all-IP for an approved address", async () => {
    const { sb } = await setup();
    const script =
      "const d=require('dgram').createSocket('udp4');" +
      "d.on('error',(e)=>{console.error(e.message);process.exit(0)});" +
      "d.send('x',53,'8.8.8.8',(e)=>{if(e)console.error(e.message);process.exit(0)});" +
      "setTimeout(()=>process.exit(0),3000);";
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", script] },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(
      result.requests.some(
        (request) => request.action === "fs_exec_network" && request.resources.includes("8.8.8.8"),
      ),
    ).toBe(true);
    expect(parsed(result)).toMatchObject({ network: true, networkMode: "ip" });
  });

  it("forces network through the proxy and asks for every host", async () => {
    const { sb } = await setup();
    const allowed = await runSpec(
      execTool,
      { command: "curl", args: ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"] },
      sb,
      { execAllowlist: ["curl"] },
    );
    // Linux T2 has no proxy-only route; the run falls back to all-IP.
    if (parsed(allowed).networkMode !== "proxy") return;
    expect(parsed(allowed)).toMatchObject({ exitCode: 0, network: true, networkMode: "proxy" });
    expect(parsed(allowed).networkHosts).toEqual(["example.com:443"]);
    expect(
      allowed.requests.some(
        (request) => request.action === "fs_exec_network" && request.resources.includes("example.com"),
      ),
    ).toBe(true);

    const refused = await runSpec(
      execTool,
      { command: "curl", args: ["-sS", "https://example.org"] },
      sb,
      { execAllowlist: ["curl"] },
    );
    expect(
      refused.requests.some(
        (request) => request.action === "fs_exec_network" && request.resources.includes("example.org"),
      ),
    ).toBe(true);
    expect(parsed(refused).exitCode).toBe(0);
    expect(parsed(refused).networkHosts).toContain("example.org:443");
  });

  it("runs npm through the proxy after approving its host", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      { command: "npm", args: ["view", "npm", "version", "--fetch-retries=0"], timeoutMs: 60_000 },
      sb,
      { execAllowlist: ["npm"] },
    );
    if (parsed(result).networkMode !== "proxy") return;
    expect(parsed(result).exitCode).toBe(0);
    expect(
      result.requests.some(
        (request) =>
          request.action === "fs_exec_network" && request.resources.includes("registry.npmjs.org"),
      ),
    ).toBe(true);
    expect(parsed(result).networkHosts).toContain("registry.npmjs.org:443");
  }, 90_000);

  it("escalates a proxy-ignoring client to all-IP", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      {
        command: "curl",
        args: ["--noproxy", "*", "-sS", "-o", "/dev/null", "https://example.com"],
      },
      sb,
      { execAllowlist: ["curl"] },
    );
    expect(
      result.requests.some(
        (request) => request.action === "fs_exec_network" && request.resources.includes("example.com"),
      ),
    ).toBe(true);
    expect(parsed(result)).toMatchObject({ network: true, networkMode: "ip" });
  });

  it("handles an unapprovable path and a repeated denial", async () => {
    const { sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const file = path.join(outside.dir, "readonly.txt");
    await fs.writeFile(file, "ro\n");
    await fs.chmod(file, 0o444);
    const script = [
      "const fs=require('fs');",
      `try{fs.writeFileSync(${JSON.stringify(file)},"no")}catch(e){`,
      "console.error('EACCES /nonexistent/fs-exec/path');",
      "console.error(e.message);",
      "}",
      "process.exit(1);",
    ].join("");
    const result = await runSpec(execTool, { command: "node", args: ["-e", script] }, sb, {
      execAllowlist: ["node"],
    });
    expect(parsed(result)).toMatchObject({ sandboxBlocked: true, exitCode: 1 });
    expect(parsed(result).externalPaths).toContain(outside.dir);
    expect(result.requests.some((request) => request.action === "external_directory")).toBe(true);
  });

  it("kills detached descendants", async () => {
    const { root, sb } = await setup();
    const out = path.join(root, "child.alive");
    const script = [
      "const {spawn}=require('child_process'),fs=require('fs');",
      `const code='setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(out)},"1"),1000)';`,
      'spawn(process.execPath,["-e",code],{detached:true,stdio:"ignore"}).unref();',
      "process.exit(0);",
    ].join("");
    await runSpec(execTool, { command: "node", args: ["-e", script] }, sb, { execAllowlist: ["node"] });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await pathExists(out)).toBe(false);
  });

  it("reports a missing executable", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(execTool, { command: "missing-exec-command" }, sb, { execAllowlist: ["missing-exec-command"] }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("maps a piped non-zero exit to 1", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "exec", args: { command: "node", args: ["-e", "process.exit(3)"] } },
          { tool: "cat" },
        ],
      },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(result.result.metadata?.stages?.[0]).toMatchObject({ tool: "exec", exitCode: 1 });
  });

  it("works as a pipe filter", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "in.txt"), "xyz\n");
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "cat", args: { paths: ["in.txt"] } },
          { tool: "exec", args: { command: "node", args: ["-e", "process.stdin.pipe(process.stdout)"] } },
          { tool: "cat" },
        ],
      },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(result.result.stdout.toString()).toBe("xyz\n");
  });

  it("applies stdin backpressure in a pipe", async () => {
    const { sb } = await setup();
    const input = "x".repeat(2_000_000);
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "exec", args: { command: "node", args: ["-e", "process.stdin.pipe(process.stdout)"] } },
          { tool: "cat" },
        ],
        input,
      },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(result.result.stdout.length).toBeGreaterThan(0);
  });
});

describe("exec sandbox helpers", () => {
  it("sets resolver sockets in both modes and IP networking only for ip", () => {
    const on = { fs: [], net: "none", ipc: { unix_sockets: [] as string[] } };
    applyNetworkPolicy(on, "ip");
    expect(on.net).toBe("ip");
    expect(on.ipc.unix_sockets).toEqual([...RESOLVER_SOCKETS]);

    const proxy = { fs: [], net: "none", ipc: { unix_sockets: [] as string[] } };
    applyNetworkPolicy(proxy, "proxy");
    expect(proxy.net).toBe("none");
    expect(proxy.ipc.unix_sockets).toEqual([...RESOLVER_SOCKETS]);
  });

  const outcome = (overrides: Partial<ExecOutcome> = {}): ExecOutcome => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    networkMode: "ip",
    violations: [],
    ...overrides,
  });
  const violation = (target: string) => ({
    pid: 1,
    process: "node",
    operation: "openat",
    target,
    deniedBy: "not granted",
    repeats: 1,
    message: "denied",
  });

  it("discovers and filters blocked paths", async () => {
    const { root, sb } = await setup();
    const found = discoverExternalPaths(
      { sandbox: sb } as never,
      outcome({
        stderr: Buffer.from("EACCES: permission denied, open '/home/a/x'\nEACCES: open '/home/c/***'\n"),
        violations: [
          violation("/home/b"),
          violation("/home/a/x"),
          violation(`${root}/inside`),
          { ...violation(""), target: null },
          violation("family AF_INET"),
        ],
      }),
    );
    expect(found.sort()).toEqual(["/home/a/x", "/home/b", "/home/c"]);

    const ignored = discoverExternalPaths(
      { sandbox: sb } as never,
      outcome({ stderr: Buffer.from("look at /home/z\n") }),
    );
    expect(ignored).toEqual([]);
  });

  it("classifies blocked and network results", () => {
    expect(isSandboxBlocked(outcome({ violations: [violation("/home/a")] }))).toBe(true);
    expect(isSandboxBlocked(outcome({ stderr: Buffer.from("EACCES"), exitCode: 1 }))).toBe(true);
    expect(isSandboxBlocked(outcome())).toBe(false);
    expect(detectsNetworkDenial(outcome({ violations: [violation("family AF_INET")] }))).toBe(true);
    expect(detectsNetworkDenial(outcome({ stderr: Buffer.from("EAI_AGAIN") }))).toBe(true);
    expect(detectsNetworkDenial(outcome({ stderr: Buffer.from("connect EACCES 1.1.1.1:443") }))).toBe(true);
    expect(detectsNetworkDenial(outcome({ stdout: Buffer.from("ERR EACCES bind 0.0.0.0") }))).toBe(true);
    expect(detectsNetworkDenial(outcome({ violations: [{ ...violation("family AF_INET"), target: null }] }))).toBe(false);
    expect(detectsNetworkDenial(outcome())).toBe(false);
  });

  const proxyViolation = (target: string) => ({
    ...violation(target),
    pid: 0,
    process: "proxy",
    operation: "network-outbound",
    deniedBy: "refused by the proxy's allowlist",
  });

  it("reads the refused host from a proxy violation", () => {
    expect(proxyHostOf(proxyViolation("example.org:443 (not on the allowlist)"))).toEqual({
      host: "example.org",
      entry: "example.org:443",
    });
    expect(proxyHostOf(proxyViolation("[::1]:8080 (not on the allowlist)"))).toEqual({
      host: "::1",
      entry: "[::1]:8080",
    });
    expect(proxyHostOf(proxyViolation("example.org (not on the allowlist)"))).toEqual({
      host: "example.org",
      entry: "example.org",
    });
    expect(proxyHostOf(violation("/home/a"))).toBeUndefined();
    expect(proxyHostOf(proxyViolation("nonsense"))).toBeUndefined();
    expect(proxyHostOf({ ...proxyViolation("nonsense"), target: null })).toBeUndefined();
  });

  it("approves each refused host once", async () => {
    const asked: string[][] = [];
    const ctx = {
      permissionFor: () => ({
        assertTrusted: async (resources: string[]) => {
          asked.push(resources);
        },
      }),
    } as never;
    const hosts = ["example.com"];
    const refused = outcome({
      networkMode: "proxy",
      violations: [
        proxyViolation("example.org:443 (not on the allowlist)"),
        proxyViolation("example.org:443 (not on the allowlist)"),
      ],
    });
    expect(await approveProxyHosts(ctx, refused, hosts)).toBe(true);
    expect(asked).toEqual([["example.org"]]);
    expect(hosts).toEqual(["example.com", "example.org:443"]);
    expect(await approveProxyHosts(ctx, refused, hosts)).toBe(false);
    expect(await approveProxyHosts(ctx, outcome({ violations: refused.violations }), hosts)).toBe(false);
  });

  it("detects the proxy gap and explains a blocked run", async () => {
    const api = await import("procage");
    expect(isProxyGap(new api.CapabilityGapError("gap", [{ construct: "net-proxy" }]), api)).toBe(true);
    expect(isProxyGap(new api.CapabilityGapError("gap", [{ construct: "net-ip" }]), api)).toBe(false);
    expect(isProxyGap(new Error("gap"), api)).toBe(false);
    expect(blockedHint("proxy")).toMatch(/proxy-only/);
    expect(blockedHint("ip")).toMatch(/permission prompt/);
  });

  it("escalates only a proxy failure", () => {
    expect(shouldEscalateIp(new ProxyUnavailableError(), "proxy")).toBe(true);
    expect(shouldEscalateIp(new ProxyUnavailableError(), "ip")).toBe(false);
    expect(shouldEscalateIp(new Error("x"), "proxy")).toBe(false);
  });

  it("extracts network targets from output and arguments", () => {
    expect(
      networkTargetsOf(
        "Failed to connect to example.com port 443",
        "1.1.1.1:443",
        "https://[::1]:8080/x",
        "getaddrinfo api.example.org",
      ),
    ).toEqual(expect.arrayContaining(["example.com", "1.1.1.1", "::1", "api.example.org"]));
    expect(networkTargetsOf("example.com:443")).toEqual(["example.com"]);
    expect(networkTargetsOf("EACCES bind 0.0.0.0")).toEqual([]);
    expect(networkTargetsOf("plain words")).toEqual([]);
  });

  it("prefers named hosts over addresses when escalating", () => {
    expect(escalationTargets("Failed to connect to example.com port 443", "1.1.1.1:443")).toEqual([
      "example.com",
    ]);
    expect(escalationTargets("1.1.1.1:443")).toEqual(["1.1.1.1"]);
    expect(escalationTargets("EACCES bind 0.0.0.0")).toEqual([]);
  });

  it("asks for all networking when no target is known", async () => {
    const asked: string[][] = [];
    const ctx = {
      permissionFor: () => ({
        assertTrusted: async (resources: string[]) => {
          asked.push(resources);
        },
      }),
    } as never;
    await approveIpFallback(ctx, []);
    await approveIpFallback(ctx, ["8.8.8.8"]);
    expect(asked).toEqual([["*"], ["8.8.8.8"]]);
  });
});

describe("exec allowlist", () => {
  it("defaults and normalizes overrides", () => {
    expect(normalizeExecAllowlist(undefined)).toEqual(DEFAULT_EXEC_ALLOWLIST);
    expect(normalizeExecAllowlist(["node", "node", " uv "])).toEqual(["node", "uv"]);
    expect(normalizeExecAllowlist([])).toEqual([]);
  });

  it("rejects malformed allowlists", () => {
    expect(() => normalizeExecAllowlist("npm")).toThrow(FsError);
    expect(() => normalizeExecAllowlist([42])).toThrow(FsError);
    expect(() => normalizeExecAllowlist(["../npm"])).toThrow(FsError);
  });

  it("keeps actionable violations only", () => {
    const base = {
      pid: 1,
      process: "node",
      operation: "openat",
      deniedBy: "not granted",
      repeats: 1,
      message: "denied",
    };
    const kept = filterViolations([
      { ...base, target: "/home/user/secret" },
      { ...base, operation: "socket", target: "family AF_INET" },
      {
        ...base,
        pid: 0,
        process: "proxy",
        operation: "network-outbound",
        target: "example.org:443 (not on the allowlist)",
      },
      { ...base, target: null },
      { ...base, target: "family AF_NETLINK" },
    ]);
    expect(kept.map((violation) => violation.target)).toEqual([
      "/home/user/secret",
      "family AF_INET",
      "example.org:443 (not on the allowlist)",
    ]);
  });

  it("rejects a command when PATH is unavailable", async () => {
    const { sb } = await setup();
    const original = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(
        runSpec(execTool, { command: "node", args: ["-e", ""] }, sb, { execAllowlist: ["node"] }),
      ).rejects.toMatchObject({ code: "not-found" });
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  });
});
