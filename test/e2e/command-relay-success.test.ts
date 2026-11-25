/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { once } from "node:events";
import { Sandbox } from "../../src/core/sandbox.js";
import { RELAY_HELLO, encodeDecisionRequest, encodeFrame } from "../../src/core/relay-protocol.js";
import { commandTool } from "../../src/tools/command.js";
import { makeRoot, runSpec } from "../helpers.js";

interface MockState {
  options?: Record<string, unknown>;
  spawnEnv?: Record<string, string>;
  decision?: { verdict: number; reason: string };
  repeatDecision?: { verdict: number; reason: string };
  closed: number;
}

const state = vi.hoisted<MockState>(() => ({ closed: 0 }));

vi.mock("procage", async () => {
  class CapabilityGapError extends Error {}

  class Policy {
    static preset() {
      return { toJSON: () => ({ fs: [], net: "none", ipc: { unix_sockets: [] } }) };
    }

    static fromJSON() {
      return {};
    }
  }

  class Cage {
    constructor(_policy: unknown, options: Record<string, unknown>) {
      state.options = options;
    }

    async spawn(_command: string[], options: { env?: Record<string, string> }) {
      state.spawnEnv = options.env;
      const socketPath = state.options?.relay_control_socket;
      const runId = BigInt(state.options?.relay_run_id as string);
      if (typeof socketPath !== "string") throw new Error("relay control socket missing");
      const socket = net.createConnection(socketPath);
      await once(socket, "connect");
      const frames: Buffer[] = [];
      const waiters: Array<(frame: Buffer) => void> = [];
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          if (buffer.length < length + 4) break;
          const frame = buffer.subarray(4, length + 4);
          buffer = buffer.subarray(length + 4);
          const waiter = waiters.shift();
          if (waiter === undefined) frames.push(frame);
          else waiter(frame);
        }
      });
      const next = async (): Promise<Buffer> => {
        const frame = frames.shift();
        if (frame !== undefined) return frame;
        return await new Promise<Buffer>((resolve) => waiters.push(resolve));
      };

      const hello = Buffer.alloc(14);
      hello.writeUInt8(RELAY_HELLO, 0);
      hello.writeUInt8(1, 1);
      hello.writeBigUInt64BE(runId, 2);
      hello.writeUInt32BE(4242, 10);
      socket.write(encodeFrame(hello));
      await next();

      socket.write(encodeDecisionRequest({ id: 1n, resource: "registry.npmjs.org", port: 443, proto: 1 }));
      const response = await next();
      const reasonLength = response.readUInt16BE(10);
      state.decision = {
        verdict: response.readUInt8(9),
        reason: response.subarray(12, 12 + reasonLength).toString("utf8"),
      };
      // A second flow for the same resource must not duplicate the grant.
      socket.write(encodeDecisionRequest({ id: 2n, resource: "registry.npmjs.org", port: 443, proto: 1 }));
      const repeated = await next();
      const repeatedReason = repeated.readUInt16BE(10);
      state.repeatDecision = {
        verdict: repeated.readUInt8(9),
        reason: repeated.subarray(12, 12 + repeatedReason).toString("utf8"),
      };
      socket.end();

      return {
        output: async () => ({
          stdout: Buffer.from(state.decision?.verdict === 1 ? "allowed" : "denied"),
          stderr: Buffer.alloc(0),
          exitCode: state.decision?.verdict === 1 ? 0 : 1,
          signal: null,
          timedOut: false,
        }),
        violations: async () => [],
        kill: () => {},
        close: () => {
          state.closed++;
        },
      };
    }
  }

  return { Policy, Cage, CapabilityGapError };
});

const roots: string[] = [];

beforeEach(() => {
  state.options = undefined;
  state.spawnEnv = undefined;
  state.decision = undefined;
  state.repeatDecision = undefined;
  state.closed = 0;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function run(denyNetwork = false) {
  const root = await makeRoot("fs-command-relay-success-");
  roots.push(root);
  const sb = await Sandbox.create(root);
  const result = await runSpec(
    commandTool,
    { command: "node", args: ["-e", "process.stdout.write('unused')"] },
    sb,
    { execAllowlist: ["node"], denyNetwork },
  );
  return { result, body: JSON.parse(result.result.stdout.toString()) as Record<string, unknown> };
}

describe("command relay success", () => {
  it("passes the relay endpoint and authorizes the named flow", async () => {
    const { result, body } = await run();
    const socketPath = state.options?.relay_control_socket;

    expect(state.options).toMatchObject({
      relay_control_socket: expect.any(String),
      relay_run_id: expect.stringMatching(/^\d+$/),
    });
    expect(state.decision).toEqual({ verdict: 1, reason: "allowed" });
    expect(state.repeatDecision).toEqual({ verdict: 1, reason: "allowed" });
    expect(body).toMatchObject({
      stdout: "allowed",
      exitCode: 0,
      network: true,
      networkMode: "relay",
      networkHosts: ["registry.npmjs.org"],
    });
    expect(body).not.toHaveProperty("networkReason");
    expect(
      result.requests.some(
        (request) =>
          request.action === "fs_exec_network" && request.resources.includes("registry.npmjs.org"),
      ),
    ).toBe(true);
    expect(state.closed).toBe(1);
    await expect(fs.access(socketPath as string)).rejects.toThrow();
  });

  it("passes only TMPDIR and proxy settings to the child", async () => {
    const original = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      npm_config_https_proxy: process.env.npm_config_https_proxy,
      FS_EXEC_TEST_CANARY: process.env.FS_EXEC_TEST_CANARY,
    };
    process.env.HTTPS_PROXY = "http://proxy.example:8443";
    process.env.npm_config_https_proxy = "http://proxy.example:8443";
    process.env.FS_EXEC_TEST_CANARY = "must-not-reach-the-child";
    try {
      await run();
      expect(state.spawnEnv).toMatchObject({
        TMPDIR: expect.any(String),
        HTTPS_PROXY: "http://proxy.example:8443",
        npm_config_https_proxy: "http://proxy.example:8443",
      });
      expect(state.spawnEnv).not.toHaveProperty("FS_EXEC_TEST_CANARY");
      expect(state.spawnEnv).not.toHaveProperty("HOME");
      expect(state.spawnEnv).not.toHaveProperty("PATH");
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("denies the flow when fs_exec_network rejects the resource", async () => {
    const { result, body } = await run(true);
    expect(state.decision).toEqual({ verdict: 0, reason: "permission denied by test" });
    expect(body).toMatchObject({ stdout: "denied", exitCode: 1, networkHosts: [] });
    expect(
      result.requests.some(
        (request) =>
          request.action === "fs_exec_network" && request.resources.includes("registry.npmjs.org"),
      ),
    ).toBe(true);
  });
});
