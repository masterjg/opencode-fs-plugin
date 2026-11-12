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
  s: 0o6000,
  t: 0o1000,
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
    const parsed = Number.parseInt(mode, 8);
    if (parsed > 0o7777) throw new FsError(`Invalid mode: ${mode}`, "invalid");
    return parsed;
  }

  let result = base & 0o7777;
  for (const clause of mode.split(",")) {
    if (clause.length === 0) throw new FsError(`Invalid mode: ${mode}`, "invalid");
    let who = "";
    let index = 0;
    while (index < clause.length && "ugoa".includes(clause[index] ?? "")) {
      who += clause[index];
      index++;
    }
    const op = clause[index];
    if (op !== "+" && op !== "-" && op !== "=") {
      throw new FsError(`Invalid mode: ${mode}`, "invalid");
    }
    index++;
    const whoMask =
      who.length > 0
        ? [...who].reduce((mask, ch) => mask | WHO[ch as keyof typeof WHO], 0)
        : ~umask & 0o777;
    let bits = 0;
    while (index < clause.length) {
      const ch = clause[index] as keyof typeof PERM;
      if (!(ch in PERM)) throw new FsError(`Invalid mode: ${mode}`, "invalid");
      if (ch === "X") {
        if (isDirectory || (result & 0o111) !== 0) bits |= PERM.X & whoMask;
      } else if (ch === "s") {
        if (who.length === 0) bits |= 0o6000;
        else if (who.includes("u")) bits |= 0o4000;
        else if (who.includes("g")) bits |= 0o2000;
      } else if (ch === "t") {
        if (who.length === 0 || who.includes("o") || who.includes("a")) bits |= 0o1000;
      } else {
        bits |= PERM[ch] & whoMask;
      }
      index++;
    }
    if (op === "+") result |= bits;
    if (op === "-") result &= ~bits;
    if (op === "=") result = (result & ~whoMask & 0o7777) | bits;
  }
  return result & 0o7777;
}

export function formatMode(mode: number): string {
  const type = fileType(mode);
  return `${type}${triplet(mode, 6, 0o4000, "s")}${triplet(mode, 3, 0o2000, "s")}${triplet(
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
