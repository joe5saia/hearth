import { readFile } from "node:fs/promises";
import { defineConfig, type WorkerConfig } from "cf/config";

// Shared by Alchemy production/local deployments and native cf Previews.
export const workerRuntime = {
  main: "src/server.ts",
  compatibilityDate: "2026-09-08",
  assets: {
    directory: "./dist",
    binding: "ASSETS",
    notFoundHandling: "single-page-application",
    runWorkerFirst: true,
  },
} as const;

// Keep this nested: cf resource commands only need account settings, not a Preview build.
export default defineConfig({
  worker: async ({ isPreview, mode }) => {
    if (!isPreview || !["cf-preview", "cf-mcp-preview"].includes(mode ?? "")) {
      throw new Error("Use the Preview tasks for cf builds; Alchemy still owns production and local dev.");
    }

    const path = process.env.HEARTH_PREVIEW_CONFIG;

    if (!path) throw new Error("Run npx task preview -- up or npx task mcp:preview -- up.");

    // SAFETY: Our tools serialize WorkerConfig; cf validates the resolved configuration before building.
    return JSON.parse(await readFile(path, "utf8")) as WorkerConfig;
  },
});
