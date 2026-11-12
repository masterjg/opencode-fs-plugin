/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { describe, expect, it } from "vitest";
import { parseStat, readProcess } from "../../src/core/procfs.js";

const fields = [
  "S", "1", "1", "1", "0", "-1", "4194560",
  "0", "0", "0", "0", "0", "0", "0", "0",
  "20", "0", "4", "0", "12345", "100000", "256",
];

describe("procfs stat parsing", () => {
  it("parses comm with spaces and command lines", () => {
    const text = `42 (a b) ${fields.join(" ")}`;
    const parsed = parseStat(42, text, Buffer.from("node\0test\0"), 1000);
    expect(parsed).toMatchObject({
      pid: 42,
      comm: "a b",
      state: "S",
      ppid: 1,
      uid: 1000,
      rssBytes: 256 * 4096,
      startTime: 12345,
      threads: 4,
      command: "node test",
    });
  });

  it("falls back to comm and rejects malformed rows", async () => {
    const parsed = parseStat(7, `7 (solo) ${fields.join(" ")}`, undefined, 0);
    expect(parsed?.command).toBe("solo");
    expect(parseStat(7, "no parentheses here", undefined, 0)).toBeUndefined();
    expect(parseStat(7, "7 (short) S 1", undefined, 0)).toBeUndefined();
    expect(parseStat(7, `7 (empty) ${fields.join(" ")}`, Buffer.alloc(0), 0)?.command).toBe("empty");
    await expect(readProcess(999_999)).resolves.toBeUndefined();
  });
});
