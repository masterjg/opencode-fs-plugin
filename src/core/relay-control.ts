/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { FsError, errorMessage } from "./errors.js";
import {
  RELAY_DECIDE_REQUEST,
  RELAY_HELLO,
  RelayFrameReader,
  RelayProtocolError,
  decodeDecisionRequest,
  decodeHello,
  encodeDecisionResponse,
  encodeHelloAck,
  type RelayDecisionRequest,
  type RelayVerdict,
} from "./relay-protocol.js";

export const RELAY_CONTROL_MAX_INFLIGHT = 64;
/**
 * Completed decision ids retained to reject a replay. procage allocates ids
 * monotonically and never reuses one, so only a recent duplicate can be a
 * protocol error; older ids are forgotten to keep a long run's memory
 * bounded. The Rust client keeps its own bounded late-answer queue.
 */
export const RELAY_CONTROL_DECIDED_HISTORY = 1024;
/**
 * Permission prompts are interactive, so the default is generous. The caller
 * can lower it; every timeout resolves to a deny.
 */
export const RELAY_CONTROL_REQUEST_TIMEOUT_MS = 60_000;
export const RELAY_CONTROL_HANDSHAKE_TIMEOUT_MS = 5_000;

const DIR_PREFIX = "opencode-relay-";
const SOCKET_NAME = "control.sock";
const MAX_TIMER_MS = 2_147_483_647;

export interface RelayControlOptions {
  /** The run id HELLO must carry and HELLO_ACK echoes. */
  readonly runId: bigint;
  /** Injected permission assertion; rejection is a deny. */
  readonly assertNetwork: (resource: string) => Promise<void>;
  /** Concurrent decisions allowed before further requests are denied. */
  readonly maxInflight?: number;
  /** Per-decision timeout; a timeout is a deny. */
  readonly requestTimeoutMs?: number;
  /** Time allowed for HELLO after connect; a timeout closes the control link. */
  readonly handshakeTimeoutMs?: number;
  /** Parent for the per-run 0700 directory. Defaults to `os.tmpdir()`. */
  readonly baseDir?: string;
}

interface PendingDecision {
  readonly timer: NodeJS.Timeout;
}

interface ControlSession {
  readonly socket: net.Socket;
  readonly reader: RelayFrameReader;
  readonly handshakeTimer: NodeJS.Timeout;
  readonly active: Map<bigint, PendingDecision>;
  /** Recent completed ids, oldest first, bounded by the history cap. */
  readonly decided: Map<bigint, true>;
  hello: boolean;
  closed: boolean;
}

/**
 * A fail-closed per-run network decision server for procage's relay control
 * client. It listens on a private Unix SOCK_STREAM socket in a fresh 0700
 * directory, accepts exactly one connection for the run, and answers only
 * DECIDE_REQ messages with a permission verdict.
 *
 * Cancellation, a closed control link, a handshake failure, a malformed frame,
 * or a decision timeout all deny. The socket path must be passed to procage as
 * `relay_control_socket`; it must never be added to `ipc.unix_sockets` and
 * must not be inside the child's TMPDIR or workspace.
 */
export class RelayControlServer {
  readonly runId: bigint;
  readonly maxInflight: number;

  /** The Unix socket path once started; empty before start and after close. */
  socketPath = "";

  private readonly assertNetwork: (resource: string) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly baseDir: string;
  private dir = "";
  private server!: net.Server;
  private session: ControlSession | undefined;
  private connected = false;
  private started = false;

  constructor(options: RelayControlOptions) {
    this.runId = normalizeRunId(options.runId);
    this.maxInflight = integerOption(options.maxInflight, RELAY_CONTROL_MAX_INFLIGHT, 1, 0xffffffff, "maxInflight");
    this.requestTimeoutMs = integerOption(
      options.requestTimeoutMs,
      RELAY_CONTROL_REQUEST_TIMEOUT_MS,
      1,
      MAX_TIMER_MS,
      "requestTimeoutMs",
    );
    this.handshakeTimeoutMs = integerOption(
      options.handshakeTimeoutMs,
      RELAY_CONTROL_HANDSHAKE_TIMEOUT_MS,
      1,
      MAX_TIMER_MS,
      "handshakeTimeoutMs",
    );
    this.assertNetwork = options.assertNetwork;
    this.baseDir = options.baseDir ?? os.tmpdir();
  }

  /** Number of decisions currently awaiting a permission result. */
  get pendingCount(): number {
    return this.session === undefined ? 0 : this.session.active.size;
  }

  /** Number of recent completed ids kept to reject a replay. */
  get decidedCount(): number {
    return this.session === undefined ? 0 : this.session.decided.size;
  }

  /** Create the private directory, bind the socket, and begin listening. */
  async start(): Promise<string> {
    if (this.started) {
      throw new FsError("relay control server is already started.", "exists");
    }
    this.started = true;

    let dir = "";
    try {
      dir = await fs.mkdtemp(path.join(this.baseDir, DIR_PREFIX));
      await fs.chmod(dir, 0o700);
      const socketPath = path.join(dir, SOCKET_NAME);
      const server = net.createServer((socket) => this.accept(socket));
      server.on("error", () => {});
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          reject(error);
        };
        server.once("error", onError);
        server.listen(socketPath, () => {
          server.off("error", onError);
          resolve();
        });
      });
      await fs.chmod(socketPath, 0o600);
      this.dir = dir;
      this.socketPath = socketPath;
      return socketPath;
    } catch (error) {
      // A bind that fails after accepting a client must not leak the session or
      // its socket: end it first, then close the listener and remove the dir.
      if (this.session !== undefined) this.endSession(this.session);
      this.connected = false;
      const server = this.server as net.Server | undefined;
      if (server !== undefined) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
      this.started = false;
      this.dir = "";
      this.socketPath = "";
      if (dir.length > 0) await fs.rm(dir, { recursive: true, force: true });
      throw new FsError(`relay control server failed to start: ${errorMessage(error)}`, "io");
    }
  }

  /** Stop listening, close the control link, and remove the socket directory. */
  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const session = this.session;
    if (session !== undefined) this.endSession(session);
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    const dir = this.dir;
    this.dir = "";
    await fs.rm(dir, { recursive: true, force: true });
    this.socketPath = "";
  }

  private accept(socket: net.Socket): void {
    if (this.connected) {
      socket.destroy();
      return;
    }
    this.connected = true;
    socket.setNoDelay(true);

    let session: ControlSession;
    const handshakeTimer = setTimeout(() => this.endSession(session), this.handshakeTimeoutMs);
    handshakeTimer.unref();
    session = {
      socket,
      reader: new RelayFrameReader(),
      handshakeTimer,
      active: new Map(),
      decided: new Map(),
      hello: false,
      closed: false,
    };
    this.session = session;

    socket.on("data", (chunk) => this.onData(session, chunk));
    /* v8 ignore next 2 -- an errored socket also emits close */
    socket.on("error", () => this.endSession(session));
    socket.on("close", () => this.endSession(session));
  }

  private onData(session: ControlSession, chunk: Buffer): void {
    try {
      for (const payload of session.reader.push(chunk)) {
        this.dispatch(session, payload);
      }
    } catch {
      this.endSession(session);
    }
  }

  private dispatch(session: ControlSession, payload: Buffer): void {
    const type = payload.readUInt8(0);
    if (type === RELAY_HELLO) {
      this.onHello(session, payload);
      return;
    }
    if (type === RELAY_DECIDE_REQUEST) {
      this.onRequest(session, payload);
      return;
    }
    throw new RelayProtocolError(`unexpected relay message type: ${type}`);
  }

  private onHello(session: ControlSession, payload: Buffer): void {
    const hello = decodeHello(payload);
    if (session.hello) {
      throw new RelayProtocolError("duplicate HELLO");
    }
    if (hello.runId !== this.runId) {
      throw new RelayProtocolError("HELLO run id does not match this relay run");
    }
    session.hello = true;
    clearTimeout(session.handshakeTimer);
    session.socket.write(encodeHelloAck(this.runId, this.maxInflight));
  }

  private onRequest(session: ControlSession, payload: Buffer): void {
    if (!session.hello) {
      throw new RelayProtocolError("DECIDE_REQ before HELLO");
    }
    const request = decodeDecisionRequest(payload);
    if (session.active.has(request.id)) {
      throw new RelayProtocolError(`duplicate in-flight decision id: ${request.id}`);
    }
    if (session.decided.has(request.id)) {
      throw new RelayProtocolError(`stale decision id: ${request.id}`);
    }
    if (session.active.size >= this.maxInflight) {
      this.settle(session, request.id, 0, "inflight limit");
      return;
    }

    const timer = setTimeout(() => this.settle(session, request.id, 0, "decision timeout"), this.requestTimeoutMs);
    timer.unref();
    session.active.set(request.id, { timer });
    void this.evaluate(session, request);
  }

  private async evaluate(session: ControlSession, request: RelayDecisionRequest): Promise<void> {
    try {
      await this.assertNetwork(request.resource);
      this.settle(session, request.id, 1, "allowed");
    } catch (error) {
      this.settle(session, request.id, 0, denyReason(error));
    }
  }

  private settle(session: ControlSession, id: bigint, verdict: RelayVerdict, reason: string): void {
    const pending = session.active.get(id);
    if (pending !== undefined) {
      session.active.delete(id);
      clearTimeout(pending.timer);
    }
    if (session.decided.has(id)) return;
    session.decided.set(id, true);
    while (session.decided.size > RELAY_CONTROL_DECIDED_HISTORY) {
      const oldest = session.decided.keys().next();
      /* v8 ignore next -- size > cap guarantees one entry */
      if (oldest.done === true) break;
      session.decided.delete(oldest.value);
    }
    if (session.closed) return;
    session.socket.write(encodeDecisionResponse({ id, verdict, reason }));
  }

  private endSession(session: ControlSession): void {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.handshakeTimer);
    for (const pending of session.active.values()) clearTimeout(pending.timer);
    session.active.clear();
    session.socket.destroy();
    this.session = undefined;
  }
}

function normalizeRunId(runId: bigint): bigint {
  if (runId < 0n || runId > 0xffff_ffff_ffff_ffffn) {
    throw new FsError("relay control runId must be an unsigned 64-bit integer.", "invalid");
  }
  return runId;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new FsError(`relay control ${name} must be an integer between ${min} and ${max}.`, "invalid");
  }
  return value;
}

function denyReason(error: unknown): string {
  const text = errorMessage(error).trim();
  return text.length === 0 ? "permission denied" : text;
}
