/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { preserve } from "../../src/core/fsutil.js";
import { Sandbox } from "../../src/core/sandbox.js";
import { cpTool } from "../../src/tools/cp.js";
import { mktempTool } from "../../src/tools/mktemp.js";
import { mvTool } from "../../src/tools/mv.js";
import { makeRoot, pathExists, runSpec } from "../helpers.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: (size: number) => Buffer.alloc(size) };
});

const copyState = vi.hoisted(() => ({
  active: 0,
  max: 0,
  calls: 0,
  yield: false,
  renameError: false,
  beforeRename: null as null | ((source: string, destination: string) => Promise<void> | void),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      copyState.active++;
      copyState.max = Math.max(copyState.max, copyState.active);
      copyState.calls++;
      if (copyState.yield) await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        return await actual.copyFile(...args);
      } finally {
        copyState.active--;
      }
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (copyState.beforeRename !== null) {
        await copyState.beforeRename(String(args[0]), String(args[1]));
      }
      if (copyState.renameError) {
        throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      }
      return actual.rename(...args);
    },
  };
});

const roots: string[] = [];
const files: string[] = [];

afterEach(async () => {
  copyState.yield = false;
  copyState.renameError = false;
  copyState.beforeRename = null;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  for (const file of files.splice(0)) await fs.rm(file, { force: true });
});

async function setup(): Promise<{ root: string; outside: string; sb: Sandbox }> {
  const root = await makeRoot();
  const outside = await makeRoot("fs-plugin-outside-");
  roots.push(root, outside);
  return { root, outside, sb: await Sandbox.create(root) };
}

function unique(label: string): string {
  return `${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

describe("cp destination hardening", () => {
  it("follows an internal destination symlink without replacing the link", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "src"), "new");
    await fs.writeFile(path.join(root, "target"), "old");
    await fs.symlink("target", path.join(root, "link"));
    await fs.mkdir(path.join(root, "real-dir"));
    await fs.symlink("real-dir", path.join(root, "dir-link"), "dir");

    await runSpec(cpTool, { sources: ["src"], destination: "link" }, sb);
    expect(await fs.readFile(path.join(root, "target"), "utf8")).toBe("new");
    expect((await fs.lstat(path.join(root, "link"))).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(path.join(root, "link"))).toBe("target");

    await runSpec(cpTool, { sources: ["src"], destination: "dir-link" }, sb);
    expect(await fs.readFile(path.join(root, "real-dir/src"), "utf8")).toBe("new");
  });

  it("skips an existing destination with archive noClobber", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "target"), "target");
    await fs.writeFile(path.join(root, "existing"), "keep");
    await fs.symlink("target", path.join(root, "link"));

    const result = await runSpec(
      cpTool,
      { sources: ["link"], destination: "existing", archive: true, noClobber: true },
      sb,
    );
    expect(result.result.metadata?.copied).toBe(0);
    expect(await fs.readFile(path.join(root, "existing"), "utf8")).toBe("keep");
    expect((await fs.lstat(path.join(root, "existing"))).isFile()).toBe(true);
  });

  it("fails closed on an existing symlink inside a recursive destination", async () => {
    const { root, outside, sb } = await setup();
    await fs.chmod(outside, 0o750);
    const victim = path.join(outside, "victim");
    await fs.writeFile(victim, "outside");
    await fs.chmod(victim, 0o640);
    await fs.mkdir(path.join(root, "dest/src"), { recursive: true });
    await fs.symlink(outside, path.join(root, "dest/src/sub"), "dir");
    await fs.mkdir(path.join(root, "src/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "src/sub/file"), "inside");

    await expect(
      runSpec(cpTool, { sources: ["src"], destination: "dest", recursive: true }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readFile(victim, "utf8")).toBe("outside");
    expect((await fs.stat(victim)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o750);
    expect(await pathExists(path.join(outside, "file"))).toBe(false);
  });

  it("fails closed on an existing file symlink inside a recursive destination", async () => {
    const { root, outside, sb } = await setup();
    const victim = path.join(outside, "victim");
    await fs.writeFile(victim, "outside");
    await fs.mkdir(path.join(root, "dest/src"), { recursive: true });
    await fs.symlink(victim, path.join(root, "dest/src/a"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/a"), "inside");

    await expect(
      runSpec(cpTool, { sources: ["src"], destination: "dest", recursive: true }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readFile(victim, "utf8")).toBe("outside");
    expect(await fs.readFile(path.join(root, "src/a"), "utf8")).toBe("inside");
  });

  it("rejects a hard-link alias nested inside a recursive destination", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/a"), "safe");
    await fs.mkdir(path.join(root, "dest/src"), { recursive: true });
    await fs.link(path.join(root, "src/a"), path.join(root, "dest/src/a"));

    await expect(
      runSpec(cpTool, { sources: ["src"], destination: "dest", recursive: true }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readFile(path.join(root, "src/a"), "utf8")).toBe("safe");
    expect(await fs.readFile(path.join(root, "dest/src/a"), "utf8")).toBe("safe");
  });

  it("replaces an internal destination symlink without touching its outside referent", async () => {
    const { root, outside, sb } = await setup();
    const victim = path.join(outside, "victim");
    await fs.writeFile(path.join(root, "target"), "target");
    await fs.writeFile(victim, "victim");
    await fs.symlink("target", path.join(root, "link"));
    await fs.symlink(victim, path.join(root, "link2"));

    await runSpec(cpTool, { sources: ["link"], destination: "link2", archive: true }, sb);
    expect(await fs.readlink(path.join(root, "link2"))).toBe("target");
    expect(await fs.readFile(victim, "utf8")).toBe("victim");
    expect(await fs.readFile(path.join(root, "target"), "utf8")).toBe("target");
  });

  it("rejects an archived symlink copied onto itself", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "target"), "target");
    await fs.symlink("target", path.join(root, "link"));

    await expect(
      runSpec(cpTool, { sources: ["link"], destination: "link", archive: true }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readlink(path.join(root, "link"))).toBe("target");
  });

  it("still creates a missing destination under noClobber", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "src"), "src");

    await runSpec(cpTool, { sources: ["src"], destination: "new", noClobber: true }, sb);
    expect(await fs.readFile(path.join(root, "new"), "utf8")).toBe("src");
  });

  it("rejects copying an archived symlink onto its referent", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "target"), "keep");
    await fs.symlink("target", path.join(root, "link"));

    await expect(
      runSpec(cpTool, { sources: ["link"], destination: "target", archive: true }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readFile(path.join(root, "target"), "utf8")).toBe("keep");
    expect((await fs.lstat(path.join(root, "target"))).isFile()).toBe(true);
    expect((await fs.lstat(path.join(root, "link"))).isSymbolicLink()).toBe(true);
  });

  it("copies a dangling archived symlink without a referent check", async () => {
    const { root, sb } = await setup();
    await fs.symlink("missing-target", path.join(root, "dangling"));

    await runSpec(cpTool, { sources: ["dangling"], destination: "copy", archive: true }, sb);
    expect(await fs.readlink(path.join(root, "copy"))).toBe("missing-target");
    expect((await fs.lstat(path.join(root, "dangling"))).isSymbolicLink()).toBe(true);
  });

  it("does not create a noClobber destination's dangling symlink referent", async () => {
    const { root, outside, sb } = await setup();
    const target = path.join(outside, "created.txt");
    await fs.writeFile(path.join(root, "src"), "src");
    await fs.symlink(target, path.join(root, "dangling"));

    const result = await runSpec(
      cpTool,
      { sources: ["src"], destination: "dangling", noClobber: true },
      sb,
    );
    expect(result.result.metadata?.copied).toBe(0);
    expect(await pathExists(target)).toBe(false);
    expect((await fs.lstat(path.join(root, "dangling"))).isSymbolicLink()).toBe(true);
  });

  it("denies an outside target reached through a destination symlink", async () => {
    const { root, outside, sb } = await setup();
    const victim = path.join(outside, "victim");
    await fs.writeFile(path.join(root, "src"), "replacement");
    await fs.writeFile(victim, "original");
    await fs.symlink(victim, path.join(root, "link"));

    await expect(
      runSpec(cpTool, { sources: ["src"], destination: "link" }, sb, { deny: true }),
    ).rejects.toThrow("permission denied by test");
    expect(await fs.readFile(victim, "utf8")).toBe("original");
    expect((await fs.lstat(path.join(root, "link"))).isSymbolicLink()).toBe(true);
  });

  it("gates and writes a dangling destination symlink target outside", async () => {
    const { root, outside, sb } = await setup();
    const target = path.join(outside, "created.txt");
    await fs.writeFile(path.join(root, "src"), "made");
    await fs.symlink(target, path.join(root, "dangling"));

    await expect(
      runSpec(cpTool, { sources: ["src"], destination: "dangling" }, sb, { deny: true }),
    ).rejects.toThrow("permission denied by test");
    expect(await pathExists(target)).toBe(false);

    const allowed = await runSpec(cpTool, { sources: ["src"], destination: "dangling" }, sb);
    expect(await fs.readFile(target, "utf8")).toBe("made");
    expect((await fs.lstat(path.join(root, "dangling"))).isSymbolicLink()).toBe(true);
    expect(allowed.requests).toContainEqual(
      expect.objectContaining({ action: "external_directory", resources: [`${outside}/*`] }),
    );
    expect(allowed.requests).toContainEqual(
      expect.objectContaining({ action: "fs_cp", resources: expect.arrayContaining([target]) }),
    );
  });

  it("rejects a destination symlink loop without writing", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "src"), "src");
    await fs.symlink("loop", path.join(root, "loop"));

    await expect(
      runSpec(cpTool, { sources: ["src"], destination: "loop" }, sb),
    ).rejects.toMatchObject({ code: "io" });
    expect(await fs.readFile(path.join(root, "src"), "utf8")).toBe("src");
  });

  it("rejects a hard-link alias of the source before writing", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "safe");
    await fs.link(path.join(root, "a"), path.join(root, "b"));

    await expect(
      runSpec(cpTool, { sources: ["a"], destination: "b" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("safe");
    expect(await fs.readFile(path.join(root, "b"), "utf8")).toBe("safe");
  });

  it("overwrites a different inode on another device", async () => {
    const { root, sb } = await setup();
    const shm = await fs.mkdtemp("/dev/shm/fs-plugin-test-");
    roots.push(shm);
    const destination = path.join(shm, "dest");
    await fs.writeFile(path.join(root, "src"), "new");
    await fs.writeFile(destination, "old");

    await runSpec(cpTool, { sources: ["src"], destination }, sb);
    expect(await fs.readFile(destination, "utf8")).toBe("new");
  });

  it("reports every copied file and directory at concurrency 8", async () => {
    const { root, sb } = await setup();
    const expected = await makeSyntheticTree(root);
    const copied = await runSpec(
      cpTool,
      { sources: ["tree"], destination: "copy", recursive: true },
      sb,
      { concurrency: 8 },
    );
    expect(copied.result.metadata?.copied).toBe(expected);
    expect(await fs.readFile(path.join(root, "copy/d7/s7/f79"), "utf8")).toBe("x");
  }, 30_000);

  it("bounds active copies across multiple deep sources", async () => {
    const { root, sb } = await setup();
    const sources: string[] = [];
    const filesPerSource = 8;
    for (let source = 0; source < 8; source++) {
      const name = `src${source}`;
      sources.push(name);
      const deep = path.join(root, name, "one", "two");
      await fs.mkdir(deep, { recursive: true });
      await Promise.all(
        Array.from({ length: filesPerSource }, (_, index) =>
          fs.writeFile(path.join(deep, `f${index}`), "x"),
        ),
      );
    }
    await fs.mkdir(path.join(root, "dest"));

    copyState.active = 0;
    copyState.max = 0;
    copyState.calls = 0;
    copyState.yield = true;
    const result = await runSpec(
      cpTool,
      { sources, destination: "dest", recursive: true },
      sb,
      { concurrency: 4 },
    );
    copyState.yield = false;

    expect(copyState.calls).toBe(sources.length * filesPerSource);
    expect(copyState.max).toBeLessThanOrEqual(4);
    expect(copyState.max).toBeGreaterThanOrEqual(2);
    expect(result.result.metadata?.copied).toBe(sources.length * 11);
  });
});

async function makeSyntheticTree(root: string): Promise<number> {
  const branches = 8;
  const subdirectories = 8;
  const entries = 80;
  const source = path.join(root, "tree");
  await fs.mkdir(source);
  for (let branch = 0; branch < branches; branch++) {
    const branchDir = path.join(source, `d${branch}`);
    await fs.mkdir(branchDir);
    for (let sub = 0; sub < subdirectories; sub++) {
      const subDir = path.join(branchDir, `s${sub}`);
      await fs.mkdir(subDir);
      await Promise.all(
        Array.from({ length: entries }, (_, index) =>
          fs.writeFile(path.join(subDir, `f${index}`), "x"),
        ),
      );
    }
  }
  return 1 + branches + branches * subdirectories + branches * subdirectories * entries;
}

describe("mv destination hardening", () => {
  it("rejects moving a symlink onto its referent", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "target"), "keep");
    await fs.symlink("target", path.join(root, "link"));

    await expect(
      runSpec(mvTool, { sources: ["link"], destination: "target" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readFile(path.join(root, "target"), "utf8")).toBe("keep");
    expect((await fs.lstat(path.join(root, "target"))).isFile()).toBe(true);
    expect((await fs.lstat(path.join(root, "link"))).isSymbolicLink()).toBe(true);
  });

  it("moves a dangling symlink without a referent check", async () => {
    const { root, sb } = await setup();
    await fs.symlink("missing-target", path.join(root, "dangling"));

    await runSpec(mvTool, { sources: ["dangling"], destination: "moved" }, sb);
    expect(await fs.readlink(path.join(root, "moved"))).toBe("missing-target");
    expect(await pathExists(path.join(root, "dangling"))).toBe(false);
  });

  it("still replaces an existing file with force", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "a"), "a");
    await fs.writeFile(path.join(root, "b"), "b");

    await runSpec(mvTool, { sources: ["a"], destination: "b", force: true }, sb);
    expect(await pathExists(path.join(root, "a"))).toBe(false);
    expect(await fs.readFile(path.join(root, "b"), "utf8")).toBe("a");
  });

  it("fails instead of deleting a nonempty destination directory", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "source"));
    await fs.writeFile(path.join(root, "source/inside"), "inside");
    await fs.mkdir(path.join(root, "dest/source"), { recursive: true });
    await fs.writeFile(path.join(root, "dest/source/keep"), "keep");

    await expect(
      runSpec(mvTool, { sources: ["source"], destination: "dest", force: true }, sb),
    ).rejects.toMatchObject({ code: "not-empty" });
    expect(await fs.readFile(path.join(root, "source/inside"), "utf8")).toBe("inside");
    expect(await fs.readFile(path.join(root, "dest/source/keep"), "utf8")).toBe("keep");
  });

  it("refuses a cross-device move onto a destination symlink", async () => {
    const { root, outside, sb } = await setup();
    const victim = path.join(outside, "victim");
    await fs.writeFile(path.join(root, "source"), "source");
    await fs.writeFile(victim, "victim");
    await fs.symlink(victim, path.join(root, "destlink"));
    copyState.renameError = true;

    await expect(
      runSpec(mvTool, { sources: ["source"], destination: "destlink" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("source");
    expect(await fs.readFile(victim, "utf8")).toBe("victim");
  });

  it("keeps the source when a cross-device noClobber destination appears during the move", async () => {
    const { root, sb } = await setup();
    const source = path.join(root, "source");
    const destination = path.join(root, "dest");
    await fs.writeFile(source, "source");
    copyState.renameError = true;
    copyState.beforeRename = async (_source, target) => {
      await fs.writeFile(target, "raced");
    };

    await expect(
      runSpec(mvTool, { sources: ["source"], destination, noClobber: true }, sb),
    ).rejects.toMatchObject({ code: "cross-device" });
    expect(await fs.readFile(source, "utf8")).toBe("source");
    expect(await fs.readFile(destination, "utf8")).toBe("raced");
  });

  it("keeps a source when a cross-device update skips a nested entry", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "src/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "src/sub/a"), "source-a");
    await fs.writeFile(path.join(root, "src/sub/b"), "source-b");
    await fs.mkdir(path.join(root, "dest/src/sub"), { recursive: true });
    await fs.writeFile(path.join(root, "dest/src/sub/a"), "dest-a");
    const future = new Date(Date.now() + 120_000);
    await fs.utimes(path.join(root, "dest/src/sub/a"), future, future);
    await fs.utimes(path.join(root, "src"), future, future);
    await fs.utimes(path.join(root, "src/sub"), future, future);
    copyState.renameError = true;

    const move = runSpec(mvTool, { sources: ["src"], destination: "dest", update: true }, sb);
    const error = await move.catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "cross-device" });
    expect((error as Error).message).toContain("partial destination");
    expect(await fs.readFile(path.join(root, "src/sub/a"), "utf8")).toBe("source-a");
    expect(await fs.readFile(path.join(root, "src/sub/b"), "utf8")).toBe("source-b");
    expect(await fs.readFile(path.join(root, "dest/src/sub/a"), "utf8")).toBe("dest-a");
  });

  it("completes a mocked cross-device move onto a regular destination", async () => {
    const { root, sb } = await setup();
    const source = path.join(root, "source");
    const destination = path.join(root, "dest");
    await fs.writeFile(source, "new");
    await fs.writeFile(destination, "old");
    copyState.renameError = true;

    await runSpec(mvTool, { sources: ["source"], destination }, sb);
    expect(await pathExists(source)).toBe(false);
    expect(await fs.readFile(destination, "utf8")).toBe("new");
  });

  it("bounds EXDEV fallback copies with the shared limiter", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "src/sub"), { recursive: true });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fs.writeFile(path.join(root, "src/sub", `f${index}`), "x"),
      ),
    );
    copyState.renameError = true;
    copyState.active = 0;
    copyState.max = 0;
    copyState.calls = 0;
    copyState.yield = true;

    await runSpec(mvTool, { sources: ["src"], destination: "dest" }, sb, { concurrency: 4 });
    copyState.yield = false;

    expect(await pathExists(path.join(root, "dest/sub/f7"))).toBe(true);
    expect(await pathExists(path.join(root, "src"))).toBe(false);
    expect(copyState.calls).toBe(8);
    expect(copyState.max).toBeLessThanOrEqual(4);
    expect(copyState.max).toBeGreaterThanOrEqual(2);
  });

  it("refuses a destination under the source directory before any fallback", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/file"), "keep");
    copyState.renameError = true;

    await expect(
      runSpec(mvTool, { sources: ["src"], destination: "src/moved" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readFile(path.join(root, "src/file"), "utf8")).toBe("keep");
    expect(await pathExists(path.join(root, "src/moved"))).toBe(false);
  });
});

describe("preserve hardening", () => {
  it("refuses to preserve metadata through a symlink", async () => {
    const { root, outside } = await setup();
    const victim = path.join(outside, "victim");
    await fs.writeFile(victim, "victim");
    await fs.chmod(victim, 0o640);
    await fs.symlink(victim, path.join(root, "link"));

    await expect(
      preserve(path.join(root, "link"), await fs.stat(victim)),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await fs.readFile(victim, "utf8")).toBe("victim");
    expect((await fs.stat(victim)).mode & 0o777).toBe(0o640);
  });
});

describe("mktemp hardening", () => {
  it("resolves a relative tmpdir inside the sandbox", async () => {
    const { root, sb } = await setup();
    const name = unique("mktemp-relative");
    const cwdCandidate = path.resolve(name);
    expect(await pathExists(cwdCandidate)).toBe(false);

    const result = await runSpec(mktempTool, { tmpdir: name, template: "f.XXX" }, sb);
    const created = result.result.stdout.toString().trim();
    expect(created).toBe(path.join(root, name, "f.000"));
    expect(await pathExists(created)).toBe(true);
    expect(await pathExists(cwdCandidate)).toBe(false);
    expect(result.requests).toContainEqual(
      expect.objectContaining({ action: "fs_mktemp", resources: [`${name}/*`] }),
    );
    expect(result.requests.some((request) => request.action === "external_directory")).toBe(false);
  });

  it("uses the default template when it is omitted", async () => {
    const { root, sb } = await setup();
    const result = await runSpec(mktempTool, { tmpdir: root }, sb);
    const created = result.result.stdout.toString().trim();
    expect(created).toBe(path.join(root, "tmp.0000000000"));
    expect(await pathExists(created)).toBe(true);
  });

  it("uses the trusted OS tmpdir when tmpdir is omitted", async () => {
    const { sb } = await setup();
    const template = `${unique("opencode-fs")}.XXXXXX`;
    const result = await runSpec(mktempTool, { template }, sb);
    const created = result.result.stdout.toString().trim();
    files.push(created);
    expect(path.dirname(created)).toBe(path.resolve(os.tmpdir()));
    expect(await pathExists(created)).toBe(true);
    expect(result.requests).toContainEqual(
      expect.objectContaining({
        action: "fs_mktemp",
        resources: [path.join(path.resolve(os.tmpdir()), "*")],
      }),
    );
  });

  it("creates private temporary directories under a permissive umask", async () => {
    const { root, sb } = await setup();
    const previous = process.umask(0o000);
    try {
      const result = await runSpec(
        mktempTool,
        { tmpdir: root, template: "d.XXX", directory: true },
        sb,
      );
      const created = result.result.stdout.toString().trim();
      expect((await fs.stat(created)).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  });

  it("rejects escaping template and suffix components without writing", async () => {
    const { root, outside, sb } = await setup();
    const escapeName = unique("escape");

    await expect(
      runSpec(mktempTool, { tmpdir: root, template: `../${escapeName}.XXX` }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(mktempTool, { tmpdir: root, template: path.join(outside, "abs.XXX") }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(mktempTool, { tmpdir: root, template: "ok.XXX", suffix: "/escape" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(mktempTool, { tmpdir: root, template: "ok.XXX", suffix: "..\\escape" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(mktempTool, { tmpdir: root, template: "ok.XXX", suffix: "." }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(mktempTool, { tmpdir: root, template: "ok.XXX", suffix: ".." }, sb),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      runSpec(mktempTool, { tmpdir: root, template: "ok.XXX", suffix: "a\0b" }, sb),
    ).rejects.toMatchObject({ code: "invalid" });

    expect(await fs.readdir(outside)).toEqual([]);
    expect(await pathExists(path.join(path.dirname(root), `${escapeName}.000`))).toBe(false);
  });

  it("does not rename a file over an existing suffix target", async () => {
    const { root, sb } = await setup();
    await fs.writeFile(path.join(root, "x.000.suf"), "keep");

    await expect(
      runSpec(mktempTool, { tmpdir: root, template: "x.XXX", suffix: ".suf" }, sb),
    ).rejects.toMatchObject({ code: "exists" });
    expect(await fs.readFile(path.join(root, "x.000.suf"), "utf8")).toBe("keep");
    expect(await pathExists(path.join(root, "x.000"))).toBe(false);
  });

  it("does not rename a directory over an existing suffix target", async () => {
    const { root, sb } = await setup();
    await fs.mkdir(path.join(root, "d.000.suf"));
    await fs.writeFile(path.join(root, "d.000.suf/keep"), "keep");

    await expect(
      runSpec(
        mktempTool,
        { tmpdir: root, template: "d.XXX", suffix: ".suf", directory: true },
        sb,
      ),
    ).rejects.toMatchObject({ code: "exists" });
    expect(await fs.readFile(path.join(root, "d.000.suf/keep"), "utf8")).toBe("keep");
  });

  it("gates an outside tmpdir and creates nothing when denied", async () => {
    const { outside, sb } = await setup();
    await expect(
      runSpec(mktempTool, { tmpdir: outside, template: "t.XXX" }, sb, { deny: true }),
    ).rejects.toThrow("permission denied by test");
    expect(await fs.readdir(outside)).toEqual([]);

    const allowed = await runSpec(mktempTool, { tmpdir: outside, template: "t.XXX" }, sb);
    const created = allowed.result.stdout.toString().trim();
    expect(created).toBe(path.join(outside, "t.000"));
    expect(await pathExists(created)).toBe(true);
    expect(allowed.requests).toContainEqual(
      expect.objectContaining({ action: "external_directory", resources: [`${outside}/*`] }),
    );
  });

  it("gates a tmpdir symlink by its outside target", async () => {
    const { root, outside, sb } = await setup();
    await fs.symlink(outside, path.join(root, "tmplink"), "dir");

    await expect(
      runSpec(mktempTool, { tmpdir: "tmplink", template: "t.XXX" }, sb, { deny: true }),
    ).rejects.toThrow("permission denied by test");
    expect(await fs.readdir(outside)).toEqual([]);

    const allowed = await runSpec(mktempTool, { tmpdir: "tmplink", template: "t.XXX" }, sb);
    expect(allowed.result.stdout.toString().trim()).toBe(path.join(outside, "t.000"));
    expect(allowed.requests).toContainEqual(
      expect.objectContaining({ action: "external_directory", resources: [`${outside}/*`] }),
    );
  });

  it("maps a creation failure to a stable error code", async () => {
    const { root, sb } = await setup();
    await expect(
      runSpec(mktempTool, { tmpdir: root, template: `${"a".repeat(260)}.XXX` }, sb),
    ).rejects.toMatchObject({ code: "io" });
  });
});
