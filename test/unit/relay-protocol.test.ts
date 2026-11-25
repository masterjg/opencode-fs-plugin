/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { describe, expect, it } from "vitest";
import {
  RELAY_DECIDE_REQUEST,
  RELAY_HELLO,
  RELAY_HELLO_ACK,
  RELAY_MAX_FRAME,
  RELAY_MAX_RESOURCE,
  RELAY_MESSAGE_VERSION,
  RELAY_PROTOCOL_VERSION,
  RelayFrameReader,
  RelayProtocolError,
  decodeDecisionRequest,
  decodeHello,
  encodeDecisionRequest,
  encodeDecisionResponse,
  encodeFrame,
  encodeHelloAck,
  readFrameLength,
} from "../../src/core/relay-protocol.js";

function helloPayload(runId = 7n, pid = 4242, version = RELAY_MESSAGE_VERSION): Buffer {
  const payload = Buffer.alloc(14);
  payload.writeUInt8(RELAY_HELLO, 0);
  payload.writeUInt8(version, 1);
  payload.writeBigUInt64BE(runId, 2);
  payload.writeUInt32BE(pid, 10);
  return payload;
}

function parseHelloAck(frame: Buffer) {
  const payload = frame.subarray(4);
  expect(frame.readUInt32BE(0)).toBe(payload.length);
  return {
    type: payload.readUInt8(0),
    version: payload.readUInt8(1),
    protocol: payload.readUInt32BE(2),
    maxInflight: payload.readUInt32BE(6),
    runId: payload.readBigUInt64BE(10),
  };
}

function parseDecision(frame: Buffer) {
  const payload = frame.subarray(4);
  expect(frame.readUInt32BE(0)).toBe(payload.length);
  const reasonLength = payload.readUInt16BE(10);
  return {
    type: payload.readUInt8(0),
    id: payload.readBigUInt64BE(1),
    verdict: payload.readUInt8(9),
    reason: payload.subarray(12, 12 + reasonLength).toString("utf8"),
  };
}

describe("relay protocol", () => {
  it("wraps and validates frame lengths", () => {
    const frame = encodeFrame(Buffer.from([1, 2, 3]));
    expect(frame.readUInt32BE(0)).toBe(3);
    expect(frame.subarray(4)).toEqual(Buffer.from([1, 2, 3]));
    expect(readFrameLength(frame.subarray(0, 4))).toBe(3);
    expect(readFrameLength(Buffer.from([0, 0, 0x10, 0x00]))).toBe(RELAY_MAX_FRAME);

    expect(() => encodeFrame(Buffer.alloc(0))).toThrow(RelayProtocolError);
    expect(() => encodeFrame(Buffer.alloc(RELAY_MAX_FRAME + 1))).toThrow(RelayProtocolError);
    expect(() => readFrameLength(Buffer.alloc(3))).toThrow(RelayProtocolError);
    expect(() => readFrameLength(Buffer.from([0, 0, 0, 0]))).toThrow(RelayProtocolError);
    expect(() => readFrameLength(Buffer.from([0, 0, 0x10, 0x01]))).toThrow(RelayProtocolError);
  });

  it("decodes HELLO and encodes HELLO_ACK", () => {
    expect(decodeHello(helloPayload(9n, 123))).toEqual({ version: 1, runId: 9n, pid: 123 });
    const ack = parseHelloAck(encodeHelloAck(9n, 8));
    expect(ack).toEqual({
      type: RELAY_HELLO_ACK,
      version: RELAY_MESSAGE_VERSION,
      protocol: RELAY_PROTOCOL_VERSION,
      maxInflight: 8,
      runId: 9n,
    });
  });

  it("rejects malformed HELLO payloads", () => {
    expect(() => decodeHello(Buffer.alloc(0))).toThrow(RelayProtocolError);
    expect(() => decodeHello(Buffer.from([2, 1, 0]))).toThrow(RelayProtocolError);
    expect(() => decodeHello(helloPayload().subarray(0, 13))).toThrow(RelayProtocolError);
    expect(() => decodeHello(Buffer.concat([helloPayload(), Buffer.from([0])]))).toThrow(RelayProtocolError);
    expect(() => decodeHello(helloPayload(7n, 1, 2))).toThrow(RelayProtocolError);
  });

  it("round-trips DECIDE_REQ", () => {
    const request = { id: 0xffff_ffff_ffff_ffffn, resource: "example.com", port: 443, proto: 1 as const };
    const frame = encodeDecisionRequest(request);
    const payload = frame.subarray(4);
    expect(payload.readUInt8(0)).toBe(RELAY_DECIDE_REQUEST);
    expect(decodeDecisionRequest(payload)).toEqual(request);

    const udp = decodeDecisionRequest(encodeDecisionRequest({ id: 1n, resource: "::1", port: 53, proto: 2 }).subarray(4));
    expect(udp).toEqual({ id: 1n, resource: "::1", port: 53, proto: 2 });
    expect(() =>
      encodeDecisionRequest({ id: 1n, resource: "", port: 443, proto: 1 }),
    ).toThrow(RelayProtocolError);
    expect(() =>
      encodeDecisionRequest({ id: 1n, resource: "a".repeat(RELAY_MAX_RESOURCE + 1), port: 443, proto: 1 }),
    ).toThrow(RelayProtocolError);
  });

  it("accepts a resource at the relay's bound and rejects one past it", () => {
    const longest = "a".repeat(RELAY_MAX_RESOURCE);
    const frame = encodeDecisionRequest({ id: 1n, resource: longest, port: 443, proto: 1 }).subarray(4);
    expect(decodeDecisionRequest(frame).resource).toBe(longest);

    const oversized = Buffer.from(frame);
    oversized.writeUInt16BE(RELAY_MAX_RESOURCE + 1, 9);
    expect(() => decodeDecisionRequest(oversized)).toThrow(/resource length out of range/);

    const empty = Buffer.from(frame);
    empty.writeUInt16BE(0, 9);
    expect(() => decodeDecisionRequest(empty)).toThrow(/resource length out of range/);
  });

  it("rejects malformed DECIDE_REQ payloads", () => {
    const valid = encodeDecisionRequest({ id: 5n, resource: "example.com", port: 443, proto: 1 }).subarray(4);

    expect(() => decodeDecisionRequest(Buffer.alloc(0))).toThrow(RelayProtocolError);
    expect(() => decodeDecisionRequest(Buffer.from([2, 0]))).toThrow(RelayProtocolError);
    expect(() => decodeDecisionRequest(valid.subarray(0, 10))).toThrow(RelayProtocolError);

    const longResource = Buffer.from(valid);
    longResource.writeUInt16BE(99, 9);
    expect(() => decodeDecisionRequest(longResource)).toThrow(RelayProtocolError);

    expect(() => decodeDecisionRequest(Buffer.concat([valid, Buffer.from([0])]))).toThrow(RelayProtocolError);

    const empty = Buffer.alloc(14);
    empty.writeUInt8(RELAY_DECIDE_REQUEST, 0);
    expect(() => decodeDecisionRequest(empty)).toThrow(RelayProtocolError);

    const forbidden = encodeDecisionRequest({ id: 1n, resource: "bad host", port: 443, proto: 1 }).subarray(4);
    expect(() => decodeDecisionRequest(forbidden)).toThrow(RelayProtocolError);

    const invalidUtf8 = Buffer.alloc(15);
    invalidUtf8.writeUInt8(RELAY_DECIDE_REQUEST, 0);
    invalidUtf8.writeUInt16BE(1, 9);
    invalidUtf8.writeUInt8(0xff, 11);
    invalidUtf8.writeUInt16BE(443, 12);
    invalidUtf8.writeUInt8(1, 14);
    expect(() => decodeDecisionRequest(invalidUtf8)).toThrow(RelayProtocolError);

    const zeroPort = encodeDecisionRequest({ id: 1n, resource: "a", port: 1, proto: 1 }).subarray(4);
    zeroPort.writeUInt16BE(0, 12);
    expect(() => decodeDecisionRequest(zeroPort)).toThrow(RelayProtocolError);

    const badProto = encodeDecisionRequest({ id: 1n, resource: "a", port: 1, proto: 1 }).subarray(4);
    badProto.writeUInt8(3, 14);
    expect(() => decodeDecisionRequest(badProto)).toThrow(RelayProtocolError);
  });

  it("encodes DECIDE_RESP and truncates long reasons on character boundaries", () => {
    expect(parseDecision(encodeDecisionResponse({ id: 3n, verdict: 1, reason: "allowed" }))).toEqual({
      type: 2,
      id: 3n,
      verdict: 1,
      reason: "allowed",
    });
    expect(parseDecision(encodeDecisionResponse({ id: 4n, verdict: 0, reason: "" })).reason).toBe("");

    const ascii = parseDecision(encodeDecisionResponse({ id: 5n, verdict: 0, reason: "x".repeat(4096) }));
    expect(ascii.reason).toHaveLength(512);

    const euro = parseDecision(encodeDecisionResponse({ id: 6n, verdict: 0, reason: "€".repeat(1024) }));
    expect(Buffer.byteLength(euro.reason, "utf8")).toBeLessThanOrEqual(512);
    expect(euro.reason).toBe("€".repeat(170));
  });

  it("assembles partial and coalesced frames", () => {
    const first = encodeFrame(Buffer.from([RELAY_DECIDE_REQUEST, 1, 2, 3]));
    const second = encodeFrame(Buffer.from([RELAY_DECIDE_REQUEST, 4, 5]));
    const reader = new RelayFrameReader();

    expect(reader.push(first.subarray(0, 2))).toEqual([]);
    expect(reader.push(first.subarray(2, 4))).toEqual([]);
    expect(reader.push(first.subarray(4, 5))).toEqual([]);
    expect(reader.push(first.subarray(5))).toEqual([Buffer.from([RELAY_DECIDE_REQUEST, 1, 2, 3])]);
    expect(reader.push(Buffer.concat([second, second]))).toEqual([
      Buffer.from([RELAY_DECIDE_REQUEST, 4, 5]),
      Buffer.from([RELAY_DECIDE_REQUEST, 4, 5]),
    ]);
    expect(() => reader.push(Buffer.from([0, 0, 0, 0]))).toThrow(RelayProtocolError);
    expect(() => reader.push(Buffer.from([0, 0, 0x10, 0x01]))).toThrow(RelayProtocolError);
  });
});
