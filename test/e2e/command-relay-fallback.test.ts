/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { Sandbox } from "../../src/core/sandbox.js";
import { commandTool } from "../../src/tools/command.js";
import { makeRoot, runSpec } from "../helpers.js";

interface CageCall {
  relay?: unknown;
  relay_run_id?: unknown;
  relay_control_socket?: unknown;
  [key: string]: unknown;
}

interface MockState {
  calls: CageCall[];
  socketExisted: boolean[];
  docs: Array<{ net?: unknown; ipc?: { unix_sockets?: unknown[] } }>;
  spawns: number;
  closed: number;
}

const state = vi.hoisted<MockState>(() => ({
  calls: [],
  socketExisted: [],
  docs: [],
  spawns: 0,
  closed: 0,
}));

vi.mock("procage", async () => {
  const { existsSync } = await import("node:fs");

  class CapabilityGapError extends Error {
    readonly gaps: Array<{ construct: string; kind: string }>;

    constructor(message: string, gaps: Array<{ construct: string; kind: string }>) {
      super(message);
      this.name = "CapabilityGapError";
      this.gaps = gaps;
    }
  }

  class Policy {
    static preset() {
      return { toJSON: () => ({ fs: [], net: "none", ipc: { unix_sockets: [] } }) };
    }

    static fromJSON(doc: { net?: unknown; ipc?: { unix_sockets?: unknown[] } }) {
      state.docs.push(doc);
      return {};
    }
  }

  class Cage {
    constructor(_policy: unknown, options: CageCall = {}) {
      state.calls.push(options);
      state.socketExisted.push(
        typeof options.relay_control_socket === "string" && existsSync(options.relay_control_socket),
      );
      if (state.calls.length === 1) {
        throw new CapabilityGapError("capability gaps: net-relay on linux tier t2: no network namespace", [
          { construct: "net-relay", kind: "unsupported" },
        ]);
      }
    }

    async spawn() {
      state.spawns++;
      return {
        output: async () => ({
          stdout: Buffer.from("fallback"),
          stderr: Buffer.alloc(0),
          exitCode: 0,
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
  state.calls.length = 0;
  state.socketExisted.length = 0;
  state.docs.length = 0;
  state.spawns = 0;
  state.closed = 0;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("command relay fallback", () => {
  it("starts the relay first, then retries with networking disabled on an unsupported backend", async () => {
    const root = await makeRoot("fs-command-relay-fallback-");
    roots.push(root);
    const sb = await Sandbox.create(root);
    const result = await runSpec(
      commandTool,
      { command: "node", args: ["-e", "process.stdout.write('ignored')"] },
      sb,
      { execAllowlist: ["node"] },
    );
    const body = JSON.parse(result.result.stdout.toString()) as Record<string, unknown>;

    expect(body).toMatchObject({ stdout: "fallback", exitCode: 0, networkMode: "disabled", network: false });
    expect(body.networkReason).toMatch(/net-relay/);

    expect(state.calls).toHaveLength(2);
    const first = state.calls[0]!;
    expect(first.relay_control_socket).toEqual(expect.any(String));
    expect(first.relay_run_id).toEqual(expect.stringMatching(/^\d+$/));
    expect(state.socketExisted[0]).toBe(true);
    const runId = BigInt(first.relay_run_id as string);
    expect(runId).toBeGreaterThanOrEqual(0n);
    expect(runId).toBeLessThanOrEqual(0xffff_ffff_ffff_ffffn);
    expect(state.calls[1]).not.toHaveProperty("relay_control_socket");
    expect(state.calls[1]).not.toHaveProperty("relay_run_id");

    // Both attempts lower a policy with networking off: the relay attempt is
    // replaced by procage, and the fallback keeps Network::None. Neither
    // grants resolver sockets or a macOS resolver exception.
    expect(state.docs).toHaveLength(2);
    for (const doc of state.docs) {
      expect(doc.net).toBe("none");
      expect(doc.ipc?.unix_sockets).toEqual([]);
    }
    expect(first).not.toHaveProperty("relay_dns_upstream");
    expect(first).not.toHaveProperty("relay_resolv_conf");

    expect(state.spawns).toBe(1);
    expect(state.closed).toBe(1);
    await expect(fs.access(first.relay_control_socket as string)).rejects.toThrow();
    expect(result.requests.some((request) => request.action === "fs_exec_network")).toBe(false);
  });
});
