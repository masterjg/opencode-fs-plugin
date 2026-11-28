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
  resolveCommandEnvFiles,
  resolveCommandEnvVars,
  resolveCommandPaths,
  resolveExecutable,
  type ExecOutcome,
  type PolicyDocument,
} from "../../src/tools/command.js";
import { MAX_ENV_FILE_BYTES, type EnvFileSource } from "../../src/core/env-file.js";
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

/** A tiny Node executable so a test never needs a shell shebang. */
async function writeProbe(dir: string, name: string, body: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return file;
}

async function makeCommandPath(prefix: string): Promise<string> {
  const dir = await makeRoot(prefix);
  roots.push(dir);
  return fs.realpath(dir);
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
    "a pipe command stage asserts exact resources without a wildcard",
    async ({ skip }) => {
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
        const networkRequest = result.requests.some(
          (request) =>
            request.action === "fs_command_network" && request.resources.includes(fixture.address),
        );
        if (!networkRequest) {
          // Hosted CI can lack the Linux T1 relay; the command still ran offline.
          skip("transparent relay unavailable on this host");
        }
        expect(networkRequest).toBe(true);
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
        expect(result.requests.some((request) => request.action === "fs_command_network")).toBe(false);
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
              request.action === "fs_command_network" && request.resources.includes(fixture.address),
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

describe("command paths", () => {
  it("prepends configured paths to the child PATH and keeps the host PATH after them", async () => {
    const { sb } = await setup();
    const extra = await makeCommandPath("fs-command-path-");
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdout.write(process.env.PATH??'')"] },
      sb,
      { allowCommands: ["node"], commandPaths: [extra] },
    );
    const seen = parsed(result).stdout as string;
    expect(seen.startsWith(`${extra}${path.delimiter}`)).toBe(true);
    expect(seen.endsWith(process.env.PATH ?? "")).toBe(true);
  });

  it("resolves a command from a configured path before the host PATH", async () => {
    const { sb } = await setup();
    const first = await makeCommandPath("fs-command-first-");
    const second = await makeCommandPath("fs-command-second-");
    await writeProbe(first, "fs-command-probe", 'process.stdout.write("first")');
    await writeProbe(second, "fs-command-probe", 'process.stdout.write("second")');
    const original = process.env.PATH;
    process.env.PATH = second;
    try {
      const started = await runSpec(
        commandTool,
        { command: "fs-command-probe" },
        sb,
        { allowCommands: ["fs-command-probe"], commandPaths: [first, second] },
      );
      expect(parsed(started).stdout).toBe("first");
      const reversed = await runSpec(
        commandTool,
        { command: "fs-command-probe" },
        sb,
        { allowCommands: ["fs-command-probe"], commandPaths: [second, first] },
      );
      expect(parsed(reversed).stdout).toBe("second");
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  });

  it("uses a configured path in a pipe stage", async () => {
    const { sb } = await setup();
    const dir = await makeCommandPath("fs-command-pipe-");
    await writeProbe(dir, "fs-command-probe", 'process.stdout.write("piped")');
    const result = await runSpec(
      pipeTool,
      { stages: [{ tool: "command", args: { command: "fs-command-probe" } }, { tool: "cat" }] },
      sb,
      { allowCommands: ["fs-command-probe"], commandPaths: [dir] },
    );
    expect(result.result.stdout.toString()).toBe("piped");
  });

  it("uses only the configured paths for the child PATH when PATH is unset or empty", async () => {
    const { sb } = await setup();
    const dir = await makeCommandPath("fs-command-nopath-");
    await writeProbe(dir, "fs-command-probe", 'process.stdout.write(process.env.PATH??"")');
    const original = process.env.PATH;
    try {
      for (const value of [undefined, ""]) {
        if (value === undefined) delete process.env.PATH;
        else process.env.PATH = value;
        const result = await runSpec(
          commandTool,
          { command: "fs-command-probe" },
          sb,
          { allowCommands: ["fs-command-probe"], commandPaths: [dir] },
        );
        expect(parsed(result).stdout).toBe(dir);
      }
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  });

  it("does not add executable names to the fs_command allowlist", async () => {
    const { sb } = await setup();
    const dir = await makeCommandPath("fs-command-deny-");
    await writeProbe(dir, "fs-command-probe", 'process.stdout.write("ran")');
    await expect(
      runSpec(commandTool, { command: "fs-command-probe" }, sb, {
        allowCommands: [],
        commandPaths: [dir],
      }),
    ).rejects.toThrow("permission denied by test");
  });

  it("rejects config-only fields in the tool input", async () => {
    const { sb } = await setup();
    for (const extra of [
      { commandPaths: ["/tmp"] },
      { commandEnvFiles: [".env"] },
      { commandEnvVars: { FS_EXTRA: "x" } },
    ]) {
      await expect(
        runSpec(commandTool, { command: "node", ...extra }, sb, { allowCommands: ["node"] }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("validates and canonicalizes the commandPaths option", async () => {
    const { root } = await setup();
    await fs.mkdir(path.join(root, "sub"));
    await fs.writeFile(path.join(root, "file"), "x");
    const outside = await makeCommandPath("fs-command-outside-");
    await fs.symlink(outside, path.join(root, "outlink"));

    await expect(resolveCommandPaths(undefined, root, 4)).resolves.toEqual([]);
    await expect(resolveCommandPaths([], root, 4)).resolves.toEqual([]);
    for (const value of ["nope", [42], [""], ["relative/bin"], ["/"]]) {
      await expect(resolveCommandPaths(value, root, 4)).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(resolveCommandPaths(["a\0b"], root, 4)).rejects.toThrow(/NUL/);
    await expect(resolveCommandPaths(["/definitely/not/here"], root, 4)).rejects.toMatchObject({
      code: "not-found",
    });
    await expect(resolveCommandPaths([path.join(root, "file")], root, 4)).rejects.toMatchObject({
      code: "not-directory",
    });
    await expect(resolveCommandPaths([root], root, 4)).rejects.toThrow(/project root or inside/);
    await expect(resolveCommandPaths([path.join(root, "sub")], root, 4)).rejects.toThrow(
      /project root or inside/,
    );
    await expect(resolveCommandPaths(["/"], "/", 4)).rejects.toThrow(/filesystem root/);
    await expect(resolveCommandPaths(["/usr"], "/", 4)).rejects.toThrow(/project root or inside/);
    await expect(resolveCommandPaths(["/tmp"], "/", 4)).rejects.toThrow(/project root or inside/);
    await expect(
      resolveCommandPaths([outside, path.join(root, "outlink"), outside], root, 4),
    ).resolves.toEqual([outside]);
  });

  it("reports the first configured entry's error in configured order", async () => {
    const { root } = await setup();
    await expect(
      resolveCommandPaths(["/definitely/not/here", "relative"], root, 4),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(
      resolveCommandPaths(["relative", "/definitely/not/here"], root, 4),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("deduplicates canonical paths without reordering", async () => {
    const { root } = await setup();
    const first = await makeCommandPath("fs-command-order-first-");
    const second = await makeCommandPath("fs-command-order-second-");
    const link = path.join(root, "link");
    await fs.symlink(first, link);
    await expect(resolveCommandPaths([second, link, first, second], root, 4)).resolves.toEqual([
      second,
      first,
    ]);
  });

  it("executes a configured-path symlink to an outside executable", async () => {
    const { sb } = await setup();
    const dir = await makeCommandPath("fs-command-symlink-");
    await fs.symlink(process.execPath, path.join(dir, "fs-command-link"));
    const result = await runSpec(
      commandTool,
      { command: "fs-command-link", args: ["-e", 'process.stdout.write("linked")'] },
      sb,
      { allowCommands: ["fs-command-link"], commandPaths: [dir] },
    );
    expect(parsed(result)).toMatchObject({
      stdout: "linked",
      exitCode: 0,
      sandboxBlocked: false,
    });
  });

  it("executes a symlink target outside the configured entry", async () => {
    const { sb } = await setup();
    const dir = await makeCommandPath("fs-command-symlink-");
    const targetDir = await makeCommandPath("fs-command-target-");
    const target = path.join(targetDir, "true-binary");
    await fs.copyFile("/usr/bin/true", target);
    await fs.chmod(target, 0o755);
    await fs.symlink(target, path.join(dir, "fs-command-link"));
    const result = await runSpec(
      commandTool,
      { command: "fs-command-link" },
      sb,
      { allowCommands: ["fs-command-link"], commandPaths: [dir] },
    );
    expect(parsed(result)).toMatchObject({ exitCode: 0, sandboxBlocked: false });
  });

  it("resolves only executable files from configured paths in order", async () => {
    const dir = await makeCommandPath("fs-command-resolve-");
    const empty = await makeCommandPath("fs-command-empty-");
    const probe = await writeProbe(dir, "fs-command-probe", 'process.stdout.write("x")');
    await fs.writeFile(path.join(empty, "fs-command-plain"), "not executable");
    await expect(resolveExecutable("fs-command-probe", [empty, dir])).resolves.toEqual({
      path: probe,
      real: probe,
    });
    await expect(resolveExecutable("fs-command-plain", [empty])).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("skips a directory named like the command and finds the later executable", async () => {
    const { sb } = await setup();
    const first = await makeCommandPath("fs-command-shadow-first-");
    const second = await makeCommandPath("fs-command-shadow-second-");
    await fs.mkdir(path.join(first, "fs-command-probe"));
    const probe = await writeProbe(second, "fs-command-probe", 'process.stdout.write("later")');
    await expect(resolveExecutable("fs-command-probe", [first, second])).resolves.toEqual({
      path: probe,
      real: probe,
    });
    const result = await runSpec(
      commandTool,
      { command: "fs-command-probe" },
      sb,
      { allowCommands: ["fs-command-probe"], commandPaths: [first, second] },
    );
    expect(parsed(result).stdout).toBe("later");
  });

  it("rejects a config symlink that resolves into the project root", async () => {
    const { root } = await setup();
    const outside = await makeCommandPath("fs-command-project-link-");
    await fs.mkdir(path.join(root, "sub"));
    const projectLink = path.join(outside, "project-link");
    const subLink = path.join(outside, "sub-link");
    await fs.symlink(root, projectLink);
    await fs.symlink(path.join(root, "sub"), subLink);
    await expect(resolveCommandPaths([projectLink], root, 4)).rejects.toThrow(
      /project root or inside/,
    );
    await expect(resolveCommandPaths([subLink], root, 4)).rejects.toThrow(
      /project root or inside/,
    );
  });
});

describe("command environment", () => {
  it("passes configured entries to the child and accepts an empty value", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: [
          "-e",
          'process.stdout.write(JSON.stringify({ marker: process.env.FS_TEST_MARKER, empty: process.env.FS_TEST_EMPTY }))',
        ],
      },
      sb,
      {
        allowCommands: ["node"],
        commandEnvVars: { FS_TEST_MARKER: "configured-value", FS_TEST_EMPTY: "" },
      },
    );
    expect(JSON.parse(parsed(result).stdout as string)).toEqual({
      marker: "configured-value",
      empty: "",
    });
  });

  it("does not automatically add configured values to result metadata", async () => {
    const { sb } = await setup();
    const secret = "fs-config-secret-9c1f";
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdout.write('ok')"] },
      sb,
      { allowCommands: ["node"], commandEnvVars: { FS_CONFIG_SECRET: secret } },
    );
    const body = JSON.parse(result.result.stdout.toString()) as { stdout: string };
    expect(body.stdout).toBe("ok");
    expect(JSON.stringify(result.result.metadata ?? {})).not.toContain(secret);
  });

  it("does not forward unrelated parent environment variables", async () => {
    const { sb } = await setup();
    const original = process.env.FS_TEST_PARENT_ONLY;
    process.env.FS_TEST_PARENT_ONLY = "parent-secret";
    try {
      const result = await runSpec(
        commandTool,
        {
          command: "node",
          args: ["-e", 'process.stdout.write(process.env.FS_TEST_PARENT_ONLY ?? "missing")'],
        },
        sb,
        { allowCommands: ["node"], commandEnvVars: { FS_TEST_MARKER: "configured" } },
      );
      expect(parsed(result).stdout).toBe("missing");
    } finally {
      if (original === undefined) delete process.env.FS_TEST_PARENT_ONLY;
      else process.env.FS_TEST_PARENT_ONLY = original;
    }
  });

  it("overrides same-named proxy and preset values", async () => {
    const { sb } = await setup();
    const originalProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://parent.invalid:1";
    try {
      const result = await runSpec(
        commandTool,
        {
          command: "node",
          args: [
            "-e",
            'process.stdout.write(JSON.stringify({ proxy: process.env.HTTP_PROXY, home: process.env.HOME }))',
          ],
        },
        sb,
        {
          allowCommands: ["node"],
          commandEnvVars: {
            HTTP_PROXY: "http://configured.invalid:2",
            HOME: "/fs-command-configured-home",
          },
        },
      );
      expect(JSON.parse(parsed(result).stdout as string)).toEqual({
        proxy: "http://configured.invalid:2",
        home: "/fs-command-configured-home",
      });
    } finally {
      if (originalProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = originalProxy;
    }
  });

  it("keeps TMPDIR tool-managed under the configured temp root", async () => {
    const { sb } = await setup();
    const tmpdir = await makeCommandPath("fs-command-env-tmp-");
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdout.write(process.env.TMPDIR ?? '')"] },
      sb,
      { allowCommands: ["node"], tmpdir, commandEnvVars: { FS_TEST_MARKER: "configured" } },
    );
    const seen = parsed(result).stdout as string;
    expect(seen.startsWith(`${tmpdir}${path.sep}fs-exec-`)).toBe(true);
    expect(seen.endsWith(path.sep)).toBe(false);
  });

  it("passes configured entries into a pipe command stage", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          {
            tool: "command",
            args: {
              command: "node",
              args: ["-e", "process.stdout.write(process.env.FS_PIPE_MARKER ?? 'missing')"],
            },
          },
          { tool: "cat" },
        ],
      },
      sb,
      { allowCommands: ["node"], commandEnvVars: { FS_PIPE_MARKER: "piped-env" } },
    );
    expect(result.result.stdout.toString()).toBe("piped-env");
  });

  it("overlays per-call entries on configured values and keeps unrelated ones", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: [
          "-e",
          'process.stdout.write(JSON.stringify({ marker: process.env.FS_TEST_MARKER, keep: process.env.FS_TEST_KEEP, only: process.env.FS_TEST_ONLY, empty: process.env.FS_TEST_EMPTY }))',
        ],
        envVars: { FS_TEST_MARKER: "call-value", FS_TEST_ONLY: "call-only", FS_TEST_EMPTY: "" },
      },
      sb,
      {
        allowCommands: ["node"],
        commandEnvVars: { FS_TEST_MARKER: "configured-value", FS_TEST_KEEP: "keep-value", FS_TEST_EMPTY: "configured" },
      },
    );
    expect(JSON.parse(parsed(result).stdout as string)).toEqual({
      marker: "call-value",
      keep: "keep-value",
      only: "call-only",
      empty: "",
    });
  });

  it("does not add per-call values to result metadata", async () => {
    const { sb } = await setup();
    const secret = "fs-call-secret-4a7d";
    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: ["-e", "process.stdout.write(process.env.FS_CALL_SECRET ?? 'missing')"],
        envVars: { FS_CALL_SECRET: secret },
      },
      sb,
      { allowCommands: ["node"] },
    );
    expect(parsed(result).stdout).toBe(secret);
    expect(JSON.stringify(result.result.metadata ?? {})).not.toContain(secret);
  });

  it("overlays per-call entries in a pipe command stage", async () => {
    const { sb } = await setup();
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          {
            tool: "command",
            args: {
              command: "node",
              args: [
                "-e",
                'process.stdout.write(`${process.env.FS_PIPE_MARKER}:${process.env.FS_PIPE_ONLY}`)',
              ],
              envVars: { FS_PIPE_MARKER: "call", FS_PIPE_ONLY: "only" },
            },
          },
          { tool: "cat" },
        ],
      },
      sb,
      { allowCommands: ["node"], commandEnvVars: { FS_PIPE_MARKER: "global" } },
    );
    expect(result.result.stdout.toString()).toBe("call:only");
  });

  it("rejects invalid per-call entries without running or leaking values", async () => {
    const { sb } = await setup();
    const secret = "s3cret-call\0value";
    for (const envVars of ["nope", null, [], { PATH: "/tmp/bin" }, { TMPDIR: "/tmp" }, { "1BAD": "x" }, { "TOPSECRET\nKEY": "x" }, { "TOPSECRET\nKEY": 42 }, { FS_BAD: 1 }, { FS_SECRET: secret }]) {
      let message = "";
      try {
        await runSpec(
          commandTool,
          { command: "node", args: ["-e", "process.stdout.write('ran')"], envVars },
          sb,
          { allowCommands: ["node"] },
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/envVars/);
      expect(message).not.toContain("s3cret");
      expect(message).not.toContain("1BAD");
      expect(message).not.toContain("TOPSECRET");
    }
  });
});

describe("command env files", () => {
  function source(file: string, index = 0): EnvFileSource {
    return { path: file, index };
  }

  async function writeEnvFile(root: string, name: string, content: string): Promise<string> {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  }

  function markerScript(marker: string): string {
    return `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`;
  }

  it("merges configured values, files in order, and the per-call overlay", async () => {
    const { root, sb } = await setup();
    const first = await writeEnvFile(
      root,
      ".env",
      "FS_ENV_MARKER=file-one\nFS_ENV_ONE=one\nFS_ENV_KEEP=keep\nFS_ENV_EMPTY=from-file\n",
    );
    const second = await writeEnvFile(
      root,
      ".env.local",
      "FS_ENV_MARKER=file-two\nFS_ENV_TWO=two\nFS_ENV_EMPTY=\n",
    );
    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: [
          "-e",
          'process.stdout.write(JSON.stringify({ marker: process.env.FS_ENV_MARKER, one: process.env.FS_ENV_ONE, two: process.env.FS_ENV_TWO, keep: process.env.FS_ENV_KEEP, empty: process.env.FS_ENV_EMPTY, configured: process.env.FS_ENV_CONFIGURED }))',
        ],
        envVars: { FS_ENV_MARKER: "call-value" },
      },
      sb,
      {
        allowCommands: ["node"],
        commandEnvVars: { FS_ENV_MARKER: "configured", FS_ENV_CONFIGURED: "yes" },
        commandEnvFiles: [source(first, 0), source(second, 1)],
      },
    );
    expect(JSON.parse(parsed(result).stdout as string)).toEqual({
      marker: "call-value",
      one: "one",
      two: "two",
      keep: "keep",
      empty: "",
      configured: "yes",
    });
  });

  it("lets a later file override an earlier file and the configured value", async () => {
    const { root, sb } = await setup();
    const first = await writeEnvFile(root, ".env", "FS_ENV_ORDER=first\n");
    const second = await writeEnvFile(root, ".env.local", "FS_ENV_ORDER=second\n");
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdout.write(process.env.FS_ENV_ORDER ?? 'missing')"] },
      sb,
      {
        allowCommands: ["node"],
        commandEnvVars: { FS_ENV_ORDER: "configured" },
        commandEnvFiles: [source(first, 0), source(second, 1)],
      },
    );
    expect(parsed(result).stdout).toBe("second");
  });

  it("re-reads configured files on every command", async () => {
    const { root, sb } = await setup();
    const file = await writeEnvFile(root, ".env", "FS_ENV_ROTATE=first\n");
    const options = { allowCommands: ["node"], commandEnvFiles: [source(file)] };
    const args = ["-e", "process.stdout.write(process.env.FS_ENV_ROTATE ?? 'missing')"];
    const before = await runSpec(commandTool, { command: "node", args }, sb, options);
    expect(parsed(before).stdout).toBe("first");
    await fs.writeFile(file, "FS_ENV_ROTATE=second\n");
    const after = await runSpec(commandTool, { command: "node", args }, sb, options);
    expect(parsed(after).stdout).toBe("second");
  });

  it("fails before spawning when a configured file is missing, a directory, or a device", async () => {
    const { root, sb } = await setup();
    const cases: Array<{ file: string; code: string }> = [
      { file: path.join(root, "missing.env"), code: "not-found" },
      { file: root, code: "not-file" },
      { file: "/dev/null", code: "not-file" },
    ];
    for (const [index, item] of cases.entries()) {
      const marker = path.join(root, `spawned-${index}`);
      let message = "";
      try {
        await runSpec(
          commandTool,
          { command: "node", args: ["-e", markerScript(marker)] },
          sb,
          { allowCommands: ["node"], commandEnvFiles: [source(item.file)] },
        );
      } catch (error) {
        message = (error as Error).message;
        expect(error).toMatchObject({ code: item.code });
      }
      expect(message).toContain('commandEnvFiles[0] ("');
      expect(await pathExists(marker)).toBe(false);
    }

    if (process.getuid?.() !== 0) {
      const file = await writeEnvFile(root, "unreadable.env", "FS_ENV_UNREADABLE=1\n");
      await fs.chmod(file, 0o000);
      const marker = path.join(root, "spawned-unreadable");
      await expect(
        runSpec(
          commandTool,
          { command: "node", args: ["-e", markerScript(marker)] },
          sb,
          { allowCommands: ["node"], commandEnvFiles: [source(file)] },
        ),
      ).rejects.toMatchObject({ code: "access" });
      expect(await pathExists(marker)).toBe(false);
    }
  });

  it("fails before spawning on malformed file content without leaking values", async () => {
    const { root, sb } = await setup();
    const secret = "fs-env-secret-7d2a";
    const cases = [
      { content: `FS_ENV_OK=1\nBROKEN LINE ${secret}\n`, match: /line 2: expected KEY=VALUE/ },
      { content: `PATH=${secret}\n`, match: /cannot set PATH/ },
      { content: `FS_ENV_SECRET=${secret}\0tail\n`, match: /line 1: FS_ENV_SECRET must not contain NUL/ },
      { content: `FS_ENV_SECRET="${secret}\n`, match: /line 1: unterminated double-quoted value/ },
    ];
    for (const [index, item] of cases.entries()) {
      const file = await writeEnvFile(root, `bad-${index}.env`, item.content);
      const marker = path.join(root, `spawned-bad-${index}`);
      let message = "";
      try {
        await runSpec(
          commandTool,
          { command: "node", args: ["-e", markerScript(marker)] },
          sb,
          { allowCommands: ["node"], commandEnvFiles: [source(file)] },
        );
      } catch (error) {
        message = (error as Error).message;
        expect(error).toMatchObject({ code: "invalid" });
      }
      expect(message).toMatch(item.match);
      expect(message).not.toContain(secret);
      expect(await pathExists(marker)).toBe(false);
    }
  });

  it("rejects an oversized file before spawning", async () => {
    const { root, sb } = await setup();
    const file = path.join(root, "huge.env");
    await fs.writeFile(file, `A=${"x".repeat(MAX_ENV_FILE_BYTES)}`);
    const marker = path.join(root, "spawned-huge");
    await expect(
      runSpec(
        commandTool,
        { command: "node", args: ["-e", markerScript(marker)] },
        sb,
        { allowCommands: ["node"], commandEnvFiles: [source(file)] },
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await pathExists(marker)).toBe(false);
  });

  it("follows a configured symlink to a regular env file", async () => {
    const { root, sb } = await setup();
    const target = await writeEnvFile(root, "real.env", "FS_ENV_LINK=followed\n");
    const link = path.join(root, ".env");
    await fs.symlink(target, link);
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdout.write(process.env.FS_ENV_LINK ?? 'missing')"] },
      sb,
      { allowCommands: ["node"], commandEnvFiles: [source(link)] },
    );
    expect(parsed(result).stdout).toBe("followed");
  });

  it("passes file entries into a pipe command stage", async () => {
    const { root, sb } = await setup();
    const file = await writeEnvFile(root, ".env", "FS_PIPE_ENV=from-file\n");
    const result = await runSpec(
      pipeTool,
      {
        stages: [
          {
            tool: "command",
            args: {
              command: "node",
              args: ["-e", "process.stdout.write(process.env.FS_PIPE_ENV ?? 'missing')"],
            },
          },
          { tool: "cat" },
        ],
      },
      sb,
      { allowCommands: ["node"], commandEnvFiles: [source(file)] },
    );
    expect(result.result.stdout.toString()).toBe("from-file");
  });

  it("does not add file-derived values to result metadata", async () => {
    const { root, sb } = await setup();
    const secret = "fs-env-metadata-3b8c";
    const file = await writeEnvFile(root, ".env", `FS_ENV_SECRET=${secret}\n`);
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdout.write(process.env.FS_ENV_SECRET ?? 'missing')"] },
      sb,
      { allowCommands: ["node"], commandEnvFiles: [source(file)] },
    );
    expect(parsed(result).stdout).toBe(secret);
    expect(JSON.stringify(result.result.metadata ?? {})).not.toContain(secret);
  });

  it("validates and resolves the commandEnvFiles option", () => {
    expect(resolveCommandEnvFiles(undefined, "/project")).toEqual([]);
    expect(
      resolveCommandEnvFiles(["a.env", "/abs/b.env", "a.env", "./a.env"], "/project"),
    ).toEqual([
      { path: path.resolve("/project", "a.env"), index: 0 },
      { path: "/abs/b.env", index: 1 },
    ]);
    expect(resolveCommandEnvFiles(["x.env", "y.env", "x.env"], "/project")).toEqual([
      { path: path.resolve("/project", "x.env"), index: 0 },
      { path: path.resolve("/project", "y.env"), index: 1 },
    ]);
    for (const raw of ["nope", null, 42, [""], [1], ["a\0b"]]) {
      expect(() => resolveCommandEnvFiles(raw, "/project")).toThrow(/commandEnvFiles/);
    }
  });
});

describe("command environment validation", () => {
  it("returns an empty object when the option is unset", () => {
    expect(resolveCommandEnvVars(undefined)).toEqual({});
  });

  it("accepts standard names and string values, including empty", () => {
    const raw = { FS_A: "1", _FS_B2: "", LC_ALL: "C" };
    expect(resolveCommandEnvVars(raw)).toEqual(raw);
  });

  it("rejects non-object shapes", () => {
    for (const value of [null, [], "nope", 42, true]) {
      expect(() => resolveCommandEnvVars(value)).toThrow(/must be an object/);
    }
  });

  it("rejects invalid environment names without echoing the key", () => {
    for (const name of ["1BAD", "BAD-NAME", "BAD NAME", "A=B", "A\0B"]) {
      let message = "";
      try {
        resolveCommandEnvVars({ [name]: "x" });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/invalid environment variable name/);
      expect(message).not.toContain(name);
    }
    expect(() => resolveCommandEnvVars({ "": "x" })).toThrow(
      /invalid environment variable name/,
    );
  });

  it("rejects the plugin-managed PATH and TMPDIR names", () => {
    for (const name of ["PATH", "TMPDIR"]) {
      expect(() => resolveCommandEnvVars({ [name]: "x" })).toThrow(
        new RegExp(`cannot set ${name}`),
      );
    }
  });

  it("rejects non-string and NUL values without echoing the value", () => {
    for (const value of [1, null, true, {}]) {
      expect(() => resolveCommandEnvVars({ FS_BAD: value })).toThrow(/must be a string/);
    }
    const secret = "s3cret\0value";
    let message = "";
    try {
      resolveCommandEnvVars({ FS_SECRET: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/NUL/);
    expect(message).not.toContain("s3cret");
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
    expect(blockedHint("relay")).toMatch(/fs_command_network/);
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
