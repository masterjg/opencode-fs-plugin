/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { FsError } from "../../src/core/errors.js";
import { Sandbox } from "../../src/core/sandbox.js";
import {
  addOptionalRoots,
  blockedHint,
  discoverExternalPaths,
  commandTool,
  filterViolations,
  isSafeExecName,
  isSandboxBlocked,
  relayGapReason,
  type ExecOutcome,
  type PolicyDocument,
} from "../../src/tools/command.js";
import { pipeTool } from "../../src/tools/pipe.js";
import { makeOutside, makeRoot, pathExists, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot("fs-command-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

function parsed(result: { result: { stdout: Buffer } }): Record<string, unknown> {
  return JSON.parse(result.result.stdout.toString()) as Record<string, unknown>;
}

/** Ports the relay sniffs as HTTP; the fixture falls back to an ephemeral one. */
const HTTP_PORTS = [8080, 8000, 8888, 3000, 5000] as const;

/** RFC 1918 only: the fixture must never reach a public or loopback address. */
function isPrivateIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** First non-internal RFC 1918 address; undefined when the host has none. */
function privateIPv4(): string | undefined {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal && isPrivateIPv4(info.address)) {
        return info.address;
      }
    }
  }
  return undefined;
}

const PRIVATE_IPV4 = privateIPv4();

interface LocalFixture {
  address: string;
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

/** A LAN-only HTTP fixture; no route leaves the local network. */
async function startLocalFixture(address: string): Promise<LocalFixture> {
  let connections = 0;
  for (const candidate of [...HTTP_PORTS, 0]) {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.once("data", () => {
        socket.end("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      });
      socket.resume();
    });
    server.on("error", () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(candidate, address, () => {
          server.off("error", onError);
          resolve();
        });
      });
    } catch {
      server.close();
      continue;
    }
    const bound = server.address() as net.AddressInfo;
    return {
      address,
      port: bound.port,
      connections: () => connections,
      close: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }
  throw new Error(`no local TCP fixture port available on ${address}`);
}

describe("command", () => {
  it("runs a permitted command and returns JSON", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdout.write('ok')"] },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ command: "node", exitCode: 0, timedOut: false, stdout: "ok", stderr: "" });
    expect(result.requests).toContainEqual(
      expect.objectContaining({ action: "fs_command", resources: ["node"] }),
    );
  });

  it("passes only proxy settings beyond the preset environment allowlist", async () => {
    const { sb } = await setup();
    const original = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      https_proxy: process.env.https_proxy,
      npm_config_proxy: process.env.npm_config_proxy,
      FS_EXEC_TEST_CANARY: process.env.FS_EXEC_TEST_CANARY,
    };
    process.env.HTTPS_PROXY = "http://proxy.example:8443";
    process.env.https_proxy = "http://proxy.example:8443";
    process.env.npm_config_proxy = "http://proxy.example:8443";
    process.env.FS_EXEC_TEST_CANARY = "must-not-reach-the-child";
    try {
      const script =
        "process.stdout.write(JSON.stringify({" +
        "secret:process.env.FS_EXEC_TEST_CANARY??null," +
        "upper:process.env.HTTPS_PROXY??null," +
        "lower:process.env.https_proxy??null," +
        "npm:process.env.npm_config_proxy??null," +
        "home:process.env.HOME??null," +
        "path:process.env.PATH??null" +
        "}))";
      const result = await runSpec(commandTool, { command: "node", args: ["-e", script] }, sb, {
        allowCommands: ["node"],
      });
      const seen = JSON.parse(parsed(result).stdout as string) as Record<string, string | null>;
      expect(seen).toMatchObject({
        secret: null,
        upper: "http://proxy.example:8443",
        lower: "http://proxy.example:8443",
        npm: "http://proxy.example:8443",
      });
      expect(seen.home).toEqual(expect.any(String));
      expect(seen.path).toEqual(expect.any(String));
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("captures stderr and a non-zero exit code", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "console.error('bad'); process.exit(3)"] },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ exitCode: 3, stderr: "bad\n", stdout: "" });
    expect(result.result.exitCode).toBe(1);
  });

  it("rejects commands the fs_command permission denies", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(commandTool, { command: "rm", args: ["-rf", "."] }, sb, { allowCommands: ["node"] }),
    ).rejects.toThrow("permission denied by test");
    await expect(
      runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, { allowCommands: [] }),
    ).rejects.toThrow("permission denied by test");
  });

  it("rejects paths and shell syntax in the command name", async () => {
    const { sb } = await setup();
    for (const command of ["/bin/node", "node -e x", "node;rm", "../node"]) {
      await expect(runSpec(commandTool, { command }, sb, { allowCommands: [command] })).rejects.toMatchObject({
        code: "invalid",
      });
    }
  });

  it("passes arguments verbatim without a shell", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: ["-e", "console.log(process.argv.slice(1).join('|'))", "a;b", "c|d", "$HOME"],
      },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result).stdout).toBe("a;b|c|d|$HOME\n");
  });

  it("resolves cwd inside the sandbox", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "sub"));
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdout.write(process.cwd())"], cwd: "sub" },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result).stdout).toMatch(/\/sub$/);
    await fs.writeFile(path.join(root, "file"), "x");
    await expect(
      runSpec(commandTool, { command: "node", args: ["-e", ""], cwd: "file" }, sb, { allowCommands: ["node"] }),
    ).rejects.toMatchObject({ code: "not-directory" });
  });

  it("feeds direct stdin", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdin.pipe(process.stdout)"], stdin: "hello" },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result).stdout).toBe("hello");
  });

  it("times out and kills the process", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 100 },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ timedOut: true, exitCode: 124 });
  });

  it("aborts on the signal and refuses a pre-aborted signal", async () => {
    const { sb } = await setup();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 5000 },
      sb,
      { allowCommands: ["node"], signal: controller.signal },
    );
    expect(parsed(result)).toMatchObject({ aborted: true, exitCode: 130 });

    const aborted = new AbortController();
    aborted.abort();
    await expect(
      runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, {
        allowCommands: ["node"],
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ code: "interrupted" });
  });

  it("returns the full stdout", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: ["-e", "process.stdout.write('abc'); setTimeout(() => process.stdout.write('def'), 10)"],
      },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result).stdout).toBe("abcdef");
  });

  it("rejects a permitted command that does not exist", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(commandTool, { command: "definitely-not-a-command" }, sb, {
        allowCommands: ["definitely-not-a-command"],
      }),
    ).rejects.toBeInstanceOf(FsError);
  });

  it("rejects NUL bytes in arguments", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(commandTool, { command: "node", args: ["a\0b"] }, sb, { allowCommands: ["node"] }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("returns exit code 1 when the child is killed by a signal", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.kill(process.pid, 'SIGTERM')"] },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ exitCode: 1, signal: "SIGTERM" });
  });

  it("returns the full stderr", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stderr.write('abcdef')"] },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result).stderr).toBe("abcdef");
  });

  it("forces SIGKILL when the child ignores SIGTERM", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        timeoutMs: 500,
      },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ timedOut: true, exitCode: 124 });
  });

  it("survives a child closing stdin before the write completes", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.exit(0)"], stdin: "x".repeat(1_000_000) },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result)).toMatchObject({ exitCode: 0 });
  });

  it("works as a pipe source", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "command", args: { command: "node", args: ["-e", "process.stdout.write('abc')"] } },
          { tool: "cat" },
        ],
      },
      sb,
      { allowCommands: ["node"] },
    );
    expect(result.result.stdout.toString()).toBe("abc");
    expect(
      result.requests.some((request) => request.action === "fs_command" && request.resources.includes("*")),
    ).toBe(false);
  });

  it.skipIf(PRIVATE_IPV4 === undefined)(
    "a pipe exec stage asserts exact resources without a wildcard",
    async () => {
      const address = PRIVATE_IPV4;
      if (address === undefined) throw new Error("no private interface for the relay fixture");
      const fixture = await startLocalFixture(address);
      try {
        const { sb } = await setup();
        const script =
          "const n=require('net');" +
          `const s=n.connect(${fixture.port},${JSON.stringify(fixture.address)});` +
          `s.on('connect',()=>s.write('GET / HTTP/1.1\\r\\nHost: ${fixture.address}\\r\\nConnection: close\\r\\n\\r\\n'));` +
          "s.on('error',(e)=>{console.error(e.code);process.exit(0)});" +
          "s.on('close',()=>process.exit(0));" +
          "setTimeout(()=>process.exit(0),3000);";
        const result = await runSpec(
          pipeTool,
          {
            stages: [
              { tool: "command", args: { command: "node", args: ["-e", script] } },
              { tool: "cat" },
            ],
          },
          sb,
          { allowCommands: ["node"] },
        );
        const commandRequests = result.requests.filter((request) => request.action === "fs_command");
        expect(commandRequests.length).toBeGreaterThan(0);
        expect(commandRequests.every((request) => !request.resources.includes("*"))).toBe(true);
        expect(commandRequests.some((request) => request.resources.includes("node"))).toBe(true);
        expect(commandRequests.every((request) => !request.resources.includes(sb.root))).toBe(true);
        expect(
          result.requests.some(
            (request) =>
              request.action === "fs_exec_network" && request.resources.includes(fixture.address),
          ),
        ).toBe(true);
        expect(fixture.connections()).toBeGreaterThan(0);
      } finally {
        await fixture.close();
      }
    },
  );

  it("aborts during setup before a relay or child starts", async () => {
    const { sb } = await setup();
    const controller = new AbortController();
    async function* stdin(): AsyncGenerator<Buffer> {
      controller.abort();
      yield Buffer.from("x");
    }
    await expect(
      runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, {
        allowCommands: ["node"],
        signal: controller.signal,
        stdin: stdin(),
      }),
    ).rejects.toMatchObject({ code: "interrupted" });
  });

  it("does not grant an external path from the child's stderr", async () => {
    const { sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const file = path.join(outside.dir, "out.txt");
    await fs.writeFile(file, "old\n");
    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(file)}, "ok")`],
      },
      sb,
      { allowCommands: ["node"] },
    );
    const body = parsed(result);
    expect(body).toMatchObject({ exitCode: 1, sandboxBlocked: true, externalPaths: [] });
    expect(
      result.requests.some(
        (request) =>
          request.action === "external_directory" &&
          request.resources.some((resource) => resource.includes(outside.dir)),
      ),
    ).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe("old\n");
  });

  it("reports a denied external write without a path grant", async () => {
    const { sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const file = path.join(outside.dir, "readonly.txt");
    await fs.writeFile(file, "ro\n");
    await fs.chmod(file, 0o444);
    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(file)}, "no")`],
      },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result)).toMatchObject({
      sandboxBlocked: true,
      exitCode: 1,
      externalPaths: [],
    });
    expect(parsed(result).stderr).toMatch(/EACCES|EPERM|EROFS/);
    expect(
      result.requests.some(
        (request) =>
          request.action === "external_directory" &&
          request.resources.some((resource) => resource.includes(outside.dir)),
      ),
    ).toBe(false);
  });

  it("never grants paths printed by the child", async () => {
    const { sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const fake = path.join(outside.dir, "printed.txt");
    const script =
      `console.log(${JSON.stringify(fake)});` +
      `console.error('EACCES: permission denied, open ' + ${JSON.stringify(JSON.stringify(fake))});` +
      `console.error('path: ' + ${JSON.stringify(JSON.stringify(fake))});` +
      "process.exit(1);";
    const result = await runSpec(commandTool, { command: "node", args: ["-e", script] }, sb, {
      allowCommands: ["node"],
    });
    expect(
      result.requests.some(
        (request) =>
          request.action === "external_directory" &&
          request.resources.some((resource) => resource.includes(fake)),
      ),
    ).toBe(false);
    expect(parsed(result).externalPaths).toEqual([]);
    expect(await fs.readFile(fake, "utf8").catch(() => "missing")).toBe("missing");
  });

  it.skipIf(PRIVATE_IPV4 === undefined)("runs without networking by default", async () => {
    const address = PRIVATE_IPV4;
    if (address === undefined) throw new Error("no private interface for the relay fixture");
    const fixture = await startLocalFixture(address);
    try {
      expect(isPrivateIPv4(fixture.address)).toBe(true);
      const { sb } = await setup();
      const script =
        "const n=require('net');" +
        `const s=n.connect(${fixture.port},${JSON.stringify(fixture.address)});` +
        `s.on('connect',()=>s.write('GET / HTTP/1.1\\r\\nHost: ${fixture.address}\\r\\nConnection: close\\r\\n\\r\\n'));` +
        "s.on('error',(e)=>{console.error(e.code);process.exit(0)});" +
        "s.on('close',()=>process.exit(0));" +
        "setTimeout(()=>process.exit(0),3000);";
      const result = await runSpec(commandTool, { command: "node", args: ["-e", script] }, sb, {
        allowCommands: ["node"],
      });
      const body = parsed(result);
      if (body.networkMode === "disabled") {
        expect(result.requests.some((request) => request.action === "fs_exec_network")).toBe(false);
        expect(body.network).toBe(false);
      } else {
        expect(body).toMatchObject({
          network: true,
          networkMode: "relay",
          networkHosts: [fixture.address],
        });
        expect(fixture.connections()).toBeGreaterThan(0);
        expect(
          result.requests.some(
            (request) =>
              request.action === "fs_exec_network" && request.resources.includes(fixture.address),
          ),
        ).toBe(true);
      }
    } finally {
      await fixture.close();
    }
  });

  it("reports a repeated denied path without inventing a grant", async () => {
    const { sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const file = path.join(outside.dir, "readonly.txt");
    await fs.writeFile(file, "ro\n");
    await fs.chmod(file, 0o444);
    const script = [
      "const fs=require('fs');",
      `try{fs.writeFileSync(${JSON.stringify(file)},"no")}catch(e){`,
      "console.error(e.message);",
      "}",
      "process.exit(1);",
    ].join("");
    const result = await runSpec(commandTool, { command: "node", args: ["-e", script] }, sb, {
      allowCommands: ["node"],
    });
    expect(parsed(result)).toMatchObject({
      sandboxBlocked: true,
      exitCode: 1,
      externalPaths: [],
    });
    expect(
      result.requests.some(
        (request) =>
          request.action === "external_directory" &&
          request.resources.some((resource) => resource.includes(outside.dir)),
      ),
    ).toBe(false);
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
    await runSpec(commandTool, { command: "node", args: ["-e", script] }, sb, { allowCommands: ["node"] });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await pathExists(out)).toBe(false);
  });

  it("reports a missing executable", async () => {
    const { sb } = await setup();
    await expect(
      runSpec(commandTool, { command: "missing-exec-command" }, sb, { allowCommands: ["missing-exec-command"] }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("maps a piped non-zero exit to 1", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "command", args: { command: "node", args: ["-e", "process.exit(3)"] } },
          { tool: "cat" },
        ],
      },
      sb,
      { allowCommands: ["node"] },
    );
    expect(result.result.metadata?.stages?.[0]).toMatchObject({ tool: "command", exitCode: 1 });
  });

  it("works as a pipe filter", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "in.txt"), "xyz\n");
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          { tool: "cat", args: { paths: ["in.txt"] } },
          { tool: "command", args: { command: "node", args: ["-e", "process.stdin.pipe(process.stdout)"] } },
          { tool: "cat" },
        ],
      },
      sb,
      { allowCommands: ["node"] },
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
          { tool: "command", args: { command: "node", args: ["-e", "process.stdin.pipe(process.stdout)"] } },
          { tool: "cat" },
        ],
        input,
      },
      sb,
      { allowCommands: ["node"] },
    );
    expect(result.result.stdout.length).toBeGreaterThan(0);
  });
});

describe("command sandbox helpers", () => {
  const outcome = (overrides: Partial<ExecOutcome> = {}): ExecOutcome => ({
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    networkMode: "disabled",
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
    const write = (target: string) => ({ ...violation(target), operation: "file-write-data" });
    const found = discoverExternalPaths(
      { sandbox: sb } as never,
      outcome({
        violations: [
          write("/home/b"),
          write("/home/a/x"),
          write(`${root}/inside`),
          { ...write(""), target: null },
          write("family AF_INET"),
          violation("/home/read"),
          { ...violation("/home/exec"), operation: "process-exec" },
          { ...violation("/home/qname"), operation: "network-outbound" },
        ],
      }),
    );
    expect(found.sort()).toEqual(["/home/a/x", "/home/b"]);
  });

  it("ignores paths printed by the child", async () => {
    const { sb } = await setup();
    const ignored = discoverExternalPaths(
      { sandbox: sb } as never,
      outcome({
        stdout: Buffer.from("EACCES /home/out/evil\npath: '/home/out/evil'\n"),
        stderr: Buffer.from(
          "EACCES: permission denied, open '/home/a/x'\npath: '/home/err/evil'\nRead-only file system /home/err/ro\n",
        ),
      }),
    );
    expect(ignored).toEqual([]);
  });

  it("never treats a relay denial as a filesystem path", async () => {
    const { sb } = await setup();
    const found = discoverExternalPaths(
      { sandbox: sb } as never,
      outcome({
        violations: [
          { ...violation("/home/marius/private.example"), pid: 0, process: "relay", operation: "network-outbound" },
          { ...violation("/home/c"), operation: "file-write-data" },
        ],
      }),
    );
    expect(found).toEqual(["/home/c"]);
  });

  it("grants read and exec only for an optional root that exists", async () => {
    const doc: PolicyDocument = { fs: [], net: "none", ipc: { unix_sockets: [] } };
    const asked: string[] = [];
    await addOptionalRoots(doc, ["/home/linuxbrew", "/var/home/linuxbrew"], async (root) => {
      asked.push(root);
      if (root === "/var/home/linuxbrew") throw new Error("absent");
    });
    expect(asked).toEqual(["/home/linuxbrew", "/var/home/linuxbrew"]);
    expect(doc.fs).toEqual([
      { access: "read", target: { subpath: "/home/linuxbrew" } },
      { access: "exec", target: { subpath: "/home/linuxbrew" } },
    ]);
  });

  it("classifies blocked results", () => {
    expect(isSandboxBlocked(outcome({ violations: [violation("/home/a")] }))).toBe(true);
    expect(isSandboxBlocked(outcome({ stderr: Buffer.from("EACCES"), exitCode: 1 }))).toBe(true);
    expect(isSandboxBlocked(outcome())).toBe(false);
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
        process: "relay",
        operation: "network-outbound",
        target: 'Domain("example.org"):443 from 10.10.0.2 (permission denied)',
      },
      { ...base, target: null },
      { ...base, target: "family AF_NETLINK" },
    ]);
    expect(kept.map((violation) => violation.target)).toEqual([
      "/home/user/secret",
      "family AF_INET",
      'Domain("example.org"):443 from 10.10.0.2 (permission denied)',
    ]);
  });

  it("recognizes only an unsupported net-relay gap", async () => {
    const api = await import("procage");
    const gap = (construct: string, kind: string) =>
      ({ construct, kind, target: "linux", subject: null, accept: [] }) as never;
    expect(relayGapReason(new Error("x"), api)).toBeUndefined();
    expect(
      relayGapReason(new api.CapabilityGapError("net-ip", [gap("net-ip", "unsupported")]), api),
    ).toBeUndefined();
    expect(
      relayGapReason(new api.CapabilityGapError("net-relay", [gap("net-relay", "approximation")]), api),
    ).toBeUndefined();
    expect(
      relayGapReason(
        new api.CapabilityGapError("capability gaps: net-relay on tier t2", [gap("net-relay", "unsupported")]),
        api,
      ),
    ).toBe("capability gaps: net-relay on tier t2");
    expect(
      relayGapReason(new api.CapabilityGapError("", [gap("net-relay", "unsupported")]), api),
    ).toBe("the transparent relay is unavailable on this host");
  });

  it("explains a blocked run for each network mode", () => {
    expect(blockedHint("relay")).toMatch(/fs_exec_network/);
    expect(blockedHint("disabled")).toMatch(/Networking is disabled/);
  });
});

describe("command names", () => {
  it("accepts only bare executable names", () => {
    expect(isSafeExecName("uv")).toBe(true);
    expect(isSafeExecName("node-22.1_x")).toBe(true);
    expect(isSafeExecName("../node")).toBe(false);
    expect(isSafeExecName("-node")).toBe(false);
  });

  it("rejects a command when PATH is unavailable", async () => {
    const { sb } = await setup();
    const original = process.env.PATH;
    delete process.env.PATH;
    try {
      await expect(
        runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, { allowCommands: ["node"] }),
      ).rejects.toMatchObject({ code: "not-found" });
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  });
});
