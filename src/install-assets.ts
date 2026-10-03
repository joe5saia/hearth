// Shared by the Worker and the production/Preview Access exceptions.
// Keep exact file paths: never expose /icons/* or the SPA fallback anonymously.
export const publicInstallPaths: readonly string[] = [
  "/apple-touch-icon.png",
  "/icons/apple-touch-icon-120.png",
  "/icons/apple-touch-icon-152.png",
  "/icons/apple-touch-icon-167.png",
  "/icons/apple-touch-icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/maskable-512.png",
  "/site.webmanifest",
];
