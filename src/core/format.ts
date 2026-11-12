/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import type { ToolResult } from "./types.js";
import { FsError } from "./errors.js";

export interface RenderedResult {
  content: string;
  metadata: Record<string, unknown>;
}

const BINARY_PROBE = 8192;

export function isBinary(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, BINARY_PROBE);
  for (let index = 0; index < length; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export function renderResult(result: ToolResult, maxOutputBytes: number): RenderedResult {
  const exitCode = result.exitCode ?? 0;
  const metadata: Record<string, unknown> = {
    ...result.metadata,
    ok: exitCode === 0,
    exitCode,
  };
  if (result.stderr) metadata.stderr = result.stderr;

  if (result.stdout.length === 0) {
    return { content: "", metadata };
  }

  const slice = result.stdout.subarray(0, maxOutputBytes);
  const truncated = result.stdout.length > maxOutputBytes;
  if (truncated) metadata.truncated = true;
  metadata.bytes = result.stdout.length;

  if (isBinary(slice)) {
    metadata.encoding = "base64";
    return { content: slice.toString("base64"), metadata };
  }

  let content = slice.toString("utf8");
  if (result.stderr) content += `${content.endsWith("\n") ? "" : "\n"}[stderr]\n${result.stderr}`;
  return { content, metadata };
}

export function renderError(error: FsError, blocked: boolean): RenderedResult {
  return {
    content: `${blocked ? "BLOCKED" : "ERROR"}: ${error.message}`,
    metadata: {
      ok: false,
      blocked,
      code: error.code,
      exitCode: 1,
    },
  };
}

export function humanSize(bytes: number): string {
  const units = ["B", "K", "M", "G", "T", "P", "E"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const sign = bytes < 0 ? "-" : "";
  if (unit === 0) return `${sign}${Math.trunc(value)}`;
  return `${sign}${value < 10 ? value.toFixed(1) : Math.trunc(value)}${units[unit]}`;
}

export function parseSize(value: string): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new FsError("size is empty.", "invalid");
  }
  const match = /^([+-]?)(\d+(?:\.\d+)?)([KMGTPE]?)(?:i?B)?$/i.exec(value.trim());
  if (!match) throw new FsError(`Invalid size: ${value}`, "invalid");
  const sign = match[1] === "-" ? -1 : 1;
  const number = Number(match[2]);
  const suffix = (match[3] ?? "").toUpperCase();
  const exponent = suffix === "" ? 0 : "KMGTPE".indexOf(suffix) + 1;
  const multiplier = exponent === 0 ? 1 : 1024 ** exponent;
  return sign * Math.round(number * multiplier);
}

export function splitLines(input: string): string[] {
  if (input.length === 0) return [];
  const lines = input.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function withTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
