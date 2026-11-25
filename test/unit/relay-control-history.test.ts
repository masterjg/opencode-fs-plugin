/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { once } from "node:events";
import {
  RELAY_CONTROL_DECIDED_HISTORY,
  RelayControlServer,
} from "../../src/core/relay-control.js";
import { RELAY_HELLO, encodeDecisionRequest, encodeFrame } from "../../src/core/relay-protocol.js";
import { makeRoot } from "../helpers.js";

interface FrameWaiter {
  resolve(frame: Buffer): void;
  timer: NodeJS.Timeout;
}

/** Minimal framing client for one control link. */
class Client {
  private buffer = Buffer.alloc(0);
  private readonly frames: Buffer[] = [];
  private waiters: FrameWaiter[] = [];
  private closed = false;

  private constructor(readonly socket: net.Socket) {
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) clearTimeout(waiter.timer);
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

  send(frame: Buffer): void {
    this.socket.write(frame);
  }

  async next(timeoutMs = 2000): Promise<Buffer> {
    const frame = this.frames.shift();
    if (frame !== undefined) return frame;
    if (this.closed) throw new Error("control link closed");
    return await new Promise<Buffer>((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve,
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
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("control link did not close");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
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

function helloPayload(runId = 7n): Buffer {
  const payload = Buffer.alloc(14);
  payload.writeUInt8(RELAY_HELLO, 0);
  payload.writeUInt8(1, 1);
  payload.writeBigUInt64BE(runId, 2);
  payload.writeUInt32BE(4242, 10);
  return payload;
}

function request(id: bigint): Buffer {
  return encodeDecisionRequest({ id, resource: `h${id}.test`, port: 443, proto: 1 });
}

const servers: RelayControlServer[] = [];
const clients: Client[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ server: RelayControlServer; client: Client }> {
  const baseDir = await makeRoot("relay-history-");
  roots.push(baseDir);
  const server = new RelayControlServer({
    runId: 7n,
    assertNetwork: async () => {},
    baseDir,
  });
  servers.push(server);
  await server.start();
  const client = await Client.connect(server.socketPath);
  clients.push(client);
  client.send(encodeFrame(helloPayload()));
  await client.next();
  return { server, client };
}

/** Sends ids 1..count in bounded batches, reading one decision each. */
async function decideMany(server: RelayControlServer, client: Client, count: number): Promise<void> {
  const batch = 32;
  for (let start = 1n; start <= BigInt(count); start += BigInt(batch)) {
    const end = start + BigInt(batch) > BigInt(count) ? BigInt(count) : start + BigInt(batch) - 1n;
    for (let id = start; id <= end; id++) client.send(request(id));
    for (let id = start; id <= end; id++) {
      const payload = await client.next();
      expect(payload.readBigUInt64BE(1)).toBe(id);
      expect(payload.readUInt8(9)).toBe(1);
    }
  }
  expect(server.pendingCount).toBe(0);
  expect(server.decidedCount).toBe(RELAY_CONTROL_DECIDED_HISTORY);
}

describe("RelayControlServer decision history", () => {
  it("stays bounded and still rejects a recent duplicate", async () => {
    const { server, client } = await setup();
    expect(server.decidedCount).toBe(0);
    const count = RELAY_CONTROL_DECIDED_HISTORY + 64;
    await decideMany(server, client, count);

    client.send(request(BigInt(count)));
    await client.expectClose();
  });

  it("forgets ids older than the window instead of growing without bound", async () => {
    const { server, client } = await setup();
    const count = RELAY_CONTROL_DECIDED_HISTORY + 64;
    await decideMany(server, client, count);

    // 1n was the first decision and is now older than the retained window.
    client.send(request(1n));
    const payload = await client.next();
    expect(payload.readBigUInt64BE(1)).toBe(1n);
    expect(payload.readUInt8(9)).toBe(1);
    expect(server.decidedCount).toBe(RELAY_CONTROL_DECIDED_HISTORY);
  });
});
