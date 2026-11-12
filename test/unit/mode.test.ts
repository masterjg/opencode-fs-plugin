/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { describe, expect, it } from "vitest";
import { FsError } from "../../src/core/errors.js";
import { formatMode, formatOctalMode, parseMode } from "../../src/core/mode.js";

describe("mode parsing", () => {
  it("parses octal modes", () => {
    expect(parseMode("755", 0o777, false)).toBe(0o755);
    expect(parseMode("2755", 0o777, false)).toBe(0o2755);
  });

  it("parses symbolic additions and removals", () => {
    expect(parseMode("u+x,g-w,o=r", 0o644, false)).toBe(0o744);
    expect(parseMode("a+x", 0o644, false)).toBe(0o755);
    expect(parseMode("u=rwx,go=rx", 0o600, false)).toBe(0o755);
  });

  it("handles conditional execute and special bits", () => {
    expect(parseMode("a+X", 0o644, true)).toBe(0o755);
    expect(parseMode("a+X", 0o644, false)).toBe(0o644);
    expect(parseMode("u+s,g+s,+t", 0o755, false)).toBe(0o7755);
    expect(parseMode("o+s", 0o755, false)).toBe(0o755);
    expect(parseMode("a+t", 0o755, false)).toBe(0o1755);
    expect(parseMode("o+t", 0o755, false)).toBe(0o1755);
    expect(parseMode("+s", 0o755, false)).toBe(0o6755);
  });

  it("applies the umask when who is omitted", () => {
    expect(parseMode("+x", 0o644, false, 0o022)).toBe(0o755);
    expect(parseMode("a-w", 0o666, false)).toBe(0o444);
  });

  it("formats modes", () => {
    expect(formatMode(0o100644)).toBe("-rw-r--r--");
    expect(formatMode(0o40755)).toBe("drwxr-xr-x");
    expect(formatMode(0o120777)).toBe("lrwxrwxrwx");
    expect(formatMode(0o010644)).toBe("prw-r--r--");
    expect(formatMode(0o140644)).toBe("srw-r--r--");
    expect(formatMode(0o060644)).toBe("brw-r--r--");
    expect(formatMode(0o020644)).toBe("crw-r--r--");
    expect(formatMode(0o104755)).toBe("-rwsr-xr-x");
    expect(formatMode(0o104644)).toBe("-rwSr--r--");
    expect(formatMode(0o101777)).toBe("-rwxrwxrwt");
    expect(formatMode(0o101776)).toBe("-rwxrwxrwT");
    expect(formatOctalMode(0o644)).toBe("0644");
  });

  it("rejects invalid modes", () => {
    expect(() => parseMode("", 0o644, false)).toThrow(FsError);
    expect(() => parseMode("u+q", 0o644, false)).toThrow(FsError);
    expect(() => parseMode("u", 0o644, false)).toThrow(FsError);
    expect(() => parseMode("u+", 0o644, false)).not.toThrow();
    expect(() => parseMode("u=rwx,", 0o644, false)).toThrow(FsError);
    expect(() => parseMode("9999", 0o644, false)).toThrow(FsError);
  });
});
