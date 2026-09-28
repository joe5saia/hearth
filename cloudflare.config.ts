// Shared by Alchemy production/local deployments and native Wrangler Previews.
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
