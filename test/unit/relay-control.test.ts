/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import {
  RelayControlServer,
  RELAY_CONTROL_MAX_INFLIGHT,
  type RelayControlOptions,
} from "../../src/core/relay-control.js";
import {
  RELAY_HELLO,
  RELAY_HELLO_ACK,
  encodeDecisionRequest,
  encodeFrame,
} from "../../src/core/relay-protocol.js";
import { makeRoot, pathExists } from "../helpers.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FrameWaiter {
  resolve(frame: Buffer): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

class Client {
  private buffer = Buffer.alloc(0);
  private readonly frames: Buffer[] = [];
  private waiters: FrameWaiter[] = [];
  private closed = false;
  private readonly closePromise: Promise<void>;
  private resolveClose!: () => void;

  private constructor(readonly socket: net.Socket) {
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => {
      this.closed = true;
      this.resolveClose();
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("control link closed"));
      }
    });
    /* v8 ignore next -- client-side errors are observed through close */
    socket.on("error", () => {});
  }

  static async connect(socketPath: string): Promise<Client> {
    const socket = net.createConnection(socketPath);
    const client = new Client(socket);
    await once(socket, "connect");
    return client;
  }

  get pendingFrames(): number {
    return this.frames.length;
  }

  send(frame: Buffer): void {
    this.socket.write(frame);
  }

  sendPayload(payload: Buffer): void {
    this.send(encodeFrame(payload));
  }

  async next(timeoutMs = 1000): Promise<Buffer> {
    const frame = this.frames.shift();
    if (frame !== undefined) return frame;
    if (this.closed) throw new Error("control link closed");
    return await new Promise<Buffer>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(new Error("timed out waiting for a control frame"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async expectClose(timeoutMs = 1000): Promise<void> {
    if (this.closed) return;
    await Promise.race([
      this.closePromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("control link did not close")), timeoutMs).unref();
      }),
    ]);
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < length + 4) break;
      const frame = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.frames.push(frame);
      } else {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
  }
}

function helloPayload(runId = 7n, pid = 4242, version = 1): Buffer {
  const payload = Buffer.alloc(14);
  payload.writeUInt8(RELAY_HELLO, 0);
  payload.writeUInt8(version, 1);
  payload.writeBigUInt64BE(runId, 2);
  payload.writeUInt32BE(pid, 10);
  return payload;
}

function request(id: bigint, resource: string, port = 443, proto: 1 | 2 = 1): Buffer {
  return encodeDecisionRequest({ id, resource, port, proto });
}

function parseAck(payload: Buffer) {
  return {
    type: payload.readUInt8(0),
    version: payload.readUInt8(1),
    protocol: payload.readUInt32BE(2),
    maxInflight: payload.readUInt32BE(6),
    runId: payload.readBigUInt64BE(10),
  };
}

function parseDecision(payload: Buffer) {
  const reasonLength = payload.readUInt16BE(10);
  return {
    type: payload.readUInt8(0),
    id: payload.readBigUInt64BE(1),
    verdict: payload.readUInt8(9),
    reason: payload.subarray(12, 12 + reasonLength).toString("utf8"),
  };
}

async function decision(client: Client): Promise<ReturnType<typeof parseDecision>> {
  return parseDecision(await client.next());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await delay(2);
  }
}

const servers: RelayControlServer[] = [];
const clients: Client[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeServer(
  options: Partial<RelayControlOptions> & Pick<RelayControlOptions, "assertNetwork"> = { assertNetwork: async () => {} },
): Promise<RelayControlServer> {
  const baseDir = await makeRoot("relay-control-");
  roots.push(baseDir);
  const server = new RelayControlServer({
    runId: 7n,
    assertNetwork: async () => {},
    baseDir,
    ...options,
  });
  servers.push(server);
  await server.start();
  return server;
}

async function connect(server: RelayControlServer): Promise<Client> {
  const client = await Client.connect(server.socketPath);
  clients.push(client);
  return client;
}

async function handshake(client: Client, runId = 7n, pid = 4242): Promise<ReturnType<typeof parseAck>> {
  client.sendPayload(helloPayload(runId, pid));
  return parseAck(await client.next());
}

describe("RelayControlServer", () => {
  it("creates a private per-run socket directory and removes it", async () => {
    const server = await makeServer();
    const socketPath = server.socketPath;
    const dir = path.dirname(socketPath);
    const dirStats = await fs.stat(dir);
    const socketStats = await fs.stat(socketPath);

    expect(dirStats.isDirectory()).toBe(true);
    expect(dirStats.mode & 0o777).toBe(0o700);
    expect(socketStats.isSocket()).toBe(true);
    expect(socketStats.mode & 0o777).toBe(0o600);
    expect(server.pendingCount).toBe(0);

    await server.close();
    expect(server.socketPath).toBe("");
    expect(await pathExists(socketPath)).toBe(false);
    expect(await pathExists(dir)).toBe(false);
    expect(server.pendingCount).toBe(0);
    await server.close();
  });

  it("uses os.tmpdir and the default inflight limit", async () => {
    const server = new RelayControlServer({ runId: 1n, assertNetwork: async () => {} });
    servers.push(server);
    const socketPath = await server.start();
    expect(path.resolve(path.dirname(path.dirname(socketPath)))).toBe(path.resolve(os.tmpdir()));

    const client = await connect(server);
    expect((await handshake(client, 1n)).maxInflight).toBe(RELAY_CONTROL_MAX_INFLIGHT);
  });

  it("rejects a second start and allows close before start", async () => {
    const server = await makeServer();
    await expect(server.start()).rejects.toMatchObject({ code: "exists" });

    const idle = new RelayControlServer({ runId: 1n, assertNetwork: async () => {} });
    expect(idle.pendingCount).toBe(0);
    expect(idle.decidedCount).toBe(0);
    await idle.close();
    expect(idle.socketPath).toBe("");
  });

  it("validates run ids and numeric options", () => {
    const base = { assertNetwork: async () => {} };
    expect(() => new RelayControlServer({ ...base, runId: -1n })).toThrow(/unsigned 64-bit/);
    expect(() => new RelayControlServer({ ...base, runId: 1n << 64n })).toThrow(/unsigned 64-bit/);
    expect(() => new RelayControlServer({ ...base, runId: 1n, maxInflight: 1.5 })).toThrow(/maxInflight/);
    expect(() => new RelayControlServer({ ...base, runId: 1n, maxInflight: 0 })).toThrow(/maxInflight/);
    expect(() => new RelayControlServer({ ...base, runId: 1n, maxInflight: 0x1_0000_0000 })).toThrow(/maxInflight/);
  });

  it("cleans up when the directory cannot be created", async () => {
    const root = await makeRoot("relay-control-");
    roots.push(root);
    const server = new RelayControlServer({
      runId: 1n,
      assertNetwork: async () => {},
      baseDir: path.join(root, "missing"),
    });
    await expect(server.start()).rejects.toThrow(/failed to start/);
  });

  it("cleans up when the socket path is unusable", async () => {
    const root = await makeRoot("relay-control-");
    roots.push(root);
    const baseDir = path.join(root, "x".repeat(120));
    await fs.mkdir(baseDir);
    const server = new RelayControlServer({ runId: 1n, assertNetwork: async () => {}, baseDir });
    await expect(server.start()).rejects.toThrow(/failed to start/);
    expect(await fs.readdir(baseDir)).toEqual([]);
  });

  it("acknowledges a matching HELLO", async () => {
    const server = await makeServer({ maxInflight: 3 });
    const client = await connect(server);
    expect(await handshake(client, 7n, 4242)).toEqual({
      type: RELAY_HELLO_ACK,
      version: 1,
      protocol: 1,
      maxInflight: 3,
      runId: 7n,
    });
  });

  it("closes a connection that never sends HELLO", async () => {
    const server = await makeServer({ handshakeTimeoutMs: 20 });
    const client = await connect(server);
    await client.expectClose(500);
  });

  it("closes on a bad HELLO version, run id, or length", async () => {
    const cases: Buffer[] = [
      helloPayload(7n, 1, 2),
      helloPayload(8n),
      Buffer.concat([helloPayload(), Buffer.from([0])]),
    ];
    for (const payload of cases) {
      const server = await makeServer();
      const client = await connect(server);
      client.sendPayload(payload);
      await client.expectClose();
    }
  });

  it("closes on a duplicate HELLO", async () => {
    const server = await makeServer();
    const client = await connect(server);
    await handshake(client);
    client.sendPayload(helloPayload());
    await client.expectClose();
  });

  it("rejects DECIDE_REQ before HELLO", async () => {
    const server = await makeServer();
    const client = await connect(server);
    client.send(request(1n, "example.com"));
    await client.expectClose();
  });

  it("closes on malformed frames", async () => {
    const frames = [
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([0, 0, 0x10, 0x01]),
      encodeFrame(Buffer.from([9])),
      encodeFrame(Buffer.from([1, 0, 0])),
    ];
    for (const frame of frames) {
      const server = await makeServer();
      const client = await connect(server);
      await handshake(client);
      client.send(frame);
      await client.expectClose();
    }
  });

  it("allows and denies decisions using only the resource", async () => {
    const seen: string[] = [];
    const server = await makeServer({
      assertNetwork: async (resource) => {
        seen.push(resource);
        if (resource === "blocked.test") throw new Error("blocked by policy");
        if (resource === "empty.test") throw "";
      },
    });
    const client = await connect(server);
    await handshake(client);

    client.send(request(1n, "example.com", 443, 1));
    expect(await decision(client)).toEqual({ type: 2, id: 1n, verdict: 1, reason: "allowed" });

    client.send(request(2n, "blocked.test", 443, 1));
    expect(await decision(client)).toEqual({ type: 2, id: 2n, verdict: 0, reason: "blocked by policy" });

    client.send(request(3n, "empty.test", 53, 2));
    expect(await decision(client)).toEqual({ type: 2, id: 3n, verdict: 0, reason: "permission denied" });

    // A direct IP flow and a DNS QNAME flow are separate resources; the port
    // and protocol never reach the permission decision.
    client.send(request(4n, "2001:db8::1", 443, 1));
    expect(await decision(client)).toEqual({ type: 2, id: 4n, verdict: 1, reason: "allowed" });
    client.send(request(5n, "registry.npmjs.org", 53, 2));
    expect(await decision(client)).toEqual({ type: 2, id: 5n, verdict: 1, reason: "allowed" });

    expect(seen).toEqual(["example.com", "blocked.test", "empty.test", "2001:db8::1", "registry.npmjs.org"]);
    expect(server.pendingCount).toBe(0);
    expect(server.decidedCount).toBe(5);
  });

  it("handles concurrent out-of-order decisions", async () => {
    const gates = new Map<string, Deferred<void>>();
    const server = await makeServer({
      assertNetwork: (resource) => {
        const gate = deferred<void>();
        gates.set(resource, gate);
        return gate.promise;
      },
    });
    const client = await connect(server);
    await handshake(client);

    client.send(Buffer.concat([request(10n, "a.test"), request(20n, "b.test")]));
    await eventually(() => gates.size === 2);
    expect(server.pendingCount).toBe(2);

    gates.get("b.test")!.resolve();
    expect(await decision(client)).toEqual({ type: 2, id: 20n, verdict: 1, reason: "allowed" });

    gates.get("a.test")!.reject(new Error("nope"));
    expect(await decision(client)).toEqual({ type: 2, id: 10n, verdict: 0, reason: "nope" });
    expect(server.pendingCount).toBe(0);
  });

  it("bounds in-flight decisions", async () => {
    const gate = deferred<void>();
    const seen: string[] = [];
    const server = await makeServer({
      maxInflight: 1,
      assertNetwork: (resource) => {
        seen.push(resource);
        return gate.promise;
      },
    });
    const client = await connect(server);
    await handshake(client);

    client.send(request(1n, "first.test"));
    await eventually(() => server.pendingCount === 1);
    client.send(request(2n, "second.test"));
    expect(await decision(client)).toEqual({ type: 2, id: 2n, verdict: 0, reason: "inflight limit" });
    expect(seen).toEqual(["first.test"]);

    gate.resolve();
    expect(await decision(client)).toEqual({ type: 2, id: 1n, verdict: 1, reason: "allowed" });
  });

  it("denies on timeout and ignores a late permission result", async () => {
    const slow = deferred<void>();
    const server = await makeServer({
      requestTimeoutMs: 20,
      assertNetwork: (resource) => (resource === "slow.test" ? slow.promise : Promise.resolve()),
    });
    const client = await connect(server);
    await handshake(client);

    client.send(request(1n, "slow.test"));
    expect(await decision(client)).toEqual({ type: 2, id: 1n, verdict: 0, reason: "decision timeout" });

    slow.resolve();
    await delay(10);
    expect(client.pendingFrames).toBe(0);
    expect(server.pendingCount).toBe(0);

    client.send(request(2n, "fast.test"));
    expect(await decision(client)).toEqual({ type: 2, id: 2n, verdict: 1, reason: "allowed" });
  });

  it("rejects duplicate in-flight and stale decision ids", async () => {
    const gate = deferred<void>();
    const server = await makeServer({ assertNetwork: () => gate.promise });
    const client = await connect(server);
    await handshake(client);
    client.send(request(1n, "first.test"));
    await eventually(() => server.pendingCount === 1);
    client.send(request(1n, "first.test"));
    await client.expectClose();
    gate.resolve();
    await delay(5);
    expect(server.pendingCount).toBe(0);

    const staleServer = await makeServer();
    const staleClient = await connect(staleServer);
    await handshake(staleClient);
    staleClient.send(request(9n, "once.test"));
    expect(await decision(staleClient)).toEqual({ type: 2, id: 9n, verdict: 1, reason: "allowed" });
    staleClient.send(request(9n, "once.test"));
    await staleClient.expectClose();
  });

  it("denies pending decisions when the control link is lost", async () => {
    const gate = deferred<void>();
    const server = await makeServer({ assertNetwork: () => gate.promise });
    const client = await connect(server);
    await handshake(client);
    client.send(request(1n, "pending.test"));
    await eventually(() => server.pendingCount === 1);

    client.destroy();
    await client.expectClose();
    await eventually(() => server.pendingCount === 0);

    gate.resolve();
    await delay(5);
    expect(server.pendingCount).toBe(0);
  });

  it("accepts only one control connection for the run", async () => {
    const server = await makeServer();
    const first = await connect(server);
    await handshake(first);

    const second = await connect(server);
    await second.expectClose();

    first.send(request(1n, "still.test"));
    expect(await decision(first)).toEqual({ type: 2, id: 1n, verdict: 1, reason: "allowed" });

    first.destroy();
    await first.expectClose();
    await delay(5);

    const late = await connect(server);
    await late.expectClose();
  });

  it("closes cleanly with a pending decision", async () => {
    const gate = deferred<void>();
    const server = await makeServer({ assertNetwork: () => gate.promise });
    const client = await connect(server);
    await handshake(client);
    client.send(request(1n, "pending.test"));
    await eventually(() => server.pendingCount === 1);
    const socketPath = server.socketPath;

    await server.close();
    await client.expectClose();
    gate.resolve();
    await delay(5);
    expect(server.pendingCount).toBe(0);
    expect(await pathExists(socketPath)).toBe(false);
    await server.close();
  });

  it("handles frames split across socket chunks", async () => {
    const server = await makeServer();
    const client = await connect(server);
    await handshake(client);
    const frame = request(9n, "partial.test");

    client.send(frame.subarray(0, 1));
    await delay(5);
    client.send(frame.subarray(1, 4));
    await delay(5);
    client.send(frame.subarray(4, frame.length - 1));
    await delay(5);
    client.send(frame.subarray(frame.length - 1));

    expect(await decision(client)).toEqual({ type: 2, id: 9n, verdict: 1, reason: "allowed" });
  });
});
