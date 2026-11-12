/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { FsError, errorMessage, errnoCode, fromErrno, isMissing, isPermission } from "../../src/core/errors.js";
import {
  humanSize,
  isBinary,
  parseSize,
  renderError,
  renderResult,
  splitLines,
  withTrailingNewline,
} from "../../src/core/format.js";
import { parseSchema } from "../../src/core/schema.js";

describe("format helpers", () => {
  it("detects binary content", () => {
    expect(isBinary(Buffer.from("hello"))).toBe(false);
    expect(isBinary(Buffer.from([1, 0, 2]))).toBe(true);
  });

  it("renders text, empty, binary, truncated and stderr results", () => {
    expect(renderResult({ stdout: Buffer.alloc(0) }, 10)).toEqual({
      content: "",
      metadata: { ok: true, exitCode: 0 },
    });

    const text = renderResult({ stdout: Buffer.from("hello\n"), stderr: "warn" }, 100);
    expect(text.content).toContain("hello");
    expect(text.content).toContain("[stderr]\nwarn");
    expect(text.metadata).toMatchObject({ ok: true, exitCode: 0, stderr: "warn" });

    const textWithoutNewline = renderResult({ stdout: Buffer.from("hello"), stderr: "warn" }, 100);
    expect(textWithoutNewline.content).toContain("hello\n[stderr]\nwarn");

    const binary = renderResult({ stdout: Buffer.from([1, 0, 2]) }, 100);
    expect(binary.metadata.encoding).toBe("base64");

    const truncated = renderResult({ stdout: Buffer.from("abcdef") }, 3);
    expect(truncated.content).toBe("abc");
    expect(truncated.metadata.truncated).toBe(true);

    const failed = renderResult({ stdout: Buffer.from("x"), exitCode: 1 }, 10);
    expect(failed.metadata.ok).toBe(false);
    expect(failed.metadata.exitCode).toBe(1);
  });

  it("renders errors", () => {
    const blocked = renderError(new FsError("no", "outside"), true);
    expect(blocked.content).toBe("BLOCKED: no");
    expect(blocked.metadata).toMatchObject({ blocked: true, code: "outside" });
    const failed = renderError(new FsError("bad", "io"), false);
    expect(failed.content).toBe("ERROR: bad");
  });

  it("formats and parses sizes", () => {
    expect(humanSize(0)).toBe("0");
    expect(humanSize(1024)).toBe("1.0K");
    expect(humanSize(10 * 1024)).toBe("10K");
    expect(humanSize(-1024)).toBe("-1.0K");
    expect(parseSize("10")).toBe(10);
    expect(parseSize("1K")).toBe(1024);
    expect(parseSize("1.5M")).toBe(1572864);
    expect(parseSize("-2G")).toBe(-2147483648);
    expect(() => parseSize("")).toThrow(FsError);
    expect(() => parseSize("nope")).toThrow(FsError);
  });

  it("splits lines and adds newlines", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(withTrailingNewline("a")).toBe("a\n");
    expect(withTrailingNewline("a\n")).toBe("a\n");
  });
});

describe("error helpers", () => {
  it("reads errno codes and messages", () => {
    const errno = Object.assign(new Error("nope"), { code: "ENOENT" });
    expect(errnoCode(errno)).toBe("ENOENT");
    expect(errnoCode(null)).toBeUndefined();
    expect(errnoCode({})).toBeUndefined();
    expect(errorMessage(errno)).toBe("nope");
    expect(errorMessage("x")).toBe("x");
    expect(isMissing(errno)).toBe(true);
    expect(isPermission(Object.assign(new Error("no"), { code: "EACCES" }))).toBe(true);
    expect(isPermission(Object.assign(new Error("no"), { code: "EPERM" }))).toBe(true);
  });

  it("maps errno failures", () => {
    const cases: Array<[string, string]> = [
      ["ENOENT", "not-found"],
      ["ENOTDIR", "not-found"],
      ["EACCES", "access"],
      ["EPERM", "access"],
      ["EPERM", "access"],
      ["EEXIST", "exists"],
      ["ENOTEMPTY", "not-empty"],
      ["EXDEV", "cross-device"],
      ["EISDIR", "not-file"],
      ["EIO", "io"],
    ];
    for (const [errno, code] of cases) {
      expect(fromErrno(Object.assign(new Error(errno), { code: errno })).code).toBe(code);
    }
  });
});

describe("schema parsing", () => {
  const schema = Type.Object({ name: Type.String() }, { additionalProperties: false });

  it("accepts valid input", () => {
    expect(parseSchema(schema, { name: "x" })).toEqual({ name: "x" });
  });

  it("rejects invalid input with a useful label", () => {
    expect(() => parseSchema(schema, { name: 1 }, "tool input")).toThrow(/Invalid tool input/);
    expect(() => parseSchema(schema, {}, "tool input")).toThrow(FsError);
    expect(() => parseSchema(schema, { name: "x", extra: true }, "tool input")).toThrow(/Unexpected property/);
  });
});
