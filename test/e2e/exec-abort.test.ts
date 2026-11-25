/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { Sandbox } from "../../src/core/sandbox.js";
import { execTool } from "../../src/tools/exec.js";
import { makeRoot, runSpec } from "../helpers.js";

interface AbortState {
  controller?: AbortController;
  startAborts: boolean;
  startThrows: boolean;
  spawnAborts: boolean;
  spawnThrows: boolean;
  closed: number;
  cages: number;
  spawns: number;
  kills: number;
}

const state = vi.hoisted<AbortState>(() => ({
  startAborts: false,
  startThrows: false,
  spawnAborts: false,
  spawnThrows: false,
  closed: 0,
  cages: 0,
  spawns: 0,
  kills: 0,
}));

vi.mock("../../src/core/relay-control.js", () => {
  class RelayControlServer {
    async start(): Promise<string> {
      if (state.startAborts) state.controller?.abort();
      if (state.startThrows) throw new Error("relay start failed");
      return "/tmp/fake-relay.sock";
    }

    async close(): Promise<void> {
      state.closed++;
    }
  }

  return { RelayControlServer };
});

vi.mock("procage", () => {
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
    constructor() {
      state.cages++;
    }

    async spawn() {
      state.spawns++;
      if (state.spawnAborts) state.controller?.abort();
      if (state.spawnThrows) throw new Error("spawn failed");
      return {
        output: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
        violations: async () => [],
        kill: () => {
          state.kills++;
        },
        close: () => {},
      };
    }
  }

  return { Policy, Cage, CapabilityGapError };
});

const roots: string[] = [];

beforeEach(() => {
  state.controller = undefined;
  state.startAborts = false;
  state.startThrows = false;
  state.spawnAborts = false;
  state.spawnThrows = false;
  state.closed = 0;
  state.cages = 0;
  state.spawns = 0;
  state.kills = 0;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ sb: Sandbox; controller: AbortController }> {
  const root = await makeRoot("fs-exec-abort-");
  roots.push(root);
  const controller = new AbortController();
  state.controller = controller;
  return { sb: await Sandbox.create(root), controller };
}

describe("exec abort edges", () => {
  it("refuses to run when the abort arrives during relay start", async () => {
    const { sb, controller } = await setup();
    state.startAborts = true;
    await expect(
      runSpec(execTool, { command: "node", args: ["-e", ""] }, sb, {
        execAllowlist: ["node"],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "interrupted" });

    expect(state.cages).toBe(0);
    expect(state.spawns).toBe(0);
    expect(state.closed).toBe(1);
  });

  it("does not fall back to an offline child when relay start aborts and fails", async () => {
    const { sb, controller } = await setup();
    state.startAborts = true;
    state.startThrows = true;
    await expect(
      runSpec(execTool, { command: "node", args: ["-e", ""] }, sb, {
        execAllowlist: ["node"],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "interrupted" });

    expect(state.cages).toBe(0);
    expect(state.spawns).toBe(0);
  });

  it("falls back to networking off when relay start fails without an abort", async () => {
    const { sb, controller } = await setup();
    state.startThrows = true;
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", ""] },
      sb,
      { execAllowlist: ["node"], signal: controller.signal },
    );
    expect(JSON.parse(result.result.stdout.toString())).toMatchObject({
      network: false,
      networkMode: "disabled",
      exitCode: 0,
    });
    expect(state.cages).toBe(1);
    expect(state.spawns).toBe(1);
  });

  it("kills a child when the abort arrives during spawn", async () => {
    const { sb, controller } = await setup();
    state.spawnAborts = true;
    const result = await runSpec(
      execTool,
      { command: "node", args: ["-e", ""] },
      sb,
      { execAllowlist: ["node"], signal: controller.signal },
    );
    expect(JSON.parse(result.result.stdout.toString())).toMatchObject({
      aborted: true,
      exitCode: 130,
    });
    expect(state.spawns).toBe(1);
    expect(state.kills).toBe(1);
  });

  it("fails as interrupted when spawn rejects after an abort", async () => {
    const { sb, controller } = await setup();
    state.spawnAborts = true;
    state.spawnThrows = true;
    await expect(
      runSpec(execTool, { command: "node", args: ["-e", ""] }, sb, {
        execAllowlist: ["node"],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "interrupted" });

    expect(state.kills).toBe(0);
  });

  it("reports a spawn failure when no abort occurred", async () => {
    const { sb, controller } = await setup();
    state.spawnThrows = true;
    await expect(
      runSpec(execTool, { command: "node", args: ["-e", ""] }, sb, {
        execAllowlist: ["node"],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "unsupported", message: expect.stringMatching(/exec spawn failed/) });
  });
});
