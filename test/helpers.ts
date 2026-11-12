/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { PermissionGate, type PermissionAssertInput } from "../src/core/permissions.js";
import { parseSchema } from "../src/core/schema.js";
import { Sandbox } from "../src/core/sandbox.js";
import type { ToolResult, ToolSpec } from "../src/core/types.js";

export interface RunSpecOptions {
  deny?: boolean;
  concurrency?: number;
  signal?: AbortSignal;
  tmpdir?: string;
  maxOutputBytes?: number;
  stdin?: AsyncIterable<Buffer>;
}

export interface RunSpecResult<I> {
  input: I;
  result: ToolResult;
  requests: PermissionAssertInput[];
}

export async function makeRoot(prefix = "fs-plugin-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function makeOutside(): Promise<{ dir: string; file: string }> {
  const dir = await makeRoot("fs-plugin-outside-");
  const file = path.join(dir, "secret.txt");
  await fs.writeFile(file, "secret\n");
  return { dir, file };
}

export async function runSpec<I>(
  spec: ToolSpec<I>,
  rawInput: unknown,
  sandbox: Sandbox,
  options: RunSpecOptions = {},
): Promise<RunSpecResult<I>> {
  const input = parseSchema<I>(spec.schema, rawInput, `${spec.name} input`);
  const requests: PermissionAssertInput[] = [];
  const gate = new PermissionGate(
    { sessionID: "ses_test", agent: "worker", messageID: "msg_test", id: "call_test" },
    `fs_${spec.name}`,
    (full) => sandbox.resource(full),
    async (request) => {
      requests.push(request);
      if (options.deny === true) throw new Error("permission denied by test");
    },
  );
  const result = await spec.run(
    {
      sandbox,
      permission: gate,
      permissionFor: (action) =>
        new PermissionGate(
          { sessionID: "ses_test", agent: "worker", messageID: "msg_test", id: "call_test" },
          action,
          (full) => sandbox.resource(full),
          async (request) => {
            requests.push(request);
            if (options.deny === true) throw new Error("permission denied by test");
          },
        ),
      concurrency: options.concurrency ?? 4,
      signal: options.signal ?? new AbortController().signal,
      tmpdir: options.tmpdir ?? os.tmpdir(),
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
    },
    input,
    options.stdin === undefined ? {} : { stdin: options.stdin },
  );
  return { input, result, requests };
}

export async function runSchema<T>(
  schema: TSchema,
  rawInput: unknown,
  label?: string,
): Promise<T> {
  return parseSchema<T>(schema, rawInput, label);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

export interface FakeEditor {
  namespaceValue?: { name: string; description: string };
  namespace: (namespace: { name: string; description: string }) => void;
  add: (tool: FakeEditor["tools"][number]) => void;
  tools: Array<{
    name: string;
    description: string;
    input: TSchema;
    options?: { namespace?: string; permission?: string };
    execute: (input: unknown, context: FakeToolContext) => Promise<unknown>;
  }>;
}

export interface FakeToolContext {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  signal: AbortSignal;
}

export interface FakePluginContext {
  options: Record<string, unknown>;
  location: { project: { canonical: string }; directory: string };
  tool: {
    transform: (
      callback: (editor: FakeEditor) => void,
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
  permission: { assert: (request: PermissionAssertInput) => Promise<void> };
}

export function makePluginHarness(root: string, options: Record<string, unknown> = {}): {
  context: FakePluginContext;
  editor: FakeEditor;
  permissionRequests: PermissionAssertInput[];
} {
  const permissionRequests: PermissionAssertInput[] = [];
  const editor: FakeEditor = {
    tools: [],
    namespace: (namespace) => {
      editor.namespaceValue = namespace;
    },
    add: (tool) => {
      editor.tools.push(tool);
    },
  };
  const context: FakePluginContext = {
    options,
    location: { project: { canonical: root }, directory: root },
    tool: {
      transform: async (callback) => {
        callback(editor);
        return { dispose: async () => {} };
      },
    },
    permission: {
      assert: async (request) => {
        permissionRequests.push(request);
      },
    },
  };
  return { context, editor, permissionRequests };
}

export async function* bufferStream(data: string | Buffer): AsyncGenerator<Buffer> {
  yield typeof data === "string" ? Buffer.from(data, "utf8") : data;
}

export function makeToolContext(): FakeToolContext {
  return {
    sessionID: "ses_test",
    agent: "worker",
    messageID: "msg_test",
    id: "call_test",
    signal: new AbortController().signal,
  };
}
