/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PermissionGate, type PermissionAssertInput } from "../../src/core/permissions.js";
import { parseSchema } from "../../src/core/schema.js";
import { Sandbox } from "../../src/core/sandbox.js";
import type { ToolResult, ToolSpec } from "../../src/core/types.js";
import { chmodTool } from "../../src/tools/chmod.js";
import { chownTool } from "../../src/tools/chown.js";
import { touchTool } from "../../src/tools/touch.js";
import { truncateTool } from "../../src/tools/truncate.js";
import { makeRoot, pathExists } from "../helpers.js";

type ChownCall = { op: "chown" | "lchown"; path: string; uid: number; gid: number };

const chownState = vi.hoisted(() => ({ calls: [] as ChownCall[] }));

// A denied owner change must never reach the syscall. Recording every real
// chown/lchown keeps the denial assertions meaningful on non-root runs, where
// the target uid/gid snapshot already equals the process uid/gid.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chown: async (...args: Parameters<typeof actual.chown>) => {
      chownState.calls.push({ op: "chown", path: String(args[0]), uid: Number(args[1]), gid: Number(args[2]) });
      return actual.chown(...args);
    },
    lchown: async (...args: Parameters<typeof actual.lchown>) => {
      chownState.calls.push({ op: "lchown", path: String(args[0]), uid: Number(args[1]), gid: Number(args[2]) });
      return actual.lchown(...args);
    },
  };
});

function chownMark(): number {
  return chownState.calls.length;
}

function chownCallsSince(mark: number): ChownCall[] {
  return chownState.calls.slice(mark);
}

const roots: string[] = [];

afterEach(async () => {
  chownState.calls.length = 0;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

interface GatedRun {
  requests: PermissionAssertInput[];
  result?: ToolResult;
  error?: unknown;
}

async function runGated<I>(
  spec: ToolSpec<I>,
  raw: unknown,
  sandbox: Sandbox,
  deny?: (request: PermissionAssertInput) => boolean,
): Promise<GatedRun> {
  const input = parseSchema<I>(spec.schema, raw, `${spec.name} input`);
  const requests: PermissionAssertInput[] = [];
  const assertPermission = async (request: PermissionAssertInput): Promise<void> => {
    requests.push(request);
    if (deny?.(request) === true) throw new Error("permission denied by test");
  };
  const gateFor = (action: string): PermissionGate =>
    new PermissionGate(
      { sessionID: "ses_test", agent: "worker", messageID: "msg_test", id: "call_test" },
      action,
      (full) => sandbox.resource(full),
      assertPermission,
    );
  try {
    const result = await spec.run(
      {
        sandbox,
        permission: gateFor(`fs_${spec.name}`),
        permissionFor: gateFor,
        concurrency: 4,
        signal: new AbortController().signal,
        tmpdir: os.tmpdir(),
      },
      input,
      {},
    );
    return { requests, result };
  } catch (error) {
    return { requests, error };
  }
}

const denyExternal = (request: PermissionAssertInput): boolean => request.action === "external_directory";

function expectDenied(run: GatedRun, boundaryDirectory: string): void {
  expect(run.error).toBeInstanceOf(Error);
  expect((run.error as Error).message).toBe("permission denied by test");
  expect(run.requests).toHaveLength(1);
  expect(run.requests[0]).toMatchObject({
    action: "external_directory",
    resources: [`${boundaryDirectory}/*`],
  });
}

function resourceList(run: GatedRun, action: string): string[] {
  return run.requests.filter((request) => request.action === action).flatMap((request) => request.resources);
}

async function setup() {
  const root = await makeRoot("fs-sec-root-");
  const outside = await makeRoot("fs-sec-outside-");
  roots.push(root, outside);
  const external = path.join(outside, "target.txt");
  await fs.writeFile(external, "external");
  await fs.chmod(external, 0o640);
  const tree = path.join(outside, "tree");
  await fs.mkdir(path.join(tree, "sub"), { recursive: true });
  await fs.writeFile(path.join(tree, "sub/file"), "x");
  return { root, outside, external, tree, sb: await Sandbox.create(root) };
}

describe("sandbox root resolution", () => {
  it('returns the sandbox root for resolveForCreate(".")', async () => {
    const { root, sb } = await setup();
    const resolved = await sb.resolveForCreate(".");
    expect(resolved).toEqual({
      full: sb.root,
      outside: false,
      requested: ".",
      realAncestor: sb.root,
    });
    expect(sb.root).toBe(await fs.realpath(root));
  });
});

describe("final symlink mutation gating", () => {
  it("gates chmod on the real external target", async () => {
    const { root, outside, external, sb } = await setup();
    await fs.symlink(external, path.join(root, "link"));
    const beforeMode = (await fs.stat(external)).mode & 0o777;

    const denied = await runGated(chmodTool, { paths: ["link"], mode: "600" }, sb, denyExternal);
    expectDenied(denied, outside);
    expect((await fs.stat(external)).mode & 0o777).toBe(beforeMode);

    const allowed = await runGated(chmodTool, { paths: ["link"], mode: "600" }, sb);
    expect(allowed.error).toBeUndefined();
    expect((await fs.stat(external)).mode & 0o777).toBe(0o600);
    expect(resourceList(allowed, "fs_chmod")).toContain(external);
    expect((await fs.lstat(path.join(root, "link"))).isSymbolicLink()).toBe(true);
  });

  it("follows an in-root chmod symlink without an external gate", async () => {
    const { root, sb } = await setup();
    const target = path.join(root, "target");
    await fs.writeFile(target, "x");
    await fs.chmod(target, 0o640);
    await fs.symlink(target, path.join(root, "in-link"));

    const run = await runGated(chmodTool, { paths: ["in-link"], mode: "600" }, sb);
    expect(run.error).toBeUndefined();
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(run.requests.some((request) => request.action === "external_directory")).toBe(false);
    expect(resourceList(run, "fs_chmod")).toContain("target");
  });

  it("never follows traversal symlinks in recursive chmod", async () => {
    const { root, external, sb } = await setup();
    const tree = path.join(root, "tree");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(tree, "file"), "x");
    await fs.symlink(external, path.join(tree, "external-link"));

    const run = await runGated(chmodTool, { paths: ["tree"], mode: "700", recursive: true }, sb);
    expect(run.error).toBeUndefined();
    expect((await fs.stat(tree)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(tree, "file"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(external)).mode & 0o777).toBe(0o640);
    expect(run.requests.some((request) => request.action === "external_directory")).toBe(false);

    await fs.unlink(path.join(tree, "external-link"));
    const noFollow = await runGated(
      chmodTool,
      { paths: ["tree"], mode: "755", recursive: true, noDereference: true },
      sb,
    );
    expect(noFollow.error).toBeUndefined();
    expect((await fs.stat(path.join(tree, "file"))).mode & 0o777).toBe(0o755);
  });

  it("gates chmod references before reading them", async () => {
    const { root, outside, external, sb } = await setup();
    await fs.chmod(external, 0o600);
    const local = path.join(root, "local");
    await fs.writeFile(local, "x");
    await fs.chmod(local, 0o640);
    await fs.symlink(external, path.join(root, "reference"));

    const beforeMode = (await fs.stat(local)).mode & 0o777;
    const denied = await runGated(chmodTool, { paths: ["local"], reference: "reference" }, sb, denyExternal);
    expectDenied(denied, outside);
    expect((await fs.stat(local)).mode & 0o777).toBe(beforeMode);

    const allowed = await runGated(chmodTool, { paths: ["local"], reference: "reference" }, sb);
    expect(allowed.error).toBeUndefined();
    expect((await fs.stat(local)).mode & 0o777).toBe(0o600);
    expect(resourceList(allowed, "fs_chmod")).toEqual(expect.arrayContaining([external, "local"]));
  });

  it("gates chown on the real external target", async () => {
    const { root, outside, external, sb } = await setup();
    await fs.symlink(external, path.join(root, "link"));
    const uid = process.getuid?.() ?? 0;
    const before = await fs.lstat(external);

    const deniedMark = chownMark();
    const denied = await runGated(chownTool, { paths: ["link"], uid }, sb, denyExternal);
    expectDenied(denied, outside);
    expect(chownCallsSince(deniedMark)).toEqual([]);
    expect((await fs.lstat(external)).uid).toBe(before.uid);
    expect((await fs.lstat(external)).gid).toBe(before.gid);

    const allowedMark = chownMark();
    const allowed = await runGated(chownTool, { paths: ["link"], uid }, sb);
    expect(allowed.error).toBeUndefined();
    expect(allowed.result?.metadata).toMatchObject({ changed: 1 });
    expect(resourceList(allowed, "fs_chown")).toContain(external);
    expect(chownCallsSince(allowedMark)).toEqual([
      { op: "chown", path: external, uid, gid: before.gid },
    ]);
    expect((await fs.lstat(external)).uid).toBe(uid);
  });

  it("keeps external provenance through recursive chown", async () => {
    const { root, tree, sb } = await setup();
    await fs.symlink(tree, path.join(root, "alias"));
    const uid = process.getuid?.() ?? 0;
    const treeBefore = await fs.lstat(tree);
    const subBefore = await fs.lstat(path.join(tree, "sub"));
    const fileBefore = await fs.lstat(path.join(tree, "sub/file"));

    const deniedMark = chownMark();
    const denied = await runGated(chownTool, { paths: ["alias"], uid, recursive: true }, sb, denyExternal);
    expectDenied(denied, tree);
    expect(chownCallsSince(deniedMark)).toEqual([]);
    expect((await fs.lstat(tree)).uid).toBe(treeBefore.uid);
    expect((await fs.lstat(tree)).gid).toBe(treeBefore.gid);
    expect((await fs.lstat(path.join(tree, "sub"))).uid).toBe(subBefore.uid);
    expect((await fs.lstat(path.join(tree, "sub"))).gid).toBe(subBefore.gid);
    expect((await fs.lstat(path.join(tree, "sub/file"))).uid).toBe(fileBefore.uid);
    expect((await fs.lstat(path.join(tree, "sub/file"))).gid).toBe(fileBefore.gid);

    const allowedMark = chownMark();
    const allowed = await runGated(chownTool, { paths: ["alias"], uid, recursive: true }, sb);
    expect(allowed.error).toBeUndefined();
    const resources = resourceList(allowed, "fs_chown");
    expect(resources).toEqual(
      expect.arrayContaining([tree, path.join(tree, "sub"), path.join(tree, "sub/file")]),
    );
    for (const resource of resources) expect(resource.startsWith("/")).toBe(true);
    const allowedCalls = chownCallsSince(allowedMark);
    expect(allowedCalls.every((call) => call.op === "chown")).toBe(true);
    expect(allowedCalls.map((call) => call.path).sort()).toEqual(
      [tree, path.join(tree, "sub"), path.join(tree, "sub/file")].sort(),
    );
  });

  it("does not follow traversal symlinks in recursive chown", async () => {
    const { root, external, sb } = await setup();
    const tree = path.join(root, "tree");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(tree, "file"), "x");
    await fs.symlink(external, path.join(tree, "external-link"));
    const uid = process.getuid?.() ?? 0;
    const before = await fs.lstat(external);

    const followMark = chownMark();
    const run = await runGated(chownTool, { paths: ["tree"], uid, recursive: true }, sb);
    expect(run.error).toBeUndefined();
    expect((await fs.lstat(external)).uid).toBe(before.uid);
    expect(run.requests.some((request) => request.action === "external_directory")).toBe(false);
    const followCalls = chownCallsSince(followMark);
    expect(followCalls.length).toBe(2);
    expect(followCalls.some((call) => call.path === external)).toBe(false);

    const noFollowMark = chownMark();
    const noFollow = await runGated(
      chownTool,
      { paths: ["tree"], uid, recursive: true, noDereference: true },
      sb,
    );
    expect(noFollow.error).toBeUndefined();
    expect((await fs.lstat(external)).uid).toBe(before.uid);
    expect((await fs.lstat(path.join(tree, "external-link"))).isSymbolicLink()).toBe(true);
    const noFollowCalls = chownCallsSince(noFollowMark);
    expect(noFollowCalls.every((call) => call.op === "lchown")).toBe(true);
    expect(noFollowCalls.map((call) => call.path)).toContain(path.join(tree, "external-link"));
    expect(noFollowCalls.some((call) => call.path === external)).toBe(false);
  });

  it("gates truncate on the real external target", async () => {
    const { root, outside, external, sb } = await setup();
    await fs.symlink(external, path.join(root, "link"));
    const before = await fs.stat(external);

    const denied = await runGated(truncateTool, { paths: ["link"], size: "0" }, sb, denyExternal);
    expectDenied(denied, outside);
    expect((await fs.stat(external)).size).toBe(before.size);
    expect((await fs.stat(external)).mtimeMs).toBe(before.mtimeMs);

    const allowed = await runGated(truncateTool, { paths: ["link"], size: "3" }, sb);
    expect(allowed.error).toBeUndefined();
    expect((await fs.stat(external)).size).toBe(3);
    expect(resourceList(allowed, "fs_truncate")).toContain(external);
  });

  it("gates creation through a dangling external symlink", async () => {
    const { root, outside, sb } = await setup();
    const missing = path.join(outside, "created.txt");
    await fs.symlink(missing, path.join(root, "dangling"));

    const denied = await runGated(truncateTool, { paths: ["dangling"], size: "2" }, sb, denyExternal);
    expectDenied(denied, outside);
    expect(await pathExists(missing)).toBe(false);

    const allowed = await runGated(truncateTool, { paths: ["dangling"], size: "2" }, sb);
    expect(allowed.error).toBeUndefined();
    expect((await fs.stat(missing)).size).toBe(2);
    expect(resourceList(allowed, "fs_truncate")).toContain(missing);
  });

  it("resolves in-root dangling symlinks and rejects link cycles", async () => {
    const { root, sb } = await setup();
    const target = path.join(root, "created");
    await fs.symlink(target, path.join(root, "dangling"));

    const created = await runGated(truncateTool, { paths: ["dangling"], size: "1" }, sb);
    expect(created.error).toBeUndefined();
    expect((await fs.stat(target)).size).toBe(1);
    expect(created.requests.some((request) => request.action === "external_directory")).toBe(false);

    await fs.symlink("cycle2", path.join(root, "cycle1"));
    await fs.symlink("cycle1", path.join(root, "cycle2"));
    const cycle = await runGated(truncateTool, { paths: ["cycle1"], size: "1" }, sb);
    expect(cycle.error).toMatchObject({ code: "io" });
  });

  it("gates truncate references before reading their size", async () => {
    const { root, outside, external, sb } = await setup();
    const local = path.join(root, "local");
    await fs.writeFile(local, "1234");
    await fs.symlink(external, path.join(root, "reference"));

    const localBefore = await fs.lstat(local);
    const denied = await runGated(truncateTool, { paths: ["local"], reference: "reference" }, sb, denyExternal);
    expectDenied(denied, outside);
    expect((await fs.stat(local)).size).toBe(localBefore.size);
    expect((await fs.stat(local)).mtimeMs).toBe(localBefore.mtimeMs);

    const allowed = await runGated(truncateTool, { paths: ["local"], reference: "reference" }, sb);
    expect(allowed.error).toBeUndefined();
    expect((await fs.stat(local)).size).toBe(8);
    expect(resourceList(allowed, "fs_truncate")).toEqual(expect.arrayContaining([external, "local"]));
  });

  it("gates touch on the real external target", async () => {
    const { root, outside, external, sb } = await setup();
    await fs.symlink(external, path.join(root, "link"));
    const before = await fs.lstat(external);

    const denied = await runGated(touchTool, { paths: ["link"] }, sb, denyExternal);
    expectDenied(denied, outside);
    const unchanged = await fs.lstat(external);
    expect(unchanged.atimeMs).toBe(before.atimeMs);
    expect(unchanged.mtimeMs).toBe(before.mtimeMs);

    const allowed = await runGated(touchTool, { paths: ["link"], date: "@1000000000" }, sb);
    expect(allowed.error).toBeUndefined();
    expect((await fs.lstat(external)).mtime.toISOString()).toBe("2001-09-09T01:46:40.000Z");
    expect(resourceList(allowed, "fs_touch")).toContain(external);
  });

  it("gates touch creation through a dangling external symlink", async () => {
    const { root, outside, sb } = await setup();
    const missing = path.join(outside, "touched.txt");
    await fs.symlink(missing, path.join(root, "dangling"));

    const denied = await runGated(touchTool, { paths: ["dangling"] }, sb, denyExternal);
    expectDenied(denied, outside);
    expect(await pathExists(missing)).toBe(false);

    const allowed = await runGated(touchTool, { paths: ["dangling"] }, sb);
    expect(allowed.error).toBeUndefined();
    expect(await pathExists(missing)).toBe(true);
    expect(resourceList(allowed, "fs_touch")).toContain(missing);
  });

  it("follows an in-root touch symlink and gates touch references", async () => {
    const { root, outside, external, sb } = await setup();
    const target = path.join(root, "target");
    await fs.writeFile(target, "x");
    const old = new Date("2020-01-02T03:04:05Z");
    await fs.utimes(target, old, old);
    await fs.symlink(target, path.join(root, "in-link"));

    const followed = await runGated(touchTool, { paths: ["in-link"], date: "@1000000000" }, sb);
    expect(followed.error).toBeUndefined();
    expect((await fs.lstat(target)).mtime.toISOString()).toBe("2001-09-09T01:46:40.000Z");
    expect(followed.requests.some((request) => request.action === "external_directory")).toBe(false);
    expect(resourceList(followed, "fs_touch")).toContain("target");

    await fs.utimes(target, old, old);
    const referenceTime = new Date("2019-05-06T07:08:09Z");
    await fs.utimes(external, referenceTime, referenceTime);
    await fs.symlink(external, path.join(root, "reference"));
    const denied = await runGated(touchTool, { paths: ["target"], reference: "reference" }, sb, denyExternal);
    expectDenied(denied, outside);
    expect((await fs.lstat(target)).mtime.toISOString()).toBe(old.toISOString());

    const allowed = await runGated(touchTool, { paths: ["target"], reference: "reference" }, sb);
    expect(allowed.error).toBeUndefined();
    expect((await fs.lstat(target)).mtime.toISOString()).toBe(referenceTime.toISOString());
  });

  it("resolves parent symlinks for noDereference mutations", async () => {
    const { root, outside, external, sb } = await setup();
    await fs.symlink(outside, path.join(root, "aliasdir"));
    const uid = process.getuid?.() ?? 0;
    const before = await fs.lstat(external);

    const chmodDenied = await runGated(
      chmodTool,
      { paths: ["aliasdir/target.txt"], mode: "600", noDereference: true },
      sb,
      denyExternal,
    );
    expectDenied(chmodDenied, outside);
    expect((await fs.stat(external)).mode & 0o777).toBe(before.mode & 0o777);

    const chmodAllowed = await runGated(
      chmodTool,
      { paths: ["aliasdir/target.txt"], mode: "600", noDereference: true },
      sb,
    );
    expect(chmodAllowed.error).toBeUndefined();
    expect((await fs.stat(external)).mode & 0o777).toBe(0o600);
    expect(resourceList(chmodAllowed, "fs_chmod")).toContain(external);

    const chownDeniedMark = chownMark();
    const chownDenied = await runGated(
      chownTool,
      { paths: ["aliasdir/target.txt"], uid, noDereference: true },
      sb,
      denyExternal,
    );
    expectDenied(chownDenied, outside);
    expect(chownCallsSince(chownDeniedMark)).toEqual([]);
    expect((await fs.lstat(external)).uid).toBe(before.uid);
    expect((await fs.lstat(external)).gid).toBe(before.gid);

    const chownAllowedMark = chownMark();
    const chownAllowed = await runGated(
      chownTool,
      { paths: ["aliasdir/target.txt"], uid, noDereference: true },
      sb,
    );
    expect(chownAllowed.error).toBeUndefined();
    expect(resourceList(chownAllowed, "fs_chown")).toContain(external);
    expect(chownCallsSince(chownAllowedMark)).toEqual([
      { op: "lchown", path: external, uid, gid: before.gid },
    ]);

    const link = path.join(outside, "link");
    await fs.symlink(external, link);
    const linkBefore = await fs.lstat(link);
    const linkChownDeniedMark = chownMark();
    const linkChownDenied = await runGated(
      chownTool,
      { paths: ["aliasdir/link"], uid, noDereference: true },
      sb,
      denyExternal,
    );
    expectDenied(linkChownDenied, outside);
    expect(chownCallsSince(linkChownDeniedMark)).toEqual([]);
    expect((await fs.lstat(link)).uid).toBe(linkBefore.uid);
    expect((await fs.lstat(link)).gid).toBe(linkBefore.gid);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);

    const linkChownAllowedMark = chownMark();
    const linkChownAllowed = await runGated(
      chownTool,
      { paths: ["aliasdir/link"], uid, noDereference: true },
      sb,
    );
    expect(linkChownAllowed.error).toBeUndefined();
    expect(resourceList(linkChownAllowed, "fs_chown")).toContain(link);
    expect(chownCallsSince(linkChownAllowedMark)).toEqual([
      { op: "lchown", path: link, uid, gid: linkBefore.gid },
    ]);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(external)).uid).toBe(before.uid);

    const targetMode = (await fs.stat(external)).mode & 0o777;
    const linkChmod = await runGated(
      chmodTool,
      { paths: ["aliasdir/link"], mode: "640", noDereference: true },
      sb,
    );
    expect(linkChmod.error).toMatchObject({ code: "unsupported" });
    expect((await fs.stat(external)).mode & 0o777).toBe(targetMode);
  });

  it("gates noDereference touch and truncate through a parent symlink", async () => {
    const { root, outside, external, sb } = await setup();
    await fs.symlink(outside, path.join(root, "aliasdir"));

    const touchBefore = await fs.lstat(external);
    const touchDenied = await runGated(
      touchTool,
      { paths: ["aliasdir/target.txt"], noDereference: true },
      sb,
      denyExternal,
    );
    expectDenied(touchDenied, outside);
    expect(touchDenied.requests[0]?.resources).toEqual([`${outside}/*`]);
    const touchAfter = await fs.lstat(external);
    expect(touchAfter.mtimeMs).toBe(touchBefore.mtimeMs);
    expect(touchAfter.atimeMs).toBe(touchBefore.atimeMs);

    const truncateBefore = await fs.lstat(external);
    const truncateDenied = await runGated(
      truncateTool,
      { paths: ["aliasdir/target.txt"], size: "0", noDereference: true },
      sb,
      denyExternal,
    );
    expectDenied(truncateDenied, outside);
    expect(truncateDenied.requests[0]?.resources).toEqual([`${outside}/*`]);
    const truncateAfter = await fs.lstat(external);
    expect(truncateAfter.size).toBe(truncateBefore.size);
    expect(truncateAfter.mode).toBe(truncateBefore.mode);
    expect(truncateAfter.mtimeMs).toBe(truncateBefore.mtimeMs);
    expect(await fs.readFile(external, "utf8")).toBe("external");
  });

  it("refuses chown on the sandbox root before permission or mutation", async () => {
    const { root, sb } = await setup();
    const uid = process.getuid?.() ?? 0;
    const before = await fs.lstat(root);
    const mark = chownMark();
    const run = await runGated(chownTool, { paths: ["."], uid }, sb);
    expect(run.error).toMatchObject({ code: "outside" });
    expect(run.requests).toHaveLength(0);
    expect(chownCallsSince(mark)).toEqual([]);
    expect((await fs.lstat(root)).uid).toBe(before.uid);
  });

  it("uses directory targets and conservative reference boundaries", async () => {
    const { root, outside, tree, sb } = await setup();
    await fs.symlink(tree, path.join(root, "alias"));
    const local = path.join(root, "local");
    await fs.writeFile(local, "1234");
    await fs.chmod(local, 0o640);

    const initialTreeMode = (await fs.stat(tree)).mode & 0o777;
    const chmodDenied = await runGated(chmodTool, { paths: ["alias"], mode: "750" }, sb, denyExternal);
    expectDenied(chmodDenied, tree);
    expect((await fs.stat(tree)).mode & 0o777).toBe(initialTreeMode);

    const chmodAllowed = await runGated(chmodTool, { paths: ["alias"], mode: "750" }, sb);
    expect(chmodAllowed.error).toBeUndefined();
    expect((await fs.stat(tree)).mode & 0o777).toBe(0o750);
    expect(resourceList(chmodAllowed, "fs_chmod")).toContain(tree);

    await fs.symlink(tree, path.join(root, "reference"));
    const referenceLocalMode = (await fs.stat(local)).mode & 0o777;
    const chmodReferenceDenied = await runGated(
      chmodTool,
      { paths: ["local"], reference: "reference" },
      sb,
      denyExternal,
    );
    expectDenied(chmodReferenceDenied, outside);
    expect((await fs.stat(local)).mode & 0o777).toBe(referenceLocalMode);

    const chmodReferenceAllowed = await runGated(chmodTool, { paths: ["local"], reference: "reference" }, sb);
    expect(chmodReferenceAllowed.error).toBeUndefined();
    expect((await fs.stat(local)).mode & 0o777).toBe(0o750);

    const treeBefore = await fs.lstat(tree);
    const truncateTargetDenied = await runGated(truncateTool, { paths: ["alias"], size: "1" }, sb, denyExternal);
    expectDenied(truncateTargetDenied, tree);
    expect((await fs.lstat(tree)).mode).toBe(treeBefore.mode);
    expect((await fs.lstat(tree)).size).toBe(treeBefore.size);

    const referenceLocalSize = (await fs.lstat(local)).size;
    const referenceLocalTime = (await fs.lstat(local)).mtimeMs;
    const truncateReferenceDenied = await runGated(
      truncateTool,
      { paths: ["local"], reference: "reference" },
      sb,
      denyExternal,
    );
    expectDenied(truncateReferenceDenied, outside);
    expect((await fs.lstat(local)).size).toBe(referenceLocalSize);
    expect((await fs.lstat(local)).mtimeMs).toBe(referenceLocalTime);

    const treeSize = (await fs.lstat(tree)).size;
    const truncateReferenceAllowed = await runGated(truncateTool, { paths: ["local"], reference: "reference" }, sb);
    expect(truncateReferenceAllowed.error).toBeUndefined();
    expect((await fs.stat(local)).size).toBe(treeSize);

    const treeBeforeTouch = await fs.lstat(tree);
    const touchTargetDenied = await runGated(touchTool, { paths: ["alias"] }, sb, denyExternal);
    expectDenied(touchTargetDenied, tree);
    expect((await fs.lstat(tree)).mtimeMs).toBe(treeBeforeTouch.mtimeMs);
    expect((await fs.lstat(tree)).atimeMs).toBe(treeBeforeTouch.atimeMs);

    const treeTime = new Date("2018-04-03T02:01:00Z");
    await fs.utimes(tree, treeTime, treeTime);
    const localBefore = (await fs.lstat(local)).mtime.toISOString();
    const touchReferenceDenied = await runGated(
      touchTool,
      { paths: ["local"], reference: "reference" },
      sb,
      denyExternal,
    );
    expectDenied(touchReferenceDenied, outside);
    expect((await fs.lstat(local)).mtime.toISOString()).toBe(localBefore);

    const touchReferenceAllowed = await runGated(touchTool, { paths: ["local"], reference: "reference" }, sb);
    expect(touchReferenceAllowed.error).toBeUndefined();
    expect((await fs.lstat(local)).mtime.toISOString()).toBe(treeTime.toISOString());
  });
});
