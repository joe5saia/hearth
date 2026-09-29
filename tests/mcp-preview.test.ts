import { expect, it } from "vitest";
import { Cloudflare } from "../tools/preview";
import { removeMcpPreview } from "../tools/mcp-preview";

const state = {
  name: "p261005-0123456789-mcp",
  parent: "hearth-mcp-p261005-0123456789-mcp",
  preview: "preview",
  url: "https://preview.example.com",
  app: "app",
  token: "token",
  db: "db",
  kv: "kv",
};

function fixture(parentPresent = true) {
  const parent = `/workers/workers/${state.parent}`;

  const resources = new Map<string, { id?: string; uuid?: string }[]>([
    [`${parent}/previews`, [{ id: state.preview }]],
    ["/access/apps", [{ id: state.app }, { id: "unrelated" }]],
    ["/access/service_tokens", [{ id: state.token }]],
    ["/d1/database", [{ uuid: state.db }]],
    ["/storage/kv/namespaces", [{ id: state.kv }]],
  ]);

  const calls: string[] = [];
  let fail = "";
  let retain = "";

  const api = new Cloudflare("test", "test", async (input, init) => {
    const path = new URL(String(input)).pathname.replace("/client/v4/accounts/test", "");
    const call = `${init?.method ?? "GET"} ${path}`;
    calls.push(call);

    if (call === fail) return Response.json({ success: false }, { status: 403 });

    if (path === parent) {
      if (!parentPresent) return Response.json({ success: false }, { status: 404 });

      if (init?.method === "DELETE") parentPresent = false;

      return Response.json({ success: true, result: {} });
    }

    if (path.startsWith(`${parent}/`) && !parentPresent)
      throw new Error("Must not list previews of an absent parent");

    if (init?.method === "GET") {
      if (!resources.has(path)) throw new Error(`Unexpected inventory: ${path}`);

      return Response.json({ success: true, result: resources.get(path) });
    }

    const base = path.slice(0, path.lastIndexOf("/"));
    const id = path.slice(path.lastIndexOf("/") + 1);
    const items = resources.get(base)!;

    if (!items.some((item) => (item.id ?? item.uuid) === id))
      return Response.json({ success: false }, { status: 404 });

    if (path !== retain)
      resources.set(
        base,
        items.filter((item) => (item.id ?? item.uuid) !== id),
      );

    return Response.json({ success: true, result: {} });
  });

  return {
    api,
    resources,
    calls,
    parent,
    fail: (call: string) => {
      fail = call;
    },
    retain: (path: string) => {
      retain = path;
    },
  };
}

it("resumes cleanup after the app was deleted and token deletion failed", async () => {
  const f = fixture();
  f.fail("DELETE /access/service_tokens/token");
  await expect(removeMcpPreview(f.api, state)).rejects.toThrow("HTTP 403");
  expect(f.resources.get("/access/apps")).toEqual([{ id: "unrelated" }]);
  f.fail("");
  await removeMcpPreview(f.api, state);
  await removeMcpPreview(f.api, state);
  expect(f.calls.filter((call) => call === "DELETE /access/apps/app")).toHaveLength(1);
  expect(f.resources.get("/access/apps")).toEqual([{ id: "unrelated" }]);

  for (const path of ["/access/service_tokens", "/d1/database", "/storage/kv/namespaces"])
    expect(f.resources.get(path)).toEqual([]);
});

it("removes supporting resources even when the parent is already absent", async () => {
  const f = fixture(false);
  await removeMcpPreview(f.api, state);
  expect(f.calls).not.toContain(`GET ${f.parent}/previews`);
  expect(f.resources.get("/storage/kv/namespaces")).toEqual([]);
});

it("does not mistake permission failures or delayed deletion for absence", async () => {
  const f = fixture();
  f.fail(`GET ${f.parent}`);
  await expect(removeMcpPreview(f.api, state)).rejects.toThrow("HTTP 403");
  expect(f.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  f.fail("");
  f.retain("/access/apps/app");
  await expect(removeMcpPreview(f.api, state)).rejects.toThrow("Resource still exists");
  expect(f.calls).not.toContain(`DELETE ${f.parent}`);
});
