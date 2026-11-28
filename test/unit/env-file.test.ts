/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_ENV_FILE_BYTES,
  loadEnvFile,
  loadEnvFiles,
  parseEnvFile,
  readEnvFileBytes,
  type EnvFileReader,
  type EnvFileSource,
} from "../../src/core/env-file.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-env-file-"));
  roots.push(dir);
  return dir;
}

function source(file: string, index: number): EnvFileSource {
  return { path: file, index };
}

/** A reader that yields at most `chunkSize` bytes per call. */
function fakeReader(data: Buffer, chunkSize = data.length): EnvFileReader {
  return {
    async read(buffer, offset, length, position) {
      const end = Math.min(position + Math.min(length, chunkSize), data.length);
      const chunk = data.subarray(position, end);
      chunk.copy(buffer, offset);
      return { bytesRead: chunk.length };
    },
  };
}

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the action to throw");
}

describe("env file parser", () => {
  it("accepts an empty file, blank lines, and comments", () => {
    expect(parseEnvFile("", "test.env")).toEqual({});
    expect(parseEnvFile("\n   \n\t\n# comment\n   # indented\n", "test.env")).toEqual({});
  });

  it("accepts LF and CRLF line endings", () => {
    expect(parseEnvFile("A=one\r\nB=two\r\nC=three\n", "test.env")).toEqual({
      A: "one",
      B: "two",
      C: "three",
    });
  });

  it("accepts an export prefix as plain text", () => {
    expect(parseEnvFile("export A=one\nexport   B=two\nexported=three\n", "test.env")).toEqual({
      A: "one",
      B: "two",
      exported: "three",
    });
  });

  it("rejects export without a key and value", () => {
    expect(messageOf(() => parseEnvFile("export", "test.env"))).toMatch(
      /test\.env: line 1: expected KEY=VALUE after export\./,
    );
    expect(messageOf(() => parseEnvFile("export # comment", "test.env"))).toMatch(
      /expected KEY=VALUE after export/,
    );
  });

  it("trims whitespace around the key and unquoted value", () => {
    expect(parseEnvFile("  A  =   one  \nB\t=\ttwo\t\n", "test.env")).toEqual({
      A: "one",
      B: "two",
    });
  });

  it("accepts empty values in every form", () => {
    expect(parseEnvFile("A=\nB=''\nC=\"\"\nD= # comment\n", "test.env")).toEqual({
      A: "",
      B: "",
      C: "",
      D: "",
    });
  });

  it("keeps a literal hash without preceding whitespace and cuts a comment after it", () => {
    expect(
      parseEnvFile("A=one # comment\nB=two#literal\nC=#comment\nD= x y \n", "test.env"),
    ).toEqual({
      A: "one",
      B: "two#literal",
      C: "",
      D: "x y",
    });
  });

  it("treats single-quoted values literally and allows a trailing comment", () => {
    expect(parseEnvFile("A='one # two $HOME \\n'\nB='x' # comment\n", "test.env")).toEqual({
      A: "one # two $HOME \\n",
      B: "x",
    });
  });

  it("decodes only the documented double-quote escapes and expands nothing", () => {
    const text = String.raw`A="line\nnext\t\rcr\"q\"\\$HOME # literal"` + "\n";
    expect(parseEnvFile(text, "test.env")).toEqual({
      A: 'line\nnext\t\rcr"q"\\$HOME # literal',
    });
  });

  it("keeps equals signs inside a value", () => {
    expect(parseEnvFile("A=a=b=c\n", "test.env")).toEqual({ A: "a=b=c" });
  });

  it("lets a later duplicate key win", () => {
    expect(parseEnvFile("A=first\nA=second\n", "test.env")).toEqual({ A: "second" });
  });

  it("rejects a line without equals", () => {
    expect(messageOf(() => parseEnvFile("A=one\nBROKEN\n", "test.env"))).toMatch(
      /test\.env: line 2: expected KEY=VALUE\./,
    );
  });

  it("rejects invalid names without echoing the line", () => {
    for (const line of ["=x", "1BAD=x", "BAD-NAME=x", "A.B=x", "BAD NAME=x"]) {
      const message = messageOf(() => parseEnvFile(line, "test.env"));
      expect(message).toMatch(/line 1: invalid environment variable name\./);
      expect(message).not.toContain("BAD");
      expect(message).not.toContain("1BAD");
    }
  });

  it("rejects unterminated and malformed quoted values", () => {
    expect(messageOf(() => parseEnvFile("A='x", "test.env"))).toMatch(
      /unterminated single-quoted value/,
    );
    expect(messageOf(() => parseEnvFile('A="x', "test.env"))).toMatch(
      /unterminated double-quoted value/,
    );
    expect(messageOf(() => parseEnvFile("A='x' y", "test.env"))).toMatch(
      /unexpected characters after a quoted value/,
    );
    expect(messageOf(() => parseEnvFile('A="x" y', "test.env"))).toMatch(
      /unexpected characters after a quoted value/,
    );
  });

  it("rejects unsupported escapes without echoing them", () => {
    const secret = "q7secret";
    const message = messageOf(() => parseEnvFile(`A="\\${secret}"`, "test.env"));
    expect(message).toMatch(/unsupported escape sequence/);
    expect(message).not.toContain(secret);
    expect(messageOf(() => parseEnvFile('A="x\\', "test.env"))).toMatch(
      /unsupported escape sequence/,
    );
  });

  it("rejects NUL bytes without echoing the value", () => {
    const secret = "s3cret";
    const message = messageOf(() => parseEnvFile(`A=${secret}\0rest`, "test.env"));
    expect(message).toMatch(/line 1: A must not contain NUL bytes\./);
    expect(message).not.toContain(secret);
  });

  it("refuses PATH and TMPDIR through the shared environment validator", () => {
    expect(messageOf(() => parseEnvFile("PATH=/tmp/bin\n", "test.env"))).toMatch(
      /cannot set PATH/,
    );
    expect(messageOf(() => parseEnvFile("TMPDIR=/tmp\n", "test.env"))).toMatch(
      /cannot set TMPDIR/,
    );
  });
});

describe("bounded env file read", () => {
  it("accepts exactly the cap, reads in chunks, and stops at EOF", async () => {
    const data = Buffer.alloc(MAX_ENV_FILE_BYTES, 0x41);
    const bytes = await readEnvFileBytes(fakeReader(data, 8192), MAX_ENV_FILE_BYTES, "label");
    expect(bytes.length).toBe(MAX_ENV_FILE_BYTES);
    const empty = await readEnvFileBytes(fakeReader(Buffer.alloc(0)), MAX_ENV_FILE_BYTES, "label");
    expect(empty.length).toBe(0);
  });

  it("rejects a reader that yields one byte over the cap", async () => {
    const data = Buffer.alloc(MAX_ENV_FILE_BYTES + 1, 0x41);
    await expect(
      readEnvFileBytes(fakeReader(data, 8192), MAX_ENV_FILE_BYTES, "label"),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      readEnvFileBytes(fakeReader(data, 8192), MAX_ENV_FILE_BYTES, "label"),
    ).rejects.toThrow(`exceeds ${MAX_ENV_FILE_BYTES} bytes`);
  });
});

describe("env file loading", () => {
  it("reads a regular file and strips a BOM", async () => {
    const dir = await makeDir();
    const file = path.join(dir, ".env");
    await fs.writeFile(file, "\uFEFFA=one\r\nB=two\r\n");
    expect(await loadEnvFile(file, "label")).toEqual({ A: "one", B: "two" });
  });

  it("follows a configuration symlink at its real target", async () => {
    const dir = await makeDir();
    const target = path.join(dir, "real.env");
    const link = path.join(dir, ".env");
    await fs.writeFile(target, "A=linked\n");
    await fs.symlink(target, link);
    expect(await loadEnvFile(link, "label")).toEqual({ A: "linked" });
  });

  it("reports a missing file and a dangling symlink as not found", async () => {
    const dir = await makeDir();
    const missing = path.join(dir, "missing.env");
    await expect(loadEnvFile(missing, "label")).rejects.toMatchObject({ code: "not-found" });
    const dangling = path.join(dir, "dangling.env");
    await fs.symlink(path.join(dir, "absent.env"), dangling);
    await expect(loadEnvFile(dangling, "label")).rejects.toMatchObject({ code: "not-found" });
  });

  it("reports a symlink loop as an access failure", async () => {
    const dir = await makeDir();
    const first = path.join(dir, "a.env");
    const second = path.join(dir, "b.env");
    await fs.symlink(second, first);
    await fs.symlink(first, second);
    await expect(loadEnvFile(first, "label")).rejects.toMatchObject({ code: "access" });
  });

  it("refuses directories and devices instead of hanging", async () => {
    const dir = await makeDir();
    await expect(loadEnvFile(dir, "label")).rejects.toMatchObject({ code: "not-file" });
    await expect(loadEnvFile("/dev/null", "label")).rejects.toMatchObject({ code: "not-file" });
  });

  it("refuses a socket file without hanging", async () => {
    const dir = await makeDir();
    const socketPath = path.join(dir, "env.sock");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(loadEnvFile(socketPath, "label")).rejects.toMatchObject({ code: "access" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports an unreadable file as an access failure", async () => {
    if (process.getuid?.() === 0) return;
    const dir = await makeDir();
    const file = path.join(dir, ".env");
    await fs.writeFile(file, "A=one\n", { mode: 0o000 });
    await expect(loadEnvFile(file, "label")).rejects.toMatchObject({ code: "access" });
  });

  it("accepts a file exactly at the cap and rejects one byte over", async () => {
    const dir = await makeDir();
    const exact = path.join(dir, "exact.env");
    await fs.writeFile(exact, `A=${"x".repeat(MAX_ENV_FILE_BYTES - 2)}`);
    const entries = await loadEnvFile(exact, "label");
    expect(entries.A).toHaveLength(MAX_ENV_FILE_BYTES - 2);

    const over = path.join(dir, "over.env");
    await fs.writeFile(over, `A=${"x".repeat(MAX_ENV_FILE_BYTES - 1)}`);
    let message = "";
    try {
      await loadEnvFile(over, "label");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`exceeds ${MAX_ENV_FILE_BYTES} bytes`);
  });

  it("rejects invalid UTF-8", async () => {
    const dir = await makeDir();
    const binary = path.join(dir, "binary.env");
    await fs.writeFile(binary, Buffer.from([0x41, 0x3d, 0xff, 0xfe, 0x0a]));
    await expect(loadEnvFile(binary, "label")).rejects.toMatchObject({ code: "invalid" });
  });

  it("keeps the label and line in a parse error", async () => {
    const dir = await makeDir();
    const file = path.join(dir, ".env");
    await fs.writeFile(file, "A=one\nBROKEN\n");
    await expect(loadEnvFile(file, "custom-label")).rejects.toThrow(
      /custom-label: line 2: expected KEY=VALUE/,
    );
  });
});

describe("env file merge", () => {
  it("returns no entries for no files", async () => {
    expect(await loadEnvFiles([], 4)).toEqual({});
  });

  it("merges files in configured order with later files winning", async () => {
    const dir = await makeDir();
    const first = path.join(dir, "first.env");
    const second = path.join(dir, "second.env");
    await fs.writeFile(first, "A=one\nB=first\nKEEP=yes\n");
    await fs.writeFile(second, "B=second\nC=three\n");
    expect(await loadEnvFiles([source(first, 0), source(second, 1)], 2)).toEqual({
      A: "one",
      B: "second",
      C: "three",
      KEEP: "yes",
    });
  });

  it("reports the first configured file's error", async () => {
    const dir = await makeDir();
    const missingFirst = path.join(dir, "first.env");
    const missingSecond = path.join(dir, "second.env");
    let message = "";
    try {
      await loadEnvFiles([source(missingFirst, 0), source(missingSecond, 1)], 2);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('commandEnvFiles[0] ("');
    expect(message).toContain("first.env");
    expect(message).not.toContain("second.env");
  });

  it("keeps an original configured index in the error label", async () => {
    const dir = await makeDir();
    const missing = path.join(dir, "missing.env");
    await expect(
      loadEnvFiles([source(missing, 2)], 2),
    ).rejects.toThrow(/^commandEnvFiles\[2\] \(/);
  });

  it("stops on an already aborted signal", async () => {
    const dir = await makeDir();
    const file = path.join(dir, ".env");
    await fs.writeFile(file, "A=one\n");
    const controller = new AbortController();
    controller.abort();
    await expect(loadEnvFiles([source(file, 0)], 4, controller.signal)).rejects.toMatchObject({
      code: "interrupted",
    });
  });
});
