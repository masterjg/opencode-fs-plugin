/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { RenderedResult } from "../../src/core/format.js";
import { JobManager, type JobStatus } from "../../src/core/jobs.js";
import { PermissionGate, type PermissionAssertInput } from "../../src/core/permissions.js";
import {
  RELAY_HELLO,
  RelayProtocolError,
  decodeDecisionRequest,
  encodeDecisionRequest,
  encodeFrame,
} from "../../src/core/relay-protocol.js";
import { RelayControlServer } from "../../src/core/relay-control.js";
import { Sandbox } from "../../src/core/sandbox.js";
import { parseSchema } from "../../src/core/schema.js";
import { commandTool } from "../../src/tools/command.js";
import { curlTool, headersForRedirect, writeChunkFully } from "../../src/tools/curl.js";
import plugin from "../../src/index.js";
import {
  makeOutside,
  makePluginHarness,
  makeRoot,
  makeToolContext,
  pathExists,
  runSpec,
} from "../helpers.js";

const roots: string[] = [];
const servers: Server[] = [];
const managers: JobManager[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const manager of managers.splice(0)) manager.dispose();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ root: string; sb: Sandbox }> {
  const root = await makeRoot("fs-security-");
  roots.push(root);
  return { root, sb: await Sandbox.create(root) };
}

interface HttpFixture {
  readonly url: string;
}

async function listen(
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
): Promise<HttpFixture> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no HTTP fixture address");
  return { url: `http://127.0.0.1:${address.port}` };
}

describe("command cwd symlink boundary", () => {
  it("asserts the canonical external directory and runs there", async () => {
    const { root, sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const realOutside = await fs.realpath(outside.dir);
    await fs.symlink(realOutside, path.join(root, "outside-link"), "dir");

    const result = await runSpec(
      commandTool,
      {
        command: "node",
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd: "outside-link",
      },
      sb,
      { allowCommands: ["node"] },
    );
    const body = JSON.parse(result.result.stdout.toString()) as { stdout: string };
    expect(body.stdout).toBe(realOutside);
    expect(result.requests).toContainEqual(
      expect.objectContaining({
        action: "external_directory",
        resources: [`${realOutside}/*`],
      }),
    );
  });

  it("denies the external boundary before spawning", async () => {
    const { root, sb } = await setup();
    const outside = await makeOutside();
    roots.push(outside.dir);
    const realOutside = await fs.realpath(outside.dir);
    await fs.symlink(realOutside, path.join(root, "outside-link"), "dir");
    const marker = path.join(realOutside, "spawned.txt");
    const requests: PermissionAssertInput[] = [];
    const context = { sessionID: "ses_test", agent: "worker", messageID: "msg_test", id: "call_test" };
    const assert = async (request: PermissionAssertInput) => {
      requests.push(request);
      if (request.action === "external_directory") throw new Error("external denied by test");
    };
    const gate = new PermissionGate(context, "fs_command", (full) => sb.resource(full), assert);
    const parsed = parseSchema<Parameters<typeof commandTool.run>[1]>(
      commandTool.schema,
      {
        command: "node",
        args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
        cwd: "outside-link",
      },
      "command input",
    );

    await expect(
      commandTool.run(
        {
          sandbox: sb,
          permission: gate,
          permissionFor: (action) =>
            new PermissionGate(context, action, (full) => sb.resource(full), assert),
          concurrency: 4,
          signal: new AbortController().signal,
          tmpdir: os.tmpdir(),
        },
        parsed,
        {},
      ),
    ).rejects.toThrow("external denied by test");

    expect(requests.map((request) => request.action)).toEqual(["fs_command", "external_directory"]);
    expect(requests[1]?.resources).toEqual([`${realOutside}/*`]);
    expect(await pathExists(marker)).toBe(false);
  });
});

describe("curl redirect security", () => {
  it("keeps caller headers on same-origin redirects", () => {
    const headers = {
      Authorization: "Bearer secret",
      Cookie: "a=1",
      "Proxy-Authorization": "Basic x",
      "X-Test": "keep",
    };
    const same = headersForRedirect(
      headers,
      new URL("https://a.test/one"),
      new URL("https://a.test/two"),
      "GET",
      false,
    );
    expect(same).toBe(headers);
  });

  it("rejects cross-origin redirects with credentials, unsafe methods or a body", () => {
    const from = new URL("https://a.test/one");
    const to = new URL("https://b.test/two");
    expect(() => headersForRedirect({ Authorization: "Bearer secret" }, from, to, "GET", false))
      .toThrow(/cross-origin/);
    expect(() => headersForRedirect({ "X-Api-Key": "secret" }, from, to, "GET", false))
      .toThrow(/cross-origin/);
    expect(() => headersForRedirect({}, from, to, "POST", false)).toThrow(/cross-origin/);
    expect(() => headersForRedirect({}, from, to, "GET", true)).toThrow(/cross-origin/);
    expect(() => headersForRedirect({}, from, new URL("https://user@b.test/two"), "GET", false))
      .toThrow(/embedded credentials/);
    expect(() => headersForRedirect({}, from, new URL("https://:pass@b.test/two"), "GET", false))
      .toThrow(/embedded credentials/);
    expect(headersForRedirect({ Accept: "text/plain" }, from, to, "GET", false)).toEqual({
      Accept: "text/plain",
    });
  });

  it("rejects an HTTPS to HTTP downgrade", () => {
    expect(() =>
      headersForRedirect({}, new URL("https://a.test/"), new URL("http://a.test/"), "GET", false),
    ).toThrow(/HTTPS to HTTP/);
  });

  it("writes partial chunks fully and rejects zero progress", async () => {
    const written: Buffer[] = [];
    const partial = {
      async write(buffer: Buffer, offset: number, length: number) {
        const bytesWritten = Math.min(2, length);
        written.push(buffer.subarray(offset, offset + bytesWritten));
        return { bytesWritten };
      },
    };
    await writeChunkFully(partial, Buffer.from("abcdef"));
    expect(Buffer.concat(written).toString("utf8")).toBe("abcdef");

    const zero = {
      async write() {
        return { bytesWritten: 0 };
      },
    };
    await expect(writeChunkFully(zero, Buffer.from("x"))).rejects.toMatchObject({ code: "io" });
  });

  it("rejects a cross-origin redirect carrying custom credentials", async () => {
    let targetHits = 0;
    const target = await listen((_request, response) => {
      targetHits++;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("should not run");
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, { location: `${target.url}/capture` });
      response.end();
    });
    const { sb } = await setup();

    await expect(
      runSpec(
        curlTool,
        {
          url: `${source.url}/start`,
          headers: {
            Authorization: "Bearer secret",
            "X-Api-Key": "secret",
          },
        },
        sb,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(targetHits).toBe(0);
  });

  it("follows a bodyless cross-origin GET with safe headers", async () => {
    let captured: IncomingHttpHeaders | undefined;
    const target = await listen((request, response) => {
      captured = request.headers;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, { location: `${target.url}/capture` });
      response.end();
    });
    const { sb } = await setup();

    const result = await runSpec(
      curlTool,
      { url: `${source.url}/start`, headers: { Accept: "text/plain" } },
      sb,
    );
    expect(result.result.stdout.toString()).toBe("ok");
    expect(captured?.accept).toBe("text/plain");
  });

  it("rejects a cross-origin 307 redirect that would resend the body", async () => {
    let targetHits = 0;
    const target = await listen((_request, response) => {
      targetHits++;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("should not run");
    });
    const source = await listen((_request, response) => {
      response.writeHead(307, { location: `${target.url}/capture` });
      response.end();
    });
    const { sb } = await setup();

    await expect(
      runSpec(
        curlTool,
        { url: `${source.url}/start`, method: "POST", body: "payload" },
        sb,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(targetHits).toBe(0);
  });

  it("rewrites a 303 POST to a safe bodyless GET across origins", async () => {
    let targetMethod: string | undefined;
    let targetBody = "";
    const target = await listen((request, response) => {
      targetMethod = request.method;
      request.on("data", (chunk: Buffer) => {
        targetBody += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
      });
    });
    const source = await listen((_request, response) => {
      response.writeHead(303, { location: `${target.url}/capture` });
      response.end();
    });
    const { sb } = await setup();

    const result = await runSpec(
      curlTool,
      { url: `${source.url}/start`, method: "POST", body: "payload" },
      sb,
    );
    expect(result.result.stdout.toString()).toBe("ok");
    expect(targetMethod).toBe("GET");
    expect(targetBody).toBe("");
  });

  it("still refuses a 303 that would carry custom auth", async () => {
    let targetHits = 0;
    const target = await listen((_request, response) => {
      targetHits++;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("should not run");
    });
    const source = await listen((_request, response) => {
      response.writeHead(303, { location: `${target.url}/capture` });
      response.end();
    });
    const { sb } = await setup();

    await expect(
      runSpec(
        curlTool,
        {
          url: `${source.url}/start`,
          method: "POST",
          body: "payload",
          headers: { "X-Api-Key": "secret" },
        },
        sb,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(targetHits).toBe(0);
  });

  it("rewrites a same-origin 302 POST after the policy", async () => {
    let targetMethod: string | undefined;
    let targetBody = "";
    const fixture = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/capture" });
        response.end();
        return;
      }
      targetMethod = request.method;
      request.on("data", (chunk: Buffer) => {
        targetBody += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
      });
    });
    const { sb } = await setup();

    const result = await runSpec(
      curlTool,
      { url: `${fixture.url}/start`, method: "POST", body: "payload" },
      sb,
    );
    expect(result.result.stdout.toString()).toBe("ok");
    expect(targetMethod).toBe("GET");
    expect(targetBody).toBe("");
  });

  it("still refuses a cross-origin 302 POST body", async () => {
    let targetHits = 0;
    const target = await listen((_request, response) => {
      targetHits++;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("should not run");
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, { location: `${target.url}/capture` });
      response.end();
    });
    const { sb } = await setup();

    await expect(
      runSpec(
        curlTool,
        { url: `${source.url}/start`, method: "POST", body: "payload" },
        sb,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(targetHits).toBe(0);
  });

  it("keeps credentials on a same-origin redirect", async () => {
    let captured: IncomingHttpHeaders | undefined;
    const fixture = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/capture" });
        response.end();
        return;
      }
      captured = request.headers;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    const { sb } = await setup();

    const result = await runSpec(
      curlTool,
      { url: `${fixture.url}/start`, headers: { Authorization: "Bearer secret" } },
      sb,
    );
    expect(result.result.stdout.toString()).toBe("ok");
    expect(captured?.authorization).toBe("Bearer secret");
  });

  it("rejects an HTTPS to HTTP redirect before the second request", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://example.com/next" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { sb } = await setup();
      await expect(
        runSpec(curlTool, { url: "https://example.com/start" }, sb),
      ).rejects.toMatchObject({ code: "unsupported" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("propagates a denied permission on a redirect hop", async () => {
    const fixture = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/blocked" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("should not run");
    });
    const root = await makeRoot("fs-curl-hop-");
    roots.push(root);
    const harness = makePluginHarness(root);
    const cleanup = (await plugin.setup(harness.context as never)) as () => void;
    cleanups.push(cleanup);
    harness.context.permission.assert = async (request) => {
      if (request.resources.includes(`${fixture.url}/blocked`)) {
        throw new Error("redirect hop denied");
      }
    };
    const tool = harness.editor.tools.find((entry) => entry.name === "curl");
    if (tool === undefined) throw new Error("missing curl tool");

    await expect(
      tool.execute({ url: `${fixture.url}/start` }, makeToolContext()),
    ).rejects.toThrow("redirect hop denied");
  });
});

describe("curl permission propagation", () => {
  async function loadCurl(root: string) {
    const harness = makePluginHarness(root);
    const cleanup = (await plugin.setup(harness.context as never)) as () => void;
    cleanups.push(cleanup);
    const tool = harness.editor.tools.find((entry) => entry.name === "curl");
    if (tool === undefined) throw new Error("missing curl tool");
    return { harness, tool };
  }

  it("propagates a webfetch denial through plugin execute", async () => {
    const root = await makeRoot("fs-curl-deny-");
    roots.push(root);
    const { harness, tool } = await loadCurl(root);
    harness.context.permission.assert = async () => {
      throw new Error("permission denied by test");
    };
    await expect(
      tool.execute({ url: "https://example.com/" }, makeToolContext()),
    ).rejects.toThrow("permission denied by test");
  });

  it("gates external curl output on the containing directory", async () => {
    const root = await makeRoot("fs-curl-out-boundary-");
    roots.push(root);
    const outside = await makeOutside();
    roots.push(outside.dir);
    const realOutside = await fs.realpath(outside.dir);
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("body");
    });
    const { harness, tool } = await loadCurl(root);
    const requests: PermissionAssertInput[] = [];
    harness.context.permission.assert = async (request) => {
      requests.push(request);
    };

    await tool.execute(
      {
        url: `${fixture.url}/body`,
        output: path.join(realOutside, "out.txt"),
      },
      makeToolContext(),
    );

    const external = requests.find((request) => request.action === "external_directory");
    expect(external?.resources).toEqual([`${realOutside}/*`]);
    expect(await fs.readFile(path.join(realOutside, "out.txt"), "utf8")).toBe("body");
  });

  it("propagates an external output denial through plugin execute", async () => {
    const root = await makeRoot("fs-curl-out-deny-");
    roots.push(root);
    const outside = await makeOutside();
    roots.push(outside.dir);
    const fixture = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("body");
    });
    const { harness, tool } = await loadCurl(root);
    harness.context.permission.assert = async (request) => {
      if (request.action === "external_directory") throw new Error("external denied by test");
    };
    await expect(
      tool.execute(
        {
          url: `${fixture.url}/body`,
          output: path.join(outside.dir, "out.txt"),
        },
        makeToolContext(),
      ),
    ).rejects.toThrow("external denied by test");
  });
});

describe("relay resource validation", () => {
  function decoded(resource: string): string {
    const frame = encodeDecisionRequest({ id: 1n, resource, port: 443, proto: 1 });
    return decodeDecisionRequest(frame.subarray(4)).resource;
  }

  it("accepts DNS, host:port, IPv4, bare IPv6 and bracketed IPv6 Host forms", () => {
    const accepted = [
      "example.com",
      "example.com.",
      "example.com:443",
      "example.com:65535",
      "localhost",
      "localhost:8080",
      "127.0.0.1",
      "127.0.0.1:80",
      "2001:db8::1",
      "::1",
      "[::1]",
      "[::1]:443",
      "[2001:db8::1]:8443",
      "[::ffff:192.0.2.1]",
      "_service._tcp.example.com",
      "xn--bcher-kva.example",
      "EXAMPLE.COM",
      "a".repeat(255),
    ];
    for (const resource of accepted) expect(decoded(resource)).toBe(resource);
  });

  it("rejects glob and malformed resource syntax", () => {
    const rejected = [
      "*",
      "*.example.com",
      "a?b",
      "a{b}",
      "a[b]",
      "foo[bar]",
      "foo]",
      "[::1",
      "[]",
      "[127.0.0.1]",
      "[::1]x",
      "[::1]:",
      "[::1]:0",
      "[::1]:65536",
      "[::1]:abc",
      "[::1]:123456",
      ".",
      ".example",
      "example..com",
      "example.com..",
      "example.com:",
      "example.com:abc",
      "example.com:0",
      ":443",
      "a:",
      "1:2:3",
      "-foo",
      "foo-",
      "a/b",
      "a\\b",
      "a,b",
      "a@b",
      "a#b",
    ];
    for (const resource of rejected) {
      expect(() => decoded(resource)).toThrow(RelayProtocolError);
    }
  });

  it("closes the control link without asking for a wildcard grant", async () => {
    for (const resource of ["*", "*.example.com"]) {
      const baseDir = await makeRoot("fs-relay-glob-");
      roots.push(baseDir);
      const seen: string[] = [];
      const server = new RelayControlServer({
        runId: 7n,
        assertNetwork: async (value) => {
          seen.push(value);
        },
        baseDir,
      });
      await server.start();
      try {
        const socket = net.createConnection(server.socketPath);
        socket.on("error", () => {});
        await once(socket, "connect");
        const hello = Buffer.alloc(14);
        hello.writeUInt8(RELAY_HELLO, 0);
        hello.writeUInt8(1, 1);
        hello.writeBigUInt64BE(7n, 2);
        hello.writeUInt32BE(4242, 10);
        socket.write(encodeFrame(hello));
        await new Promise<void>((resolve) => socket.once("data", () => resolve()));
        socket.write(encodeDecisionRequest({ id: 1n, resource, port: 443, proto: 1 }));
        await Promise.race([
          once(socket, "close"),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("relay did not close")), 3000).unref();
          }),
        ]);
        expect(seen).toEqual([]);
      } finally {
        await server.close();
      }
    }
  });
});

describe("job retention cap", () => {
  const ok: RenderedResult = { content: "ok", metadata: { ok: true } };

  function makeManager(
    dir: string,
    extra: { limit?: number; retainedLimit?: number; maxResultBytes?: number } = {},
  ): JobManager {
    const manager = new JobManager({ dir, ttlMs: 60_000, ...extra });
    managers.push(manager);
    return manager;
  }

  async function completed(manager: JobManager): Promise<string> {
    const job = await manager.start("stat", async () => ok);
    await manager.wait(job.id, 1000);
    return job.id;
  }

  it("evicts the oldest finished job and removes its status file", async () => {
    const dir = await makeRoot("fs-jobs-retained-");
    roots.push(dir);
    const manager = makeManager(dir, { retainedLimit: 3 });
    const ids: string[] = [];
    for (let index = 0; index < 4; index++) ids.push(await completed(manager));

    const first = ids[0] as string;
    expect(manager.list()).toHaveLength(3);
    expect(() => manager.status(first)).toThrow(/job not found/);
    expect(await pathExists(path.join(dir, `${first}.json`))).toBe(false);
    for (const id of ids.slice(1)) {
      expect(await pathExists(path.join(dir, `${id}.json`))).toBe(true);
    }
    expect(manager.status(ids[3] as string).state).toBe("completed");
  });

  it("keeps a running job while evicting finished ones", async () => {
    const dir = await makeRoot("fs-jobs-running-");
    roots.push(dir);
    const manager = makeManager(dir, { retainedLimit: 3 });
    let release!: (value: RenderedResult) => void;
    const running = await manager.start(
      "cp",
      () => new Promise<RenderedResult>((resolve) => {
        release = resolve;
      }),
    );
    await completed(manager);
    await completed(manager);
    await completed(manager);

    expect(manager.list().map((job) => job.id)).toContain(running.id);
    expect(manager.status(running.id).state).toBe("running");
    release(ok);
    await manager.wait(running.id, 1000);
  });

  it("rejects a new job when only running jobs fill the retained window", async () => {
    const dir = await makeRoot("fs-jobs-full-");
    roots.push(dir);
    const manager = makeManager(dir, { limit: 4, retainedLimit: 1 });
    let release!: (value: RenderedResult) => void;
    const running = await manager.start(
      "cp",
      () => new Promise<RenderedResult>((resolve) => {
        release = resolve;
      }),
    );

    await expect(manager.start("stat", async () => ok)).rejects.toMatchObject({ code: "busy" });
    release(ok);
    await manager.wait(running.id, 1000);
  });

  it("holds both caps under simultaneous starts", async () => {
    const dir = await makeRoot("fs-jobs-concurrent-");
    roots.push(dir);
    const manager = makeManager(dir, { limit: 4, retainedLimit: 4 });
    const pre: string[] = [];
    for (let index = 0; index < 3; index++) pre.push(await completed(manager));

    let maxRetained = 0;
    let maxRunning = 0;
    const snapshot = () => {
      const rows = manager.list();
      maxRetained = Math.max(maxRetained, rows.length);
      maxRunning = Math.max(maxRunning, rows.filter((row) => row.state === "running").length);
    };
    const run = async (): Promise<RenderedResult> => {
      snapshot();
      return ok;
    };

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => manager.start("stat", run)),
    );
    snapshot();

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<JobStatus> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(4);
    for (const result of rejected) expect(result.reason).toMatchObject({ code: "busy" });
    expect(maxRetained).toBeLessThanOrEqual(4);
    expect(maxRunning).toBeLessThanOrEqual(4);
    expect(manager.list().length).toBeLessThanOrEqual(4);
    for (const id of pre) expect(() => manager.status(id)).toThrow(/job not found/);
    // Let every admitted job write its final status before afterEach removes the
    // directory; otherwise an in-flight write can recreate a file mid-rm.
    for (const result of fulfilled) await manager.wait(result.value.id, 1000);
  });

  it("holds the running cap under simultaneous starts", async () => {
    const dir = await makeRoot("fs-jobs-concurrent-running-");
    roots.push(dir);
    const manager = makeManager(dir, { limit: 2, retainedLimit: 20 });
    const releases: Array<(value: RenderedResult) => void> = [];
    const run = () =>
      new Promise<RenderedResult>((resolve) => {
        releases.push(resolve);
      });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => manager.start("cp", run)),
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<JobStatus> => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(2);
    expect(manager.list()).toHaveLength(2);
    for (const result of rejected) expect(result.reason).toMatchObject({ code: "busy" });

    for (const release of releases) release(ok);
    for (const result of fulfilled) await manager.wait(result.value.id, 1000);
  });
});

describe("job ownership", () => {
  async function loadJobPlugin() {
    const root = await makeRoot("fs-jobs-owner-");
    roots.push(root);
    const harness = makePluginHarness(root, { jobDir: path.join(root, "jobs") });
    const cleanup = (await plugin.setup(harness.context as never)) as () => void;
    cleanups.push(cleanup);
    const mkdir = harness.editor.tools.find((entry) => entry.name === "mkdir");
    const job = harness.editor.tools.find((entry) => entry.name === "job");
    if (mkdir === undefined || job === undefined) throw new Error("missing job tools");
    return { mkdir, job };
  }

  const session = (sessionID: string) => ({ ...makeToolContext(), sessionID });

  it("scopes list, status, wait and cancel to the originating session", async () => {
    const { mkdir, job } = await loadJobPlugin();
    const a = session("ses_a");
    const b = session("ses_b");

    const started = (await mkdir.execute(
      { path: "owned", verbose: true, background: true },
      a,
    )) as { content: string };
    const payload = JSON.parse(started.content) as { jobId: string };

    const aWait = (await job.execute(
      { id: payload.jobId, wait: true, timeoutMs: 1000 },
      a,
    )) as { content: string; metadata: Record<string, unknown> };
    expect(aWait.content).toContain("Directory created");
    expect(aWait.metadata).toMatchObject({ state: "completed", timedOut: false });

    const bList = JSON.parse(
      ((await job.execute({ list: true }, b)) as { content: string }).content,
    ) as { jobs: Array<{ id: string }> };
    expect(bList.jobs).toEqual([]);

    const bStatus = (await job.execute({ id: payload.jobId }, b)) as {
      content: string;
      metadata: Record<string, unknown>;
    };
    expect(bStatus.content).toMatch(/^ERROR: job not found/);
    expect(bStatus.metadata).toMatchObject({ code: "not-found", ok: false });

    const bCancel = (await job.execute({ id: payload.jobId, cancel: true }, b)) as {
      content: string;
    };
    expect(bCancel.content).toMatch(/^ERROR: job not found/);

    const bWait = (await job.execute({ id: payload.jobId, wait: true, timeoutMs: 100 }, b)) as {
      content: string;
    };
    expect(bWait.content).toMatch(/^ERROR: job not found/);
    expect(bWait.content).not.toContain("Directory created");

    const aList = JSON.parse(
      ((await job.execute({ list: true }, a)) as { content: string }).content,
    ) as { jobs: Array<{ id: string }> };
    expect(aList.jobs.map((entry) => entry.id)).toContain(payload.jobId);

    const aStatus = JSON.parse(
      ((await job.execute({ id: payload.jobId }, a)) as { content: string }).content,
    ) as { state: string };
    expect(aStatus.state).toBe("completed");

    const aCancel = JSON.parse(
      ((await job.execute({ id: payload.jobId, cancel: true }, a)) as { content: string }).content,
    ) as { state: string };
    expect(aCancel.state).toBe("completed");
  });

  it("rejects empty or missing session ids without creating a shared job", async () => {
    const { mkdir, job } = await loadJobPlugin();
    for (const sessionID of ["", undefined]) {
      const context = {
        ...makeToolContext(),
        sessionID: sessionID as unknown as string,
      };
      const started = (await mkdir.execute(
        { path: "no-session", background: true },
        context,
      )) as { content: string; metadata: Record<string, unknown> };
      expect(started.content).toMatch(/^ERROR: .*session/);
      expect(started.metadata).toMatchObject({ ok: false, code: "invalid" });

      const listed = (await job.execute({ list: true }, context)) as {
        content: string;
        metadata: Record<string, unknown>;
      };
      expect(listed.content).toMatch(/^ERROR: .*session/);
      expect(listed.metadata).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("rejects an explicitly empty owner at the manager boundary", async () => {
    const dir = await makeRoot("fs-jobs-owner-empty-");
    roots.push(dir);
    const manager = new JobManager({ dir, ttlMs: 60_000 });
    managers.push(manager);
    await expect(manager.start("stat", async () => ({ content: "ok", metadata: {} }), ""))
      .rejects.toMatchObject({ code: "invalid" });
    expect(manager.list("")).toEqual([]);
  });
});

describe("job status privacy", () => {
  it("uses private modes and never writes result content", async () => {
    const dir = await makeRoot("fs-jobs-mode-");
    roots.push(dir);
    await fs.chmod(dir, 0o755);
    const manager = new JobManager({ dir, ttlMs: 60_000 });
    managers.push(manager);

    const secret: RenderedResult = { content: "SECRET-RESULT-CONTENT", metadata: { ok: true } };
    const job = await manager.start("cat", async () => secret);
    await manager.wait(job.id, 1000);

    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    const file = path.join(dir, `${job.id}.json`);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain("SECRET-RESULT-CONTENT");
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      id: job.id,
      tool: "cat",
      state: "completed",
      hasResult: true,
    });
    expect(parsed).not.toHaveProperty("statusPath");
    expect(await fs.readdir(dir)).toEqual([`${job.id}.json`]);
  });

  it("refuses a symlinked job directory and leaves the outside target unchanged", async () => {
    const root = await makeRoot("fs-jobs-symlink-");
    roots.push(root);
    const outside = await makeOutside();
    roots.push(outside.dir);
    const target = path.join(outside.dir, "target");
    await fs.mkdir(target);
    await fs.chmod(target, 0o755);
    const link = path.join(root, "jobs-link");
    await fs.symlink(target, link, "dir");

    const manager = new JobManager({ dir: link, ttlMs: 60_000 });
    managers.push(manager);
    await expect(manager.start("stat", async () => ({ content: "ok", metadata: {} })))
      .rejects.toThrow(/symbolic link/);

    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
    expect(await fs.readdir(target)).toEqual([]);
    expect(manager.list()).toEqual([]);
  });

  it("refuses a symlinked intermediate parent and leaves the outside target unchanged", async () => {
    const root = await makeRoot("fs-jobs-parent-symlink-");
    roots.push(root);
    const outside = await makeOutside();
    roots.push(outside.dir);
    await fs.chmod(outside.dir, 0o755);
    const parent = path.join(root, "parent");
    await fs.symlink(outside.dir, parent, "dir");

    const manager = new JobManager({ dir: path.join(parent, "jobs"), ttlMs: 60_000 });
    managers.push(manager);
    await expect(manager.start("stat", async () => ({ content: "ok", metadata: {} })))
      .rejects.toThrow(/symbolic link/);

    expect((await fs.stat(outside.dir)).mode & 0o777).toBe(0o755);
    expect(await fs.readdir(outside.dir)).toEqual(["secret.txt"]);
    expect(await pathExists(path.join(outside.dir, "jobs"))).toBe(false);
    expect(manager.list()).toEqual([]);
  });

  it("supports an ordinary nested job directory", async () => {
    const root = await makeRoot("fs-jobs-nested-");
    roots.push(root);
    const dir = path.join(root, "a", "b");
    const manager = new JobManager({ dir, ttlMs: 60_000 });
    managers.push(manager);
    const job = await manager.start("stat", async () => ({ content: "ok", metadata: {} }));
    await manager.wait(job.id, 1000);

    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect(await pathExists(path.join(dir, `${job.id}.json`))).toBe(true);
  });

  it("refuses the filesystem root as a job directory", async () => {
    const manager = new JobManager({ dir: "/", ttlMs: 60_000 });
    managers.push(manager);
    await expect(manager.start("stat", async () => ({ content: "ok", metadata: {} })))
      .rejects.toThrow(/filesystem root/);
    expect(manager.list()).toEqual([]);
  });

  it("keeps error detail in memory but not in the status file", async () => {
    const dir = await makeRoot("fs-jobs-error-");
    roots.push(dir);
    const manager = new JobManager({ dir, ttlMs: 60_000 });
    managers.push(manager);
    const sensitive = "https://secret.example/token?value=1";

    const job = await manager.start("curl", async () => {
      throw new Error(sensitive);
    });
    const waited = await manager.wait(job.id, 1000);
    expect(waited.status).toMatchObject({ state: "failed", error: sensitive });

    const raw = await fs.readFile(path.join(dir, `${job.id}.json`), "utf8");
    const parsed = JSON.parse(raw);
    expect(raw).not.toContain(sensitive);
    expect(parsed).not.toHaveProperty("error");
    expect(parsed).not.toHaveProperty("statusPath");
  });

  it("bounds one rendered result and records truncation metadata", async () => {
    const dir = await makeRoot("fs-jobs-cap-");
    roots.push(dir);
    const manager = new JobManager({ dir, ttlMs: 60_000, maxResultBytes: 64 });
    managers.push(manager);

    const ascii = await manager.start("cat", async () => ({
      content: "x".repeat(200),
      metadata: { ok: true },
    }));
    const asciiWait = await manager.wait(ascii.id, 1000);
    expect(asciiWait.result?.metadata).toMatchObject({ truncated: true, originalBytes: 200 });
    expect(asciiWait.result?.content.length).toBeLessThan(200);
    expect(asciiWait.result?.content.endsWith("[truncated]")).toBe(true);

    const multibyte = await manager.start("cat", async () => ({
      content: `a${"é".repeat(100)}`,
      metadata: { ok: true },
    }));
    const multibyteWait = await manager.wait(multibyte.id, 1000);
    expect(multibyteWait.result?.metadata).toMatchObject({ truncated: true, originalBytes: 201 });
    expect(multibyteWait.result?.content.endsWith("[truncated]")).toBe(true);

    const binary = await manager.start("cat", async () => ({
      content: "A".repeat(200),
      metadata: { encoding: "base64" },
    }));
    const binaryWait = await manager.wait(binary.id, 1000);
    expect(binaryWait.result).toMatchObject({
      content: "",
      metadata: { encoding: "base64", truncated: true, originalBytes: 200 },
    });

    const tinyDir = await makeRoot("fs-jobs-cap-tiny-");
    roots.push(tinyDir);
    const tiny = new JobManager({ dir: tinyDir, ttlMs: 60_000, maxResultBytes: 12 });
    managers.push(tiny);
    const tinyJob = await tiny.start("cat", async () => ({
      content: "x".repeat(20),
      metadata: {},
    }));
    const tinyWait = await tiny.wait(tinyJob.id, 1000);
    expect(tinyWait.result?.content).toBe("\n[truncated]");
  });
});
