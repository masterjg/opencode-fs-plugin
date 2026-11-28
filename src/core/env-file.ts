/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { ENV_NAME, resolveCommandEnvVars } from "./env.js";
import { FsError, errorMessage, fromErrno, isMissing } from "./errors.js";
import { mapLimit } from "./parallel.js";

/** Largest configured env file the plugin reads, in bytes. */
export const MAX_ENV_FILE_BYTES = 1024 * 1024;

/** Escape sequences accepted inside a double-quoted value. */
const DOUBLE_QUOTE_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "\\": "\\",
  '"': '"',
};

/** A configured env file with the original index in the `commandEnvFiles` array. */
export interface EnvFileSource {
  /** Absolute resolved path. */
  readonly path: string;
  /** Zero-based position in the configured array, retained across deduplication. */
  readonly index: number;
}

/** The subset of `FileHandle` needed for a bounded read. */
export interface EnvFileReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

/**
 * Read at most `maxBytes + 1` bytes, so a file that grows after `fstat`, or a
 * pseudo-file that reports a zero size, cannot make the read unbounded. One
 * extra byte distinguishes "exactly at the cap" from "over it".
 */
export async function readEnvFileBytes(
  handle: EnvFileReader,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new FsError(`${label}: env file exceeds ${maxBytes} bytes.`, "invalid");
  }
  return buffer.subarray(0, total);
}

function invalidLine(label: string, line: number, detail: string): FsError {
  return new FsError(`${label}: line ${line}: ${detail}`, "invalid");
}

/** A quoted value may be followed only by whitespace and an optional comment. */
function assertTrailing(label: string, line: number, tail: string): void {
  const rest = tail.trimStart();
  if (rest.length > 0 && !rest.startsWith("#")) {
    throw invalidLine(label, line, "unexpected characters after a quoted value.");
  }
}

function parseSingleQuoted(label: string, line: number, raw: string): string {
  const close = raw.indexOf("'", 1);
  if (close < 0) throw invalidLine(label, line, "unterminated single-quoted value.");
  assertTrailing(label, line, raw.slice(close + 1));
  return raw.slice(1, close);
}

function parseDoubleQuoted(label: string, line: number, raw: string): string {
  let value = "";
  for (let index = 1; index < raw.length; index++) {
    const char = raw[index] as string;
    if (char === '"') {
      assertTrailing(label, line, raw.slice(index + 1));
      return value;
    }
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escape = raw[index + 1];
    const mapped = escape === undefined ? undefined : DOUBLE_QUOTE_ESCAPES[escape];
    // The escape itself is never echoed: it may be part of a secret value.
    if (mapped === undefined) {
      throw invalidLine(label, line, "unsupported escape sequence in a double-quoted value.");
    }
    value += mapped;
    index++;
  }
  throw invalidLine(label, line, "unterminated double-quoted value.");
}

/**
 * An unquoted value ends at `#` when the `#` starts the value or follows
 * whitespace; otherwise `#` is literal. Surrounding whitespace is trimmed.
 */
function parseUnquoted(raw: string): string {
  let end = raw.length;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== "#") continue;
    if (index === 0 || /\s/.test(raw[index - 1] as string)) {
      end = index;
      break;
    }
  }
  return raw.slice(0, end).trimEnd();
}

function parseValue(label: string, line: number, raw: string): string {
  if (raw.startsWith("'")) return parseSingleQuoted(label, line, raw);
  if (raw.startsWith('"')) return parseDoubleQuoted(label, line, raw);
  return parseUnquoted(raw);
}

/**
 * Parse one `.env` line. Returns `undefined` for a blank or comment line.
 * Malformed input fails with a line number but never echoes the line, the
 * key when invalid, or the value: a configured file may hold credentials.
 */
function parseLine(label: string, line: number, text: string): [string, string] | undefined {
  const trimmed = text.trimStart();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  let body = trimmed;
  // Accept the common `export KEY=VALUE` form; it is still plain text, not a
  // shell command.
  if (body.startsWith("export") && (body.length === 6 || /\s/.test(body[6] as string))) {
    body = body.slice(6).trimStart();
    if (body.length === 0 || body.startsWith("#")) {
      throw invalidLine(label, line, "expected KEY=VALUE after export.");
    }
  }
  const equals = body.indexOf("=");
  if (equals < 0) throw invalidLine(label, line, "expected KEY=VALUE.");
  const name = body.slice(0, equals).trim();
  if (!ENV_NAME.test(name)) {
    throw invalidLine(label, line, "invalid environment variable name.");
  }
  const value = parseValue(label, line, body.slice(equals + 1).trimStart());
  if (value.includes("\0")) {
    throw invalidLine(label, line, `${name} must not contain NUL bytes.`);
  }
  return [name, value];
}

/**
 * Parse `.env` text into environment entries. This is a data format, never a
 * shell: there is no sourcing, command substitution, or variable expansion.
 * Later duplicate keys win within one file. The shared environment validator
 * applies the same name/value rules as `commandEnvVars`, including refusing
 * `PATH` and `TMPDIR`.
 */
export function parseEnvFile(text: string, label: string): Record<string, string> {
  const entries = new Map<string, string>();
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const parsed = parseLine(label, index + 1, line);
    if (parsed !== undefined) entries.set(parsed[0], parsed[1]);
  }
  return resolveCommandEnvVars(Object.fromEntries(entries), label);
}

/**
 * Read one configured env file. The configured path is resolved first so a
 * configuration symlink is trusted at its real target, then the final
 * component is opened no-follow and non-blocking. A link swapped in after
 * resolution fails instead of being followed; a directory, FIFO, device, or
 * socket is refused without blocking. A parent directory swapped after
 * resolution remains a TOCTOU gap on the same order as the rest of the
 * sandbox. The plugin reads this file itself, outside the child sandbox, and
 * adds no read rule for it to the procage policy. This host-side read is not
 * bounded by the command timeout and is not cancelled by an abort.
 */
export async function loadEnvFile(file: string, label: string): Promise<Record<string, string>> {
  let real: string;
  try {
    real = await fs.realpath(file);
  } catch (error) {
    if (isMissing(error)) {
      throw new FsError(`${label}: env file not found.`, "not-found");
    }
    throw new FsError(`${label}: cannot resolve env file: ${errorMessage(error)}`, "access");
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(
      real,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    // The path resolved a moment ago, so this is a concurrent unlink/rename;
    // it cannot be produced deterministically.
    /* v8 ignore next 3 */
    if (isMissing(error)) {
      throw new FsError(`${label}: env file disappeared while opening.`, "not-found");
    }
    throw new FsError(`${label}: cannot open env file: ${errorMessage(error)}`, "access");
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new FsError(`${label}: env file is not a regular file.`, "not-file");
    }
    if (stats.size > MAX_ENV_FILE_BYTES) {
      throw new FsError(
        `${label}: env file exceeds ${MAX_ENV_FILE_BYTES} bytes.`,
        "invalid",
      );
    }
    const data = await readEnvFileBytes(handle, MAX_ENV_FILE_BYTES, label);
    let text: string;
    try {
      // Fatal decoding rejects arbitrary binary instead of silently replacing
      // bytes, and the decoder drops a leading UTF-8 BOM.
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new FsError(`${label}: env file is not valid UTF-8.`, "invalid");
    }
    return parseEnvFile(text, label);
  } finally {
    await handle.close();
  }
}

type EnvFileResult =
  | { readonly ok: true; readonly entries: Record<string, string> }
  | { readonly ok: false; readonly error: FsError };

/**
 * Read configured env files in bounded parallel and merge them in configured
 * order: a later file overrides an earlier one. Results keep configured order,
 * so the first configured file's error is the one reported even when another
 * file failed first, and each label keeps the original option index. An abort
 * stops scheduling new reads.
 */
export async function loadEnvFiles(
  files: readonly EnvFileSource[],
  concurrency: number,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const results = await mapLimit(
    files,
    concurrency,
    async (source): Promise<EnvFileResult> => {
      const label = `commandEnvFiles[${source.index}] ("${source.path}")`;
      try {
        return { ok: true, entries: await loadEnvFile(source.path, label) };
      } catch (error) {
        /* v8 ignore next */
        return {
          ok: false,
          error: error instanceof FsError ? error : fromErrno(error, "access"),
        };
      }
    },
    signal,
  );

  const merged = new Map<string, string>();
  for (const result of results) {
    if (!result.ok) throw result.error;
    for (const [name, value] of Object.entries(result.entries)) merged.set(name, value);
  }
  return Object.fromEntries(merged);
}
