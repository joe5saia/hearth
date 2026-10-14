import { readFile } from "node:fs/promises";
import { defineConfig, type WorkerConfig } from "cf/config";
import { z } from "zod";

/** Shared build/runtime settings; Alchemy retains production deployment ownership. */
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

/** Resolves only task-generated disposable Preview builds, never production deployment. */
export default defineConfig({
  /** Defers reading build state so account-only resource commands need no Preview config. */
  worker: async ({ isPreview, mode }) => {
    if (!isPreview || !["cf-preview", "cf-mcp-preview"].includes(mode ?? "")) {
      throw new Error("Use the Preview tasks for cf builds; Alchemy still owns production and local dev.");
    }

    const path = process.env.HEARTH_PREVIEW_CONFIG;

    if (!path) throw new Error("Run npx task preview -- up or npx task mcp:preview -- up.");

    const config = z
      .object({
        name: z.string().min(1),
        compatibilityDate: z.string(),
        entrypoint: z.string(),
        env: z.record(z.string(), z.object({ type: z.string() }).passthrough()),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(path, "utf8")));

    // SAFETY: cf/config exports WorkerConfig but no runtime decoder for its binding union.
    // These tools serialize WorkerConfig; required fields and binding objects are checked
    // above, and cf validates the complete config before building. Named live checks:
    // preview -- up/test and mcp:preview -- up followed by mcp:preview:test.
    return config as WorkerConfig;
  },
});
