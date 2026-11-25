/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

/**
 * Wire format shared with procage's relay control client.
 *
 * Every frame is a 4-byte big-endian payload length followed by the payload.
 * Payloads start with a one-byte message type. All integers are big-endian.
 *
 *   HELLO (3)          u8 type, u8 version, u64 run_id, u32 pid
 *   HELLO_ACK (4)      u8 type, u8 version, u32 protocol_version,
 *                      u32 max_inflight, u64 run_id
 *   DECIDE_REQ (1)     u8 type, u64 id, u16 resource_len, resource UTF-8,
 *                      u16 port, u8 proto (1 TCP, 2 UDP)
 *   DECIDE_RESP (2)    u8 type, u64 id, u8 verdict (0 deny, 1 allow),
 *                      u16 reason_len, reason UTF-8
 *
 * A payload is at most 4096 bytes. The resource is the only network detail
 * Node sees: a DNS QNAME, TLS SNI, HTTP Host, QUIC SNI, or an IP literal.
 */

export const RELAY_DECIDE_REQUEST = 1;
export const RELAY_DECIDE_RESPONSE = 2;
export const RELAY_HELLO = 3;
export const RELAY_HELLO_ACK = 4;

/** Envelope version carried by HELLO and HELLO_ACK. */
export const RELAY_MESSAGE_VERSION = 1;
/** Semantic protocol version announced by HELLO_ACK. */
export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_MAX_FRAME = 4096;
/**
 * The relay never names a resource longer than this: a DNS name is at most
 * 253 bytes and an IP literal is far shorter. procage enforces the same bound
 * before it asks; the server rejects an oversized request instead of
 * answering a resource no permission rule can cover.
 */
export const RELAY_MAX_RESOURCE = 255;
/** Reasons are diagnostic only and are truncated before they reach the wire. */
export const RELAY_MAX_REASON_BYTES = 512;

export const RELAY_PROTO_TCP = 1;
export const RELAY_PROTO_UDP = 2;

export type RelayProto = typeof RELAY_PROTO_TCP | typeof RELAY_PROTO_UDP;
export type RelayVerdict = 0 | 1;

export interface RelayHello {
  readonly version: number;
  readonly runId: bigint;
  readonly pid: number;
}

export interface RelayDecisionRequest {
  readonly id: bigint;
  readonly resource: string;
  readonly port: number;
  readonly proto: RelayProto;
}

export interface RelayDecisionResponse {
  readonly id: bigint;
  readonly verdict: RelayVerdict;
  readonly reason: string;
}

/** A malformed or unsupported frame; the connection is closed. */
export class RelayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayProtocolError";
  }
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_RESOURCE = /[\u0000-\u0020\u007f]/;

/** Wrap one payload in the length prefix. */
export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length === 0 || payload.length > RELAY_MAX_FRAME) {
    throw new RelayProtocolError(`relay frame length out of range: ${payload.length}`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Read and validate the length prefix from a complete 4-byte header. */
export function readFrameLength(header: Buffer): number {
  if (header.length < 4) {
    throw new RelayProtocolError("relay frame header is incomplete");
  }
  const length = header.readUInt32BE(0);
  if (length === 0 || length > RELAY_MAX_FRAME) {
    throw new RelayProtocolError(`relay frame length out of range: ${length}`);
  }
  return length;
}

/**
 * Incremental frame parser. A socket may deliver a header or payload in any
 * number of chunks, and several frames may arrive in one chunk.
 */
export class RelayFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = readFrameLength(this.buffer.subarray(0, 4));
      if (this.buffer.length < length + 4) break;
      frames.push(this.buffer.subarray(4, length + 4));
      this.buffer = this.buffer.subarray(length + 4);
    }
    return frames;
  }
}

export function decodeHello(payload: Buffer): RelayHello {
  assertType(payload, RELAY_HELLO, "HELLO");
  if (payload.length !== 14) {
    throw new RelayProtocolError(`HELLO payload length is ${payload.length}, expected 14`);
  }
  const version = payload.readUInt8(1);
  if (version !== RELAY_MESSAGE_VERSION) {
    throw new RelayProtocolError(`unsupported relay message version: ${version}`);
  }
  return {
    version,
    runId: payload.readBigUInt64BE(2),
    pid: payload.readUInt32BE(10),
  };
}

export function encodeHelloAck(runId: bigint, maxInflight: number): Buffer {
  const payload = Buffer.allocUnsafe(18);
  payload.writeUInt8(RELAY_HELLO_ACK, 0);
  payload.writeUInt8(RELAY_MESSAGE_VERSION, 1);
  payload.writeUInt32BE(RELAY_PROTOCOL_VERSION, 2);
  payload.writeUInt32BE(maxInflight, 6);
  payload.writeBigUInt64BE(runId, 10);
  return encodeFrame(payload);
}

export function decodeDecisionRequest(payload: Buffer): RelayDecisionRequest {
  assertType(payload, RELAY_DECIDE_REQUEST, "DECIDE_REQ");
  if (payload.length < 14) {
    throw new RelayProtocolError(`DECIDE_REQ payload length is ${payload.length}, expected at least 14`);
  }

  const id = payload.readBigUInt64BE(1);
  const resourceLength = payload.readUInt16BE(9);
  if (resourceLength === 0 || resourceLength > RELAY_MAX_RESOURCE) {
    throw new RelayProtocolError(`DECIDE_REQ resource length out of range: ${resourceLength}`);
  }
  const resourceStart = 11;
  const portOffset = resourceStart + resourceLength;
  const protoOffset = portOffset + 2;
  if (payload.length !== protoOffset + 1) {
    throw new RelayProtocolError("DECIDE_REQ length does not match its resource length");
  }

  let resource: string;
  try {
    resource = UTF8.decode(payload.subarray(resourceStart, portOffset));
  } catch {
    throw new RelayProtocolError("DECIDE_REQ resource is not valid UTF-8");
  }
  if (FORBIDDEN_RESOURCE.test(resource)) {
    throw new RelayProtocolError("DECIDE_REQ resource contains whitespace or control characters");
  }

  const port = payload.readUInt16BE(portOffset);
  if (port === 0) {
    throw new RelayProtocolError("DECIDE_REQ port is zero");
  }
  const proto = payload.readUInt8(protoOffset);
  if (proto !== RELAY_PROTO_TCP && proto !== RELAY_PROTO_UDP) {
    throw new RelayProtocolError(`unsupported DECIDE_REQ protocol: ${proto}`);
  }

  return { id, resource, port, proto };
}

export function encodeDecisionRequest(request: RelayDecisionRequest): Buffer {
  const resource = Buffer.from(request.resource, "utf8");
  if (resource.length === 0 || resource.length > RELAY_MAX_RESOURCE) {
    throw new RelayProtocolError(`DECIDE_REQ resource length out of range: ${resource.length}`);
  }
  const payload = Buffer.allocUnsafe(14 + resource.length);
  payload.writeUInt8(RELAY_DECIDE_REQUEST, 0);
  payload.writeBigUInt64BE(request.id, 1);
  payload.writeUInt16BE(resource.length, 9);
  resource.copy(payload, 11);
  payload.writeUInt16BE(request.port, 11 + resource.length);
  payload.writeUInt8(request.proto, 13 + resource.length);
  return encodeFrame(payload);
}

export function encodeDecisionResponse(response: RelayDecisionResponse): Buffer {
  const reason = truncateUtf8(response.reason, RELAY_MAX_REASON_BYTES);
  const payload = Buffer.allocUnsafe(12 + reason.length);
  payload.writeUInt8(RELAY_DECIDE_RESPONSE, 0);
  payload.writeBigUInt64BE(response.id, 1);
  payload.writeUInt8(response.verdict, 9);
  payload.writeUInt16BE(reason.length, 10);
  reason.copy(payload, 12);
  return encodeFrame(payload);
}

function assertType(payload: Buffer, expected: number, name: string): void {
  if (payload.length === 0 || payload.readUInt8(0) !== expected) {
    throw new RelayProtocolError(`${name} payload has an unexpected message type`);
  }
}

/** Truncate on a UTF-8 character boundary, never in the middle of a code point. */
function truncateUtf8(text: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}
