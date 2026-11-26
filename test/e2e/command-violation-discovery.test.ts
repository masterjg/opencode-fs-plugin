/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { commandTool } from "../../src/tools/command.js";
import { makeOutside, makeRoot, runSpec } from "../helpers.js";

interface ViolationLike {
  pid: number;
  process: string;
  operation: string;
  target: string | null;
  deniedBy: string;
  repeats: number;
  message: string;
}

interface MockState {
  violations: ViolationLike[];
  abortInCage?: AbortController;
  rejectCage?: boolean;
  gapOnFirst?: boolean;
  kill: number;
  closed: number;
  spawns: number;
  calls: Array<Record<string, unknown>>;
}

const state = vi.hoisted<MockState>(() => ({
  violations: [],
  kill: 0,
  closed: 0,
  spawns: 0,
  calls: [],
}));

vi.mock("procage", async () => {
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

    static fromJSON() {
      return {};
    }
  }

  class Cage {
    constructor(_policy: unknown, options: Record<string, unknown> = {}) {
      state.calls.push(options);
      if (state.gapOnFirst === true && state.calls.length === 1) {
        throw new CapabilityGapError("capability gaps: net-relay unsupported", [
          { construct: "net-relay", kind: "unsupported" },
        ]);
      }
      if (state.rejectCage === true) throw new Error("bad policy");
      state.abortInCage?.abort();
    }

    async spawn() {
      state.spawns++;
      return {
        output: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
        violations: async () => state.violations,
        kill: () => {
          state.kill++;
        },
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
  state.violations = [];
  state.abortInCage = undefined;
  state.rejectCage = undefined;
  state.gapOnFirst = undefined;
  state.kill = 0;
  state.closed = 0;
  state.spawns = 0;
  state.calls.length = 0;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot("fs-command-violation-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

function parsed(result: { result: { stdout: Buffer } }): Record<string, unknown> {
  return JSON.parse(result.result.stdout.toString()) as Record<string, unknown>;
}

const relayDenial = (target: string): ViolationLike => ({
  pid: 0,
  process: "relay",
  operation: "network-outbound",
  target,
  deniedBy: "permission denied",
  repeats: 1,
  message: `relay denied ${target}`,
});

const filesystemDenial = (target: string, operation = "file-write-data"): ViolationLike => ({
  pid: 123,
  process: "node",
  operation,
  target,
  deniedBy: "seatbelt",
  repeats: 1,
  message: `node denied ${operation} ${target}`,
});

describe("command relay violation discovery", () => {
  it("reports a path-like relay target without granting it as a path", async () => {
    state.violations = [relayDenial("/home/marius/private.example")];
    const { sb } = await setup();
    const result = await runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, {
      allowCommands: ["node"],
    });
    const body = parsed(result);

    expect(
      result.requests.some(
        (request) =>
          request.action === "external_directory" &&
          request.resources.some((resource) => resource.includes("private.example")),
      ),
    ).toBe(false);
    expect(body.externalPaths).toEqual([]);
    expect(body.sandboxBlocked).toBe(true);
    expect(body.violations).toContainEqual(
      expect.objectContaining({ operation: "network-outbound", target: "/home/marius/private.example" }),
    );
  });

  it("auto-approves a structured filesystem violation", async () => {
    const outside = await makeOutside();
    roots.push(outside.dir);
    const file = path.join(outside.dir, "granted.txt");
    await fs.writeFile(file, "x");
    state.violations = [filesystemDenial(file)];
    const { sb } = await setup();
    const result = await runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, {
      allowCommands: ["node"],
    });
    const body = parsed(result);

    expect(body.externalPaths).toEqual([outside.dir]);
    expect(
      result.requests.some(
        (request) =>
          request.action === "external_directory" &&
          request.resources.includes(`${outside.dir}/*`),
      ),
    ).toBe(true);
    expect(state.calls).toHaveLength(2);
  });

  it("auto-approves the nearest existing ancestor of a structured missing path", async () => {
    const outside = await makeOutside();
    roots.push(outside.dir);
    const missing = path.join(outside.dir, "missing", "nested", "file.txt");
    state.violations = [filesystemDenial(missing)];
    const { sb } = await setup();
    const result = await runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, {
      allowCommands: ["node"],
    });
    const body = parsed(result);

    expect(body.externalPaths).toEqual([outside.dir]);
    expect(state.calls).toHaveLength(2);
  });

  it("ignores a structured target whose only ancestor is the filesystem root", async () => {
    const target = `/oc-fs-command-missing-${process.pid}/file.txt`;
    state.violations = [filesystemDenial(target)];
    const { sb } = await setup();
    const result = await runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, {
      allowCommands: ["node"],
    });
    const body = parsed(result);

    expect(body.externalPaths).toEqual([]);
    expect(
      result.requests.some(
        (request) =>
          request.action === "external_directory" &&
          request.resources.some((resource) => resource.includes("oc-fs-command-missing")),
      ),
    ).toBe(false);
    expect(state.calls).toHaveLength(1);
  });

  it("does not grant write access for read or exec path violations", async () => {
    const outside = await makeOutside();
    roots.push(outside.dir);
    const file = path.join(outside.dir, "secret.txt");
    state.violations = [
      filesystemDenial(file, "file-read-data"),
      filesystemDenial(file, "process-exec"),
      filesystemDenial(file, "network-outbound"),
      filesystemDenial(file, "unknown-operation"),
    ];
    const { sb } = await setup();
    const result = await runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, {
      allowCommands: ["node"],
    });
    const body = parsed(result);

    expect(body.externalPaths).toEqual([]);
    expect(
      result.requests.some(
        (request) =>
          request.action === "external_directory" &&
          request.resources.some((resource) => resource.includes(outside.dir)),
      ),
    ).toBe(false);
    expect(body.violations).toHaveLength(4);
    expect(state.calls).toHaveLength(1);
  });

  it("fails as interrupted when the abort arrived before the spawn", async () => {
    const controller = new AbortController();
    state.abortInCage = controller;
    const { sb } = await setup();
    await expect(
      runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, {
        allowCommands: ["node"],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "interrupted" });

    expect(state.spawns).toBe(0);
    expect(state.kill).toBe(0);
    expect(state.closed).toBe(0);
  });

  it("surfaces a policy rejection instead of hiding it behind the relay", async () => {
    state.rejectCage = true;
    const { sb } = await setup();
    await expect(
      runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, { allowCommands: ["node"] }),
    ).rejects.toMatchObject({ code: "unsupported", message: expect.stringMatching(/exec policy rejected/) });
  });

  it("surfaces a policy rejection on the networking-off fallback too", async () => {
    state.gapOnFirst = true;
    state.rejectCage = true;
    const { sb } = await setup();
    await expect(
      runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, { allowCommands: ["node"] }),
    ).rejects.toMatchObject({ code: "unsupported", message: expect.stringMatching(/exec policy rejected/) });
    expect(state.calls).toHaveLength(2);
    expect(state.calls[0]).toHaveProperty("relay_control_socket");
    expect(state.calls[1]).not.toHaveProperty("relay_control_socket");
  });

  it.runIf(process.platform === "linux")(
    "runs with networking off when the relay control server cannot start",
    async () => {
      const { root, sb } = await setup();
      const blocker = path.join(root, "not-a-directory");
      await fs.writeFile(blocker, "x");
      const original = process.env.TMPDIR;
      process.env.TMPDIR = path.join(blocker, "nested");
      try {
        const result = await runSpec(commandTool, { command: "node", args: ["-e", ""] }, sb, {
          allowCommands: ["node"],
          tmpdir: root,
        });
        const body = parsed(result);

        expect(body).toMatchObject({ exitCode: 0, network: false, networkMode: "disabled" });
        expect(body.networkReason).toMatch(/relay control server failed to start/);
        expect(state.calls).toHaveLength(1);
        expect(state.calls[0]).not.toHaveProperty("relay_control_socket");
        expect(state.calls[0]).not.toHaveProperty("relay_run_id");
      } finally {
        if (original === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = original;
      }
    },
  );
});
