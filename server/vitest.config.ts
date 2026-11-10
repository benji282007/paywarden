import { defineConfig } from "vitest/config";

// `npm run build` writes compiled tests to dist/; only the sources are the suite.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
