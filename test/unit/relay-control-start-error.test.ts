/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { RelayControlServer } from "../../src/core/relay-control.js";
import { makeRoot } from "../helpers.js";

interface FakeSocket {
  destroyed: number;
}

interface FakeState {
  listenError: Error;
  failSocketChmod: boolean;
  acceptOnListen: boolean;
  sockets: FakeSocket[];
  closed: number;
}

const state = vi.hoisted<FakeState>(() => ({
  listenError: new Error("listen failed"),
  failSocketChmod: false,
  acceptOnListen: false,
  sockets: [],
  closed: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: async (target: fs.FileHandle | string, mode: number) => {
      // The private dir uses 0700; the socket uses 0600.
      if (mode === 0o600 && state.failSocketChmod) throw new Error("chmod denied");
      return actual.chmod(target as string, mode);
    },
  };
});

vi.mock("node:net", () => {
  class FakeNodeSocket implements FakeSocket {
    destroyed = 0;

    setNoDelay(): this {
      return this;
    }

    on(): this {
      return this;
    }

    write(): boolean {
      return true;
    }

    end(): this {
      return this;
    }

    destroy(): this {
      this.destroyed++;
      return this;
    }
  }

  class FakeServer {
    private readonly errorListeners: Array<(error: Error) => void> = [];
    private readonly onConnection: (socket: FakeNodeSocket) => void;

    constructor(onConnection: (socket: FakeNodeSocket) => void) {
      this.onConnection = onConnection;
    }

    on(event: string, listener: (error: Error) => void): this {
      if (event === "error") this.errorListeners.push(listener);
      return this;
    }

    once(event: string, listener: (error: Error) => void): this {
      if (event === "error") this.errorListeners.push(listener);
      return this;
    }

    off(): this {
      return this;
    }

    // Emit to every registered listener, like a real server would, so the
    // server's swallow listener and the start() reject listener both run.
    listen(_path: string, callback?: () => void): this {
      if (state.acceptOnListen) {
        callback?.();
        const socket = new FakeNodeSocket();
        state.sockets.push(socket);
        this.onConnection(socket);
        return this;
      }
      queueMicrotask(() => {
        for (const listener of this.errorListeners) listener(state.listenError);
      });
      return this;
    }

    close(callback?: () => void): this {
      state.closed++;
      callback?.();
      return this;
    }
  }

  return { createServer: (onConnection: (socket: FakeNodeSocket) => void) => new FakeServer(onConnection) };
});

const roots: string[] = [];

beforeEach(() => {
  state.failSocketChmod = false;
  state.acceptOnListen = false;
  state.sockets.length = 0;
  state.closed = 0;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("relay control start error", () => {
  it("rejects and removes its directory when listen emits an asynchronous error", async () => {
    const baseDir = await makeRoot("relay-start-error-");
    roots.push(baseDir);
    const server = new RelayControlServer({ runId: 1n, assertNetwork: async () => {}, baseDir });

    await expect(server.start()).rejects.toMatchObject({
      code: "io",
      message: expect.stringMatching(/relay control server failed to start: listen failed/),
    });

    expect(await fs.readdir(baseDir)).toEqual([]);
    expect(server.socketPath).toBe("");
    expect(state.closed).toBe(1);
    // start() reset the flag, so close() after a failed start is a no-op.
    await server.close();
  });

  it("ends an accepted session and cleans up when the socket chmod fails", async () => {
    const baseDir = await makeRoot("relay-start-error-");
    roots.push(baseDir);
    state.acceptOnListen = true;
    state.failSocketChmod = true;
    const server = new RelayControlServer({
      runId: 1n,
      assertNetwork: async () => {},
      requestTimeoutMs: 60_000,
      baseDir,
    });

    await expect(server.start()).rejects.toMatchObject({
      code: "io",
      message: expect.stringMatching(/relay control server failed to start: chmod denied/),
    });

    expect(state.sockets).toHaveLength(1);
    expect(state.sockets[0]!.destroyed).toBe(1);
    expect(state.closed).toBe(1);
    expect(server.pendingCount).toBe(0);
    expect(server.decidedCount).toBe(0);
    expect(server.socketPath).toBe("");
    expect(await fs.readdir(baseDir)).toEqual([]);
  });
});
