/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PermissionGate } from "../../src/core/permissions.js";
import { Sandbox } from "../../src/core/sandbox.js";
import { makeOutside, makeRoot } from "../helpers.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("PermissionGate", () => {
  it("asserts internal paths relative to the project", async () => {
    const root = await makeRoot();
    roots.push(root);
    const sb = await Sandbox.create(root);
    const requests: unknown[] = [];
    const gate = new PermissionGate(
      { sessionID: "s", agent: "a", messageID: "m", id: "i" },
      "fs_cp",
      (full) => sb.resource(full),
      async (request) => {
        requests.push(request);
      },
    );
    const target = await sb.resolveForCreate("dir/file");
    await gate.assert([{ target, boundary: target.full }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      action: "fs_cp",
      resources: ["dir/file"],
      save: ["*"],
    });
  });

  it("asserts external boundaries and repository save roots", async () => {
    const root = await makeRoot();
    roots.push(root);
    const outside = await makeOutside();
    roots.push(outside.dir);
    await fs.mkdir(path.join(outside.dir, ".git"));
    const sb = await Sandbox.create(root);
    const requests: Array<Record<string, unknown>> = [];
    const gate = new PermissionGate(
      { sessionID: "s", agent: "a", messageID: "m", id: "i" },
      "fs_rm",
      (full) => sb.resource(full),
      async (request) => {
        requests.push(request as unknown as Record<string, unknown>);
      },
    );
    const target = await sb.resolveExisting(outside.file);
    await gate.assert([{ target, boundary: outside.dir }]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      action: "external_directory",
      resources: [`${outside.dir}/*`],
      save: [`${outside.dir}/*`],
    });
    expect(requests[1]).toMatchObject({
      action: "fs_rm",
      resources: [outside.file],
    });
  });

  it("deduplicates resources and boundaries", async () => {
    const root = await makeRoot();
    roots.push(root);
    const outside = await makeOutside();
    roots.push(outside.dir);
    const sb = await Sandbox.create(root);
    const requests: unknown[] = [];
    const gate = new PermissionGate(
      { sessionID: "s", agent: "a", messageID: "m", id: "i" },
      "fs_cp",
      (full) => sb.resource(full),
      async (request) => {
        requests.push(request);
      },
    );
    const a = await sb.resolveExisting(outside.file);
    const b = await sb.resolveExisting(outside.file);
    await gate.assert([
      { target: a, boundary: outside.dir },
      { target: b, boundary: outside.dir },
    ]);
    expect(requests).toHaveLength(2);
    expect((requests[1] as { resources: string[] }).resources).toEqual([outside.file]);
  });

  it("asserts a wildcard action for an empty target list", async () => {
    const root = await makeRoot();
    roots.push(root);
    const sb = await Sandbox.create(root);
    const requests: unknown[] = [];
    const gate = new PermissionGate(
      { sessionID: "s", agent: "a", messageID: "m", id: "i" },
      "fs_pipe",
      (full) => sb.resource(full),
      async (request) => {
        requests.push(request);
      },
    );
    await gate.assert([]);
    expect(requests[0]).toMatchObject({ action: "fs_pipe", resources: ["*"] });
  });

  it("asserts trusted tool paths without an external gate", async () => {
    const root = await makeRoot();
    roots.push(root);
    const sb = await Sandbox.create(root);
    const requests: unknown[] = [];
    const gate = new PermissionGate(
      { sessionID: "s", agent: "a", messageID: "m", id: "i" },
      "fs_mktemp",
      (full) => sb.resource(full),
      async (request) => {
        requests.push(request);
      },
    );
    await gate.assertTrusted(["/tmp/opencode/*"]);
    expect(requests[0]).toMatchObject({ action: "fs_mktemp", resources: ["/tmp/opencode/*"] });
    await gate.assertTrusted([]);
    expect(requests[1]).toMatchObject({ resources: ["*"] });
  });
});
