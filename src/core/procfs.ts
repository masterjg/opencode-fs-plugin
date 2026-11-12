/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import { mapLimit } from "./parallel.js";

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly comm: string;
  readonly state: string;
  readonly uid: number;
  readonly rssBytes: number;
  readonly startTime: number;
  readonly threads: number;
  readonly command: string;
}

/** Read `/proc` with bounded parallelism; vanished processes are skipped. */
export async function listProcesses(concurrency: number, signal?: AbortSignal): Promise<ProcessInfo[]> {
  const entries = await fs.readdir("/proc");
  const pids = entries.filter((name) => /^\d+$/.test(name)).map(Number);
  const rows = await mapLimit(
    pids,
    Math.max(1, concurrency),
    (pid) => readProcess(pid),
    signal,
  );
  return rows.filter((row): row is ProcessInfo => row !== undefined);
}

export async function readProcess(pid: number): Promise<ProcessInfo | undefined> {
  const base = `/proc/${pid}`;
  const [statText, cmdline, stats] = await Promise.all([
    fs.readFile(`${base}/stat`, "utf8").catch(() => undefined),
    fs.readFile(`${base}/cmdline`).catch(() => undefined),
    fs.stat(base).catch(() => undefined),
  ]);
  if (statText === undefined || stats === undefined) return undefined;
  return parseStat(pid, statText, cmdline, stats.uid);
}

export function parseStat(
  pid: number,
  text: string,
  cmdline: Buffer | undefined,
  uid: number,
): ProcessInfo | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const comm = text.slice(open + 1, close);
  const tail = text.slice(close + 2).trim().split(/\s+/);
  if (tail.length < 22) return undefined;
  const command = cmdline === undefined
    ? comm
    : cmdline.toString("utf8").split("\0").filter(Boolean).join(" ") || comm;
  return {
    pid,
    ppid: Number(tail[1]),
    comm,
    state: tail[0] as string,
    uid,
    rssBytes: Number(tail[21]) * 4096,
    startTime: Number(tail[19]),
    threads: Number(tail[17]),
    command,
  };
}

export const SIGNALS: Readonly<Record<string, NodeJS.Signals>> = {
  HUP: "SIGHUP",
  INT: "SIGINT",
  QUIT: "SIGQUIT",
  KILL: "SIGKILL",
  TERM: "SIGTERM",
  USR1: "SIGUSR1",
  USR2: "SIGUSR2",
  STOP: "SIGSTOP",
  CONT: "SIGCONT",
  CHLD: "SIGCHLD",
};
