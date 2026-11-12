/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { lsTool } from "../../src/tools/ls.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-ls-parity-");
  roots.push(root);
  await fs.mkdir(path.join(root, "dir"));
  await fs.writeFile(path.join(root, "a.log"), "a");
  await fs.writeFile(path.join(root, "b.txt"), "b");
  await fs.writeFile(path.join(root, "v1.10"), "x");
  await fs.writeFile(path.join(root, "v1.2"), "x");
  await fs.writeFile(path.join(root, "b1"), "x");
  await fs.writeFile(path.join(root, "a1"), "x");
  await fs.symlink("a.log", path.join(root, "link"));
  return { root, sb: await Sandbox.create(root) };
}

describe("ls parity flags", () => {
  it("supports block sizes, numeric ids, owner/group omission and quoting", async () => {
    const { sb } = await setup();
    const sized = await runSpec(lsTool, { size: true }, sb);
    expect(sized.result.stdout.toString()).toMatch(/^\d+ /m);

    const numeric = await runSpec(lsTool, { numericIds: true }, sb);
    expect(numeric.result.stdout.toString()).toMatch(/^[-dl].*\s\d+\s\d+\s/);

    const long = await runSpec(lsTool, { long: true }, sb);
    const noOwner = await runSpec(lsTool, { noOwner: true }, sb);
    const noGroup = await runSpec(lsTool, { noGroup: true }, sb);
    const longSized = await runSpec(lsTool, { long: true, size: true, human: true }, sb);
    expect(longSized.result.stdout.toString()).toMatch(/\d+(?:\.\d+)?[KMG]? /);
    const fieldCount = (value: string) =>
      value.split("\n").find((line) => !line.startsWith("total "))!.trim().split(/\s+/).length;
    expect(fieldCount(noOwner.result.stdout.toString())).toBeLessThan(fieldCount(long.result.stdout.toString()));
    expect(fieldCount(noGroup.result.stdout.toString())).toBeLessThan(fieldCount(long.result.stdout.toString()));

    const quoted = await runSpec(lsTool, { quote: true }, sb);
    expect(quoted.result.stdout.toString()).toContain('"a.log"');
  });

  it("supports slash, version, extension and directory-first sorting", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "z.md"), "z");

    const slash = await runSpec(lsTool, { slash: true }, sb);
    expect(slash.result.stdout.toString()).toContain("dir/");

    const version = await runSpec(lsTool, { versionSort: true }, sb);
    const lines = version.result.stdout.toString().trim().split("\n");
    expect(lines.indexOf("v1.2")).toBeLessThan(lines.indexOf("v1.10"));
    expect(lines.indexOf("a1")).toBeLessThan(lines.indexOf("b1"));

    const extension = await runSpec(lsTool, { extensionSort: true }, sb);
    const extensionLines = extension.result.stdout.toString().trim().split("\n");
    expect(extensionLines.indexOf("z.md")).toBeLessThan(extensionLines.indexOf("b.txt"));

    const grouped = await runSpec(lsTool, { groupDirectoriesFirst: true }, sb);
    expect(grouped.result.stdout.toString().split("\n")[0]).toBe("dir");
  });

  it("supports timestamp styles and hide/ignore filters", async () => {
    const { sb } = await setup();
    const longIso = await runSpec(lsTool, { long: true, timeStyle: "long-iso" }, sb);
    expect(longIso.result.stdout.toString()).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    const full = await runSpec(lsTool, { long: true, fullTime: true }, sb);
    expect(full.result.stdout.toString()).toMatch(/\+0000 /);

    const fullIso = await runSpec(lsTool, { long: true, timeStyle: "full-iso" }, sb);
    expect(fullIso.result.stdout.toString()).toMatch(/\+0000 /);

    const iso = await runSpec(lsTool, { long: true, timeStyle: "iso" }, sb);
    expect(iso.result.stdout.toString()).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);

    const locale = await runSpec(lsTool, { long: true, timeStyle: "locale" }, sb);
    expect(locale.result.stdout.toString()).toMatch(/[A-Z][a-z]{2} /);

    const hidden = await runSpec(lsTool, { hide: ["*.log"] }, sb);
    expect(hidden.result.stdout.toString()).not.toContain("a.log");

    const emptyPatterns = await runSpec(lsTool, { hide: [], ignore: [] }, sb);
    expect(emptyPatterns.result.stdout.toString()).toContain("a.log");

    const ignored = await runSpec(lsTool, { ignore: ["*.txt"] }, sb);
    expect(ignored.result.stdout.toString()).not.toContain("b.txt");
  });
});
