import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  Cloudflare,
  Previews,
  expiresAt,
  previewConfig,
  previewFetch,
  previewName,
  up,
} from "../tools/preview";

const name = "p261005-0123456789";

const resourceName = `hearth-preview-${name}`;

const previewPath = "/workers/workers/hearth-test/previews";

const sourceApp = {
  id: "production-access",
  name: "Hearth",
  aud: "production-audience",
  allowed_idps: ["google"],
  policies: [{ name: "Household", decision: "allow", include: [{ email: { email: "test@example.com" } }] }],
};

type Item = { id: string; name: string; uuid?: string; urls?: string[] };

function cloud(existing = true) {
  const resources = new Map<string, Item[]>([
    [previewPath, existing ? [{ id: "preview-id", name }] : []],
    [
      "/d1/database",
      [
        { id: "production-db", uuid: "production-db", name: "hearth-production" },
        ...(existing ? [{ id: "preview-db", uuid: "preview-db", name: resourceName }] : []),
      ],
    ],
    ["/access/apps", [sourceApp, ...(existing ? [{ id: "preview-access", name: resourceName }] : [])]],
    ["/access/service_tokens", existing ? [{ id: "preview-token", name: resourceName }] : []],
  ]);

  const calls: string[] = [];
  let failure = "";

  const api = new Cloudflare("test-account", "test-credential", async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4/accounts/test-account", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);

    if (`${method} ${path}` === failure) {
      return Response.json({ success: false, errors: [{ code: 1010, message: "denied" }] }, { status: 403 });
    }

    if (method === "GET") {
      if (path === `${previewPath}/created-previews/deployments/latest`) {
        return Response.json({ success: true, result: { id: "deployment-from-api" } });
      }

      if (path === `${previewPath}/created-previews`) {
        return Response.json({ success: true, result: resources.get(previewPath)?.[0] });
      }

      const items = resources.get(path);

      if (!items) throw new Error(`Unexpected GET ${path}`);
      const page = Number(url.searchParams.get("page") ?? 1);

      return Response.json({ success: true, result: items.slice((page - 1) * 100, page * 100) });
    }

    if (method === "POST") {
      if (path === "/access/service_tokens/preview-token/rotate") {
        return Response.json({
          success: true,
          result: {
            id: "preview-token",
            name: resourceName,
            client_id: "test-client",
            client_secret: "rotated-secret",
          },
        });
      }

      const body = JSON.parse(String(init?.body));

      const item = {
        id: `created-${path.split("/").at(-1)}`,
        uuid: "created-db",
        name: body.name,
        urls: ["https://test-hearth.example.workers.dev"],
        aud: "preview-audience",
        client_id: "test-client",
        client_secret: "test-secret",
      };

      resources.get(path)?.push(item);

      return Response.json({ success: true, result: item });
    }

    if (method === "PUT") return Response.json({ success: true, result: { aud: "preview-audience" } });

    if (method !== "DELETE") throw new Error(`Unexpected ${method}`);
    const collection = path.slice(0, path.lastIndexOf("/"));
    const id = path.split("/").at(-1);
    resources.set(
      collection,
      (resources.get(collection) ?? []).filter(
        (item) => (collection === "/d1/database" ? item.uuid : item.id) !== id,
      ),
    );

    return Response.json({ success: true, result: null });
  });

  return {
    manager: new Previews(api, "hearth-test"),
    resources,
    calls,
    fail: (value: string) => {
      failure = value;
    },
  };
}

afterEach(async () => {
  await rm(`.wrangler/hearth-previews/${name}`, { recursive: true, force: true });
});

describe("Cloudflare Preview lifecycle", () => {
  it("uses short, stable thread identities and a UTC cleanup deadline", () => {
    const thread = "T-01a0e81c-8ee2-766c-8a73-06d436bb2995";
    const result = previewName(thread, Date.parse("2026-09-28T23:45:00-04:00"));
    expect(result).toBe("p261006-c1651413a0");
    expect(expiresAt(result)).toBe(Date.parse("2026-10-06T00:00:00Z"));
    expect(previewName(thread.replace("2995", "2996"))).not.toContain("c1651413a0");
    expect(() => previewName("main")).toThrow("thread ID");
    expect(() => expiresAt("../../production")).toThrow("Not a managed");
  });

  it("configures authentication and an isolated binding without production routes or bindings", () => {
    const config = previewConfig(
      "hearth-test",
      { id: "preview-db", uuid: "preview-db", name: resourceName },
      "preview-audience",
      "preview-client.access",
    );

    expect(config.previews.vars).toEqual({
      LOCAL_DEV: "false",
      ACCESS_AUD: "preview-audience",
      PREVIEW_CLIENT_ID: "preview-client.access",
    });
    expect(config.previews.d1_databases).toEqual([
      { binding: "DB", database_name: resourceName, database_id: "preview-db" },
    ]);
    expect(config.assets.run_worker_first).toBe(true);
    expect(config.assets.binding).toBe("ASSETS");
    expect(config).not.toHaveProperty("routes");
    expect(config).not.toHaveProperty("d1_databases");
    expect(() =>
      previewConfig(
        "hearth-test",
        { id: "production", uuid: "production", name: "hearth-production" },
        "aud",
        "preview-client.access",
      ),
    ).toThrow("non-preview");
  });

  it("deletes Preview before D1 and Access, verifies absence, and is repeatable", async () => {
    const { manager, calls, resources } = cloud();
    await manager.down(name);
    expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      `DELETE ${previewPath}/preview-id`,
      "DELETE /d1/database/preview-db",
      "DELETE /access/apps/preview-access",
      "DELETE /access/service_tokens/preview-token",
    ]);
    expect(resources.get("/d1/database")).toEqual([
      { id: "production-db", uuid: "production-db", name: "hearth-production" },
    ]);
    expect(resources.get("/access/apps")).toEqual([sourceApp]);
    const count = calls.filter((call) => call.startsWith("DELETE")).length;
    await manager.down(name);
    expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(count);
  });

  it("does not remove data or protection when Preview deletion fails", async () => {
    const { manager, calls, fail } = cloud();
    fail(`DELETE ${previewPath}/preview-id`);
    await expect(manager.down(name)).rejects.toThrow("403");
    expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([`DELETE ${previewPath}/preview-id`]);
  });

  it("recovers orphan resources and only collects names at or past the cleanup deadline", async () => {
    const { manager, resources, calls } = cloud();
    resources.set(previewPath, []); // Simulate Cloudflare eviction or a previous partial teardown.
    resources
      .get("/d1/database")
      ?.push({ id: "future", uuid: "future", name: "hearth-preview-p261006-9876543210" });
    await manager.gc(Date.parse("2026-10-04T23:59:59Z"));
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    await manager.gc(Date.parse("2026-10-05T00:00:00Z"));
    expect(manager.names(await manager.inventory())).toEqual(["p261006-9876543210"]);
    expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(3);
  });

  it("reads additional inventory pages rather than leaking resources after page 1", async () => {
    const { manager, resources } = cloud(false);
    resources.set(
      "/d1/database",
      Array.from({ length: 100 }, (_, i) => ({ id: `${i}`, name: `other-${i}` })),
    );
    resources.get("/d1/database")?.push({ id: "preview-db", uuid: "preview-db", name: resourceName });
    expect(manager.names(await manager.inventory())).toEqual([name]);
    await manager.down(name);
    expect(resources.get("/d1/database")).toHaveLength(100);
  });

  it("rolls back a fresh Preview when service-token permissions are missing", async () => {
    const { manager, calls, fail } = cloud(false);
    fail("POST /access/service_tokens");
    await expect(up(manager, name, sourceApp)).rejects.toThrow("403");
    expect(manager.names(await manager.inventory())).toEqual([]);
    expect(calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      `DELETE ${previewPath}/created-previews`,
    ]);
  });

  it("rolls back every newly provisioned resource if migrations fail", async () => {
    const { manager, calls } = cloud(false);
    await expect(
      up(manager, name, sourceApp, () => {
        throw new Error("migration failed");
      }),
    ).rejects.toThrow("migration failed");
    expect(manager.names(await manager.inventory())).toEqual([]);
    expect(calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(4);
  });

  it("reads deployment metadata from the API despite non-JSON Wrangler asset progress", async () => {
    const { manager, calls } = cloud(false);
    const verified: string[] = [];
    await up(
      manager,
      name,
      sourceApp,
      () => '🌀 Building assets...\n{"deployment_id":"cli-value"}',
      async (preview) => {
        verified.push(preview);
      },
    );
    const state = JSON.parse(await readFile(`.wrangler/hearth-previews/${name}/preview.json`, "utf8"));
    expect(state.deployment).toBe("deployment-from-api");
    expect(state.url).toBe("https://test-hearth.example.workers.dev");
    expect(verified).toEqual([name]);
    expect(calls).toContain(`GET ${previewPath}/created-previews/deployments/latest`);
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  it("preserves an existing Preview and data if a redeployment fails", async () => {
    const { manager, resources, calls } = cloud();
    resources.set(previewPath, [
      { id: "preview-id", name, urls: ["https://test-hearth.example.workers.dev"] },
    ]);
    await expect(
      up(manager, name, sourceApp, () => {
        throw new Error("migration failed");
      }),
    ).rejects.toThrow("migration failed");
    expect(manager.names(await manager.inventory())).toEqual([name]);
    expect(calls).toContain("POST /access/service_tokens/preview-token/rotate");
    expect(calls).not.toContain("DELETE /access/service_tokens/preview-token");
    expect(calls).not.toContain("DELETE /d1/database/preview-db");
    expect(calls).not.toContain(`DELETE ${previewPath}/preview-id`);
  });

  it.each([
    [403, 200, 2, 200],
    [503, 200, 1, 503],
    [401, 401, 12, 401],
  ])(
    "bounds auth retries without replaying ambiguous writes: %i then %i",
    async (first, next, count, result) => {
      const directory = `.wrangler/hearth-previews/${name}`;
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/preview.json`, JSON.stringify({ url: "https://preview.example.test" }));
      await writeFile(
        `${directory}/credentials.json`,
        JSON.stringify({ client_id: "test-id", client_secret: "test-secret" }),
      );
      let requests = 0;

      const response = await previewFetch(
        name,
        "/api/extras",
        "PUT",
        "{}",
        async (_url, init) => {
          expect(init?.redirect).toBe("manual");
          expect(init?.body).toBe("{}");
          requests++;

          return new Response("", { status: requests === 1 ? first : next });
        },
        async () => {},
      );

      expect(response.status).toBe(result);
      expect(requests).toBe(count);
      await expect(previewFetch(name, "/\\evil.example")).rejects.toThrow("Cross-origin");
    },
  );
});
