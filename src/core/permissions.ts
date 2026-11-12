/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ResolvedTarget } from "./sandbox.js";

export interface PermissionContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
}

export interface PermissionAssertInput {
  sessionID: string;
  agent: string;
  source: { type: "tool"; messageID: string; id: string };
  action: string;
  resources: string[];
  save: string[];
}

export type PermissionAssert = (input: PermissionAssertInput) => Promise<void>;

export interface PermissionEntry {
  readonly target: ResolvedTarget;
  /** Absolute boundary directory for external_directory. */
  readonly boundary: string;
  /** Optional resource override; defaults to the sandbox-relative path. */
  readonly resource?: string;
}

/**
 * Asserts an action for one or more resolved targets. Internal targets use the
 * project-relative resource; external targets first require external_directory
 * on the absolute boundary, then the action on the absolute path.
 */
export class PermissionGate {
  constructor(
    private readonly context: PermissionContext,
    private readonly action: string,
    private readonly sandboxResource: (full: string) => string,
    private readonly assertPermission: PermissionAssert,
  ) {}

  /** Assert an action on trusted tool-owned paths without an external gate. */
  async assertTrusted(resources: readonly string[]): Promise<void> {
    await this.assertAction(resources.length === 0 ? ["*"] : [...resources], ["*"]);
  }

  async assert(entries: readonly PermissionEntry[]): Promise<void> {
    if (entries.length === 0) {
      await this.assertAction(["*"], ["*"]);
      return;
    }

    const external = entries.filter((entry) => entry.target.outside);
    const boundaries = new Map<string, string[]>();
    for (const entry of external) {
      const dir = path.resolve(entry.boundary);
      const saves = boundaries.get(dir) ?? [];
      const repoRoot = await this.projectRootOf(dir);
      if (!saves.includes(repoRoot)) saves.push(repoRoot);
      boundaries.set(dir, saves);
    }

    for (const [dir, repoRoots] of boundaries) {
      await this.assertPermission({
        ...this.base(),
        action: "external_directory",
        resources: [`${slash(dir)}/*`],
        save: repoRoots.map((root) => `${slash(root)}/*`),
      });
    }

    const resources = unique(
      entries.map((entry) =>
        entry.target.outside
          ? slash(entry.target.full)
          : (entry.resource ?? this.sandboxResource(entry.target.full)),
      ),
    );
    await this.assertAction(resources, ["*"]);
  }

  private async assertAction(resources: string[], save: string[]): Promise<void> {
    await this.assertPermission({
      ...this.base(),
      action: this.action,
      resources,
      save,
    });
  }

  private base() {
    return {
      sessionID: this.context.sessionID,
      agent: this.context.agent,
      source: {
        type: "tool" as const,
        messageID: this.context.messageID,
        id: this.context.id,
      },
    };
  }

  private async projectRootOf(dir: string): Promise<string> {
    let current = dir;
    for (;;) {
      for (const marker of [".git", ".hg"]) {
        try {
          await fs.lstat(path.join(current, marker));
          return current;
        } catch {
          // keep walking up
        }
      }
      const parent = path.dirname(current);
      if (parent === current) return dir;
      current = parent;
    }
  }
}

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
