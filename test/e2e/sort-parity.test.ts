/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { Sandbox } from "../../src/core/sandbox.js";
import { sortTool } from "../../src/tools/sort.js";
import { bufferStream, makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function run(input: Record<string, unknown>, text: string) {
  const root = await makeRoot("fs-sort-parity-");
  roots.push(root);
  return runSpec(sortTool, input, await Sandbox.create(root), { stdin: bufferStream(text) });
}

describe("sort parity flags", () => {
  it("supports dictionary and non-printing filters", async () => {
    const dictionary = await run({ dictionary: true }, "a-b\nab\n");
    expect(dictionary.result.stdout.toString()).toBe("a-b\nab\n");

    const nonPrinting = await run({ ignoreNonPrinting: true }, "a\x01b\nab\n");
    expect(nonPrinting.result.stdout.toString()).toBe("a\x01b\nab\n");
  });

  it("sorts general numeric and human sizes", async () => {
    const general = await run({ generalNumeric: true }, "1e2\n20\n3\n");
    expect(general.result.stdout.toString()).toBe("3\n20\n1e2\n");

    const human = await run({ humanNumeric: true }, "1M\n500\n2K\n");
    expect(human.result.stdout.toString()).toBe("500\n2K\n1M\n");

    const nonNumeric = await run({ humanNumeric: true }, "abc\n1K\n");
    expect(nonNumeric.result.stdout.toString()).toBe("abc\n1K\n");
  });

  it("sorts versions naturally", async () => {
    const result = await run({ version: true }, "v1.10\nv1.2\nv1.2.1\n");
    expect(result.result.stdout.toString()).toBe("v1.2\nv1.2.1\nv1.10\n");

    const text = await run({ version: true }, "b1\na1\n");
    expect(text.result.stdout.toString()).toBe("a1\nb1\n");

    const equal = await run({ version: true }, "v1.2\nv1.2\n");
    expect(equal.result.stdout.toString()).toBe("v1.2\nv1.2\n");

    const empty = await run({ version: true }, "\n\n1\n");
    expect(empty.result.stdout.toString()).toBe("\n\n1\n");
  });

  it("uses a stable sort when requested", async () => {
    const defaultSort = await run({ field: 1, separator: ":" }, "a:2\na:1\n");
    expect(defaultSort.result.stdout.toString()).toBe("a:1\na:2\n");

    const stable = await run({ field: 1, separator: ":", stable: true }, "a:2\na:1\n");
    expect(stable.result.stdout.toString()).toBe("a:2\na:1\n");
  });

  it("supports GNU key ranges and modifiers", async () => {
    const numeric = await run({ keys: ["2,2n"] }, "x 10\ny 2\n");
    expect(numeric.result.stdout.toString()).toBe("y 2\nx 10\n");

    const reverse = await run({ keys: ["2,2nr"] }, "x 10\ny 2\n");
    expect(reverse.result.stdout.toString()).toBe("x 10\ny 2\n");

    const chars = await run({ keys: ["2.1,2.2"] }, "x ac\ny ab\n");
    expect(chars.result.stdout.toString()).toBe("y ab\nx ac\n");

    const multiple = await run({ keys: ["1,1", "2,2n"] }, "b 1\na 2\na 1\n");
    expect(multiple.result.stdout.toString()).toBe("a 1\na 2\nb 1\n");

    const toEnd = await run({ keys: ["2"] }, "x 2\ny 10\n");
    expect(toEnd.result.stdout.toString()).toBe("y 10\nx 2\n");

    const blanks = await run({ keys: ["2b"] }, "x  b\ny a\n");
    expect(blanks.result.stdout.toString()).toBe("y a\nx  b\n");

    const separated = await run({ keys: ["2,2n"], separator: ":" }, "x:10\ny:2\n");
    expect(separated.result.stdout.toString()).toBe("y:2\nx:10\n");

    const tieReverse = await run({ ignoreCase: true, reverse: true }, "A\na\n");
    expect(tieReverse.result.stdout.toString().trim().split("\n").sort()).toEqual(["A", "a"]);

    await expect(run({ keys: ["bad"] }, "a\n")).rejects.toMatchObject({ code: "invalid" });
  });

  it("supports NUL-separated input and output", async () => {
    const result = await run({ zeroTerminated: true }, "b\0a");
    expect(result.result.stdout.toString()).toBe("a\0b\0");
  });

  it("checks sorted and unsorted input", async () => {
    const sorted = await run({ check: true }, "a\nb\n");
    expect(sorted.result.exitCode).toBe(0);
    expect(sorted.result.metadata).toMatchObject({ checked: true });

    const unsorted = await run({ check: true }, "b\na\n");
    expect(unsorted.result.exitCode).toBe(1);
    expect(unsorted.result.stdout.toString()).toContain("disorder at line 2");

    const quiet = await run({ checkQuiet: true }, "b\na\n");
    expect(quiet.result.exitCode).toBe(1);
    expect(quiet.result.stdout.length).toBe(0);
  });
});
