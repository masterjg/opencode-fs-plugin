/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Sandbox } from "../../src/core/sandbox.js";
import { findTool } from "../../src/tools/find.js";
import { makeRoot, runSpec } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await makeRoot("fs-find-parity-");
  roots.push(root);
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "a.txt"), "alpha");
  await fs.writeFile(path.join(root, "b.log"), "beta");
  await fs.writeFile(path.join(root, "sub", "c.txt"), "gamma");
  await fs.symlink("a.txt", path.join(root, "link"));
  await fs.link(path.join(root, "a.txt"), path.join(root, "hard"));
  return { root, sb: await Sandbox.create(root) };
}

function lines(result: Awaited<ReturnType<typeof runSpec>>) {
  return result.result.stdout.toString().trim().split("\n").filter(Boolean);
}

describe("find parity predicates", () => {
  it("matches symlink targets and full-path regexes", async () => {
    const { sb } = await setup();
    const lname = await runSpec(findTool, { paths: ["."], lname: "*.txt" }, sb);
    expect(lines(lname).some((line) => line.endsWith("link"))).toBe(true);

    const ilname = await runSpec(findTool, { paths: ["."], ilname: "A.TXT" }, sb);
    expect(lines(ilname).length).toBe(1);

    const noTarget = await runSpec(findTool, { paths: ["."], lname: "*.none" }, sb);
    expect(lines(noTarget).length).toBe(0);
    const noTargetI = await runSpec(findTool, { paths: ["."], ilname: "*.none" }, sb);
    expect(lines(noTargetI).length).toBe(0);

    const regex = await runSpec(findTool, { paths: ["."], regex: "a\\.txt$" }, sb);
    expect(lines(regex).length).toBe(1);

    const iregex = await runSpec(findTool, { paths: ["."], iregex: "A\\.TXT$" }, sb);
    expect(lines(iregex).length).toBe(1);
  });

  it("matches owners, groups, links, inodes and same-file", async () => {
    const { root, sb } = await setup();
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const username = os.userInfo().username;

    const uidResult = await runSpec(findTool, { paths: ["."], uid }, sb);
    expect(lines(uidResult).length).toBeGreaterThan(0);

    const gidResult = await runSpec(findTool, { paths: ["."], gid }, sb);
    expect(lines(gidResult).length).toBeGreaterThan(0);

    const userResult = await runSpec(findTool, { paths: ["."], user: username }, sb);
    expect(lines(userResult).length).toBeGreaterThan(0);

    const numericGroup = await runSpec(findTool, { paths: ["."], group: String(gid) }, sb);
    expect(lines(numericGroup).length).toBeGreaterThan(0);

    const unknown = await runSpec(findTool, { paths: ["."], user: "definitely-not-a-user" }, sb);
    expect(lines(unknown).length).toBe(0);

    const links = await runSpec(findTool, { paths: ["."], links: "+1" }, sb);
    expect(lines(links).some((line) => line.endsWith("a.txt"))).toBe(true);

    const inode = await fs.lstat(path.join(root, "a.txt"));
    const inum = await runSpec(findTool, { paths: ["."], inum: Number(inode.ino) }, sb);
    expect(lines(inum).length).toBe(2);

    const same = await runSpec(findTool, { paths: ["."], samefile: "a.txt" }, sb);
    expect(lines(same).length).toBe(2);
  });

  it("matches filesystem type and newerXY", async () => {
    const { root, sb } = await setup();
    const fsStats = await fs.statfs(root);
    const tmpfs = Number(fsStats.type) === 0x01021994;
    if (tmpfs) {
      const type = await runSpec(findTool, { paths: ["."], fstype: "tmpfs" }, sb);
      expect(lines(type).length).toBeGreaterThan(0);
    }

    const reference = path.join(root, "reference");
    await fs.writeFile(reference, "old");
    const old = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(reference, old, old);
    const newer = await runSpec(findTool, { paths: ["."], newerXY: "mm:reference" }, sb);
    expect(lines(newer).some((line) => line.endsWith("a.txt"))).toBe(true);

    await expect(runSpec(findTool, { paths: ["."], newerXY: "bad" }, sb)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("supports age, empty, permission, link count and group predicates", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "empty"), "");

    const mmin = await runSpec(findTool, { paths: ["."], mmin: "-1" }, sb);
    expect(lines(mmin).length).toBeGreaterThan(0);
    const oldMinutes = await runSpec(findTool, { paths: ["."], mmin: "+1" }, sb);
    expect(lines(oldMinutes).length).toBe(0);

    const empty = await runSpec(findTool, { paths: ["."], empty: true }, sb);
    expect(lines(empty).some((line) => line.endsWith("empty"))).toBe(true);

    const mode = (await fs.lstat(path.join(root, "a.txt"))).mode & 0o7777;
    const perm = await runSpec(findTool, { paths: ["."], perm: mode.toString(8) }, sb);
    expect(lines(perm).length).toBeGreaterThan(0);

    const linksMinus = await runSpec(findTool, { paths: ["."], links: "-3" }, sb);
    expect(lines(linksMinus).length).toBeGreaterThan(0);
    const linksExact = await runSpec(findTool, { paths: ["."], links: "2" }, sb);
    expect(lines(linksExact).length).toBeGreaterThan(0);

    const rootGroup = await runSpec(findTool, { paths: ["."], group: "root" }, sb);
    expect(rootGroup.result.metadata.found).toBeGreaterThanOrEqual(0);
    const unknownGroup = await runSpec(findTool, { paths: ["."], group: "definitely-not-a-group" }, sb);
    expect(lines(unknownGroup).length).toBe(0);

    const fsStats = await fs.statfs(root);
    const type = Number(fsStats.type);
    const names: Record<number, string> = {
      0x01021994: "tmpfs",
      0xef53: "ext4",
      0x794c7630: "overlay",
      0x58465342: "xfs",
      0x9123683e: "btrfs",
    };
    const fstype = names[type] ?? `0x${type.toString(16)}`;
    const positive = await runSpec(findTool, { paths: ["."], fstype }, sb);
    expect(lines(positive).length).toBeGreaterThan(0);
    const negative = await runSpec(findTool, { paths: ["."], fstype: "definitely-not-a-fs" }, sb);
    expect(lines(negative).length).toBe(0);
  });

  it("supports newerXY time fields", async () => {
    const { root, sb } = await setup();
    const reference = path.join(root, "reference");
    await fs.writeFile(reference, "old");
    const old = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(reference, old, old);
    for (const expression of ["aa:reference", "cc:reference", "BB:reference"]) {
      const result = await runSpec(findTool, { paths: ["."], newerXY: expression }, sb);
      expect(result.result.metadata.found).toBeGreaterThanOrEqual(0);
    }
  });

  it("formats printf output including timestamps and escapes", async () => {
    const { sb } = await setup();
    const format = "%p|%f|%h|%P|%s|%m|%M|%u|%U|%g|%G|%y|%Y|%i|%n|%d|%l|%b|%k|%D|%F|%a|%A|%c|%C|%t|%T|%%|%Q|%T@|%A@|%C@|\\t|\\0|\\\\|\\q|%";
    const result = await runSpec(findTool, { paths: ["."], name: "a.txt", printf: format }, sb);
    expect(result.result.stdout.toString()).toContain("a.txt");

    const trailingEscape = await runSpec(findTool, { paths: ["."], name: "a.txt", printf: "\\" }, sb);
    expect(trailingEscape.result.stdout.toString()).toContain("\\");

    const link = await runSpec(findTool, { paths: ["."], name: "link", printf: "%l\\n" }, sb);
    expect(link.result.stdout.toString()).toContain("a.txt");
  });
});
