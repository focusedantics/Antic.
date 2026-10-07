import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "../playwright.config";

/**
 * Benchmarks (not part of `npm run e2e`): `npm run bench` runs memory.bench.ts (a phone
 * session with large photos, peak memory per phase) and design.bench.ts (Design's speed).
 * `BENCH_PORT` serves the app on another port, e.g. from a worktree of an older commit.
 */
const port = process.env.BENCH_PORT ?? "5174";

export default defineConfig({
  ...base,
  testDir: ".",
  testMatch: /.*\.bench\.ts/,
  timeout: 3_600_000,
  use: { ...base.use, baseURL: `http://localhost:${port}` },
  webServer: { ...base.webServer!, command: `npx vite --port ${port} --strictPort`, url: `http://localhost:${port}`, cwd: fileURLToPath(new URL("..", import.meta.url)) } as never,
});
