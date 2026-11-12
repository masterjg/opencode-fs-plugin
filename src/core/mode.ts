/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { FsError } from "./errors.js";

const WHO = {
  u: 0o700,
  g: 0o070,
  o: 0o007,
  a: 0o777,
} as const;

const PERM = {
  r: 0o444,
  w: 0o222,
  x: 0o111,
  X: 0o111,
} as const;

export function parseMode(
  mode: string,
  base: number,
  isDirectory: boolean,
  umask = 0o022,
): number {
  if (typeof mode !== "string" || mode.length === 0) {
    throw new FsError("mode is empty.", "invalid");
  }
  if (/^[0-7]{3,4}$/.test(mode)) {
    return Number.parseInt(mode, 8);
  }

  let result = base & 0o7777;
  for (const clause of mode.split(",")) {
    const match = /^([ugoa]*)([+\-=])(.*)$/.exec(clause);
    if (match === null) throw new FsError(`Invalid mode: ${mode}`, "invalid");
    const who = match[1] as string;
    const op = match[2] as string;
    const permissions = match[3] as string;
    if (permissions.length === 0 && op !== "=") continue;
    const whoMask =
      who.length > 0
        ? [...who].reduce((mask, ch) => mask | WHO[ch as keyof typeof WHO], 0)
        : ~umask & 0o777;
    let bits = 0;
    for (const ch of permissions) {
      if (ch === "X") {
        if (isDirectory || (result & 0o111) !== 0) bits |= PERM.X & whoMask;
      } else if (ch === "s") {
        bits |= ((who === "" || who.includes("u")) ? 0o4000 : 0) | ((who === "" || who.includes("g")) ? 0o2000 : 0);
      } else if (ch === "t") {
        bits |= who === "" || who.includes("o") || who.includes("a") ? 0o1000 : 0;
      } else if (ch in PERM) {
        bits |= PERM[ch as keyof typeof PERM] & whoMask;
      } else {
        throw new FsError(`Invalid mode: ${mode}`, "invalid");
      }
    }
    if (op === "+") result |= bits;
    if (op === "-") result &= ~bits;
    if (op === "=") result = (result & ~whoMask & 0o7777) | bits;
  }
  return result & 0o7777;
}

export function formatMode(mode: number): string {
  return `${fileType(mode)}${triplet(mode, 6, 0o4000, "s")}${triplet(mode, 3, 0o2000, "s")}${triplet(
    mode,
    0,
    0o1000,
    "t",
  )}`;
}

export function formatOctalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

function triplet(mode: number, shift: number, special: number, specialChar: string): string {
  const bits = (mode >> shift) & 0o7;
  const execute = bits & 0o1;
  const specialSet = (mode & special) !== 0;
  return `${bits & 0o4 ? "r" : "-"}${bits & 0o2 ? "w" : "-"}${
    specialSet ? (execute ? specialChar : specialChar.toUpperCase()) : execute ? "x" : "-"
  }`;
}

function fileType(mode: number): string {
  switch (mode & 0o170000) {
    case 0o040000:
      return "d";
    case 0o120000:
      return "l";
    case 0o010000:
      return "p";
    case 0o140000:
      return "s";
    case 0o060000:
      return "b";
    case 0o020000:
      return "c";
    default:
      return "-";
  }
}
