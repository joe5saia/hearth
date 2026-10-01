import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { rolldown } from "rolldown";

let worker: Miniflare;

let protectedWorker: Miniflare;

beforeAll(async () => {
  // Exercise the real production build, Worker, and Static Assets router, not a mocked asset binding.
  execFileSync("npx", ["task", "build"], { stdio: "pipe" });
  const bundle = await rolldown({ input: "src/server.ts", platform: "browser" });
  const output = await bundle.generate({ format: "esm" });
  await bundle.close();
  const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);

  if (!entry || entry.type !== "chunk") throw new Error("Worker bundle missing");

  const start = (local: string) =>
    new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: "hearth-branding",
            modules: true,
            script: entry.code,
            compatibilityDate: "2026-09-08",
            bindings: { LOCAL_DEV: local, ACCESS_AUD: "branding-test" },
            assets: {
              directory: resolve("dist"),
              binding: "ASSETS",
              run_worker_first: true,
              routerConfig: { has_user_worker: true },
              assetConfig: { not_found_handling: "single-page-application" },
            },
          },
        ],
      }),
    );

  worker = start("true");
  protectedWorker = start("false");
}, 30_000);

afterAll(async () => {
  await worker?.dispose();
  await protectedWorker?.dispose();
});

it("serves branded HTML, install metadata, and the review kit through the actual Worker", async () => {
  const response = await worker.dispatchFetch("https://hearth.example/");
  expect(response.status, await response.clone().text()).toBe(200);
  const html = await response.text();
  expect(html).toContain('href="/favicon.ico"');
  expect(html).toContain('href="/favicon.svg"');
  expect(html).toContain('href="/apple-touch-icon.png"');
  expect(html).toContain('href="/site.webmanifest" crossorigin="use-credentials"');
  expect(html).toContain('content="https://hearth.joesaia.trade/brand/social-card.png"');

  const manifestResponse = await worker.dispatchFetch("https://hearth.example/site.webmanifest");
  expect(manifestResponse.status).toBe(200);
  expect(manifestResponse.headers.get("content-type")).toContain("application/manifest+json");
  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    id: "/",
    short_name: "Hearth",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest).toMatchObject({
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
  const kit = await worker.dispatchFetch("https://hearth.example/brand/");
  expect(kit.status).toBe(200);
  expect(await kit.text()).toContain("Hearth logo &amp; icon kit");
});

it("delivers real PNG bytes at each advertised device size, not SPA fallback HTML", async () => {
  const images: [string, number, number][] = [
    ["/icons/favicon-16.png", 16, 16],
    ["/icons/favicon-32.png", 32, 32],
    ["/icons/favicon-48.png", 48, 48],
    ["/apple-touch-icon.png", 180, 180],
    ["/icons/apple-touch-icon-120.png", 120, 120],
    ["/icons/apple-touch-icon-152.png", 152, 152],
    ["/icons/apple-touch-icon-167.png", 167, 167],
    ["/icons/apple-touch-icon-180.png", 180, 180],
    ["/icons/icon-192.png", 192, 192],
    ["/icons/icon-512.png", 512, 512],
    ["/icons/maskable-192.png", 192, 192],
    ["/icons/maskable-512.png", 512, 512],
    ["/brand/social-card.png", 1200, 630],
    ["/brand/logo.png", 1840, 500],
    ["/brand/icon.png", 1024, 1024],
  ];

  for (const [path, width, height] of images) {
    const response = await worker.dispatchFetch(`https://hearth.example${path}`);
    expect(response.status, path).toBe(200);
    expect(response.headers.get("content-type"), path).toContain("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8).toString("hex"), path).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16), path).toBe(width);
    expect(bytes.readUInt32BE(20), path).toBe(height);
  }
});

it("delivers outlined vector masters, a single-color mask, and a valid multi-frame ICO", async () => {
  for (const name of [
    "logo",
    "logo-monochrome",
    "logo-reversed",
    "icon",
    "icon-small",
    "icon-micro",
    "icon-monochrome",
    "icon-reversed",
  ]) {
    const response = await worker.dispatchFetch(`https://hearth.example/brand/${name}.svg`);
    expect(response.status, name).toBe(200);
    expect(response.headers.get("content-type"), name).toContain("image/svg+xml");
    const svg = await response.text();
    expect(svg, name).toContain("<path");
    expect(svg, name).not.toMatch(/<text|<image|<script|https?:\/\/[^" ]+\.(?:png|woff)/);
  }

  const mask = await worker.dispatchFetch("https://hearth.example/icons/safari-pinned-tab.svg");
  expect(mask.status).toBe(200);
  const svg = await mask.text();
  expect(svg).toContain('color="#000000"');
  expect(svg).not.toMatch(/#b75c35|#ce9b4c|#d7814f/);

  const ico = await worker.dispatchFetch("https://hearth.example/favicon.ico");
  expect(ico.status).toBe(200);
  expect(ico.headers.get("content-type")).toMatch(/image\/(?:x-icon|vnd.microsoft.icon)/);
  const bytes = Buffer.from(await ico.arrayBuffer());
  expect(bytes.readUInt16LE(0)).toBe(0);
  expect(bytes.readUInt16LE(2)).toBe(1);
  expect(bytes.readUInt16LE(4)).toBe(3);

  for (const [index, size] of [16, 32, 48].entries()) {
    const entry = 6 + index * 16;
    expect(bytes[entry]).toBe(size);
    expect(bytes[entry + 1]).toBe(size);
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    const frame = bytes.subarray(offset, offset + length);
    expect(frame.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(frame.readUInt32BE(16)).toBe(size);
    expect(frame.readUInt32BE(20)).toBe(size);
  }
});

it("keeps logo, favicon, manifest, kit, and sharing assets behind production authentication", async () => {
  for (const path of [
    "/favicon.svg",
    "/favicon.ico",
    "/apple-touch-icon.png",
    "/site.webmanifest",
    "/brand/logo.svg",
    "/brand/",
    "/brand/social-card.png",
  ]) {
    const response = await protectedWorker.dispatchFetch(`https://hearth.example${path}`);
    expect(response.status, path).toBe(403);
    expect(await response.text(), path).toContain("Cloudflare Access sign-in is required.");
  }
});
