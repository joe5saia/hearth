import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(["cf-preview", "cf-mcp-preview"].includes(mode) ? [cloudflare({ types: { generate: false } })] : []),
  ],
  publicDir: mode === "cf-mcp-preview" ? false : "public",
  builder:
    mode === "cf-mcp-preview"
      ? {
          async buildApp(builder) {
            // MCP has no website assets; do not upload the React client or public directory.
            for (const [name, environment] of Object.entries(builder.environments)) {
              if (name !== "client") await builder.build(environment);
            }
          },
        }
      : undefined,
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: [".onamp.dev", "localhost"],
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
}));
