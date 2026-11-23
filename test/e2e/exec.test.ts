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
  detectsNetworkDenial,
  discoverExternalPaths,
  execTool,
  filterViolations,
  isSandboxBlocked,
  normalizeExecAllowlist,
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

  it("caps output and reports truncation", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      {
        command: "node",
        args: ["-e", "process.stdout.write('abc'); setTimeout(() => process.stdout.write('def'), 10)"],
      },
      sb,
      { execAllowlist: ["node"], maxOutputBytes: 3 },
    );
    expect(parsed(result)).toMatchObject({ stdout: "abc", stdoutTruncated: true });
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

  it("truncates stderr as well as stdout", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", "process.stderr.write('abcdef')"] },
      sb,
      { execAllowlist: ["node"], maxOutputBytes: 3 },
    );
    expect(parsed(result)).toMatchObject({ stderr: "abc", stderrTruncated: true });
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
    expect(parsed(result).externalPaths).toContain(file);
    expect(await fs.readFile(file, "utf8")).toBe("ok");
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
  });

  it("auto-approves network access and records it", async () => {
    const { sb } = await setup();
    const script = "const n=require('net');try{const s=n.connect(9,'127.0.0.1');s.on('error',()=>process.exit(0));}catch(e){process.exit(0)}";
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", script] },
      sb,
      { execAllowlist: ["node"] },
    );
    expect(result.requests.some((request) => request.action === "fs_exec_network")).toBe(true);
    expect(parsed(result).network).toBe(true);
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
    expect(parsed(result).externalPaths).toContain(file);
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
  const outcome = (overrides: Partial<ExecOutcome> = {}): ExecOutcome => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    stdoutTruncated: false,
    stderrTruncated: false,
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
        stderr: Buffer.from("EACCES: permission denied, open '/home/a/x'\n"),
        violations: [violation("/home/b"), violation("/home/a/x"), violation(`${root}/inside`)],
      }),
    );
    expect(found.sort()).toEqual(["/home/a/x", "/home/b"]);
  });

  it("classifies blocked and network results", () => {
    expect(isSandboxBlocked(outcome({ violations: [violation("/home/a")] }))).toBe(true);
    expect(isSandboxBlocked(outcome({ stderr: Buffer.from("EACCES"), exitCode: 1 }))).toBe(true);
    expect(isSandboxBlocked(outcome())).toBe(false);
    expect(detectsNetworkDenial(outcome({ violations: [violation("family AF_INET")] }))).toBe(true);
    expect(detectsNetworkDenial(outcome({ stderr: Buffer.from("EAI_AGAIN") }))).toBe(true);
    expect(detectsNetworkDenial(outcome({ violations: [{ ...violation("family AF_INET"), target: null }] }))).toBe(false);
    expect(detectsNetworkDenial(outcome())).toBe(false);
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

  it("keeps path and IP violations only", () => {
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
      { ...base, target: null },
      { ...base, target: "family AF_NETLINK" },
    ]);
    expect(kept.map((violation) => violation.target)).toEqual(["/home/user/secret", "family AF_INET"]);
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
