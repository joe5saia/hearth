import { defineConfig } from "vitest/config";

/** Discovers the repository's local integration smoke suites without deploying cloud resources. */
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } });
