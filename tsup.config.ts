import { defineConfig } from "tsup";

/**
 * No runtime dependencies. Three outputs:
 *
 * - `dist/cli.js`, the `restoreproof` command;
 * - `dist/index.js`, the library;
 * - `dist/drill.js`, the drill alone, which `init` copies into the customer's repo as
 *   `.github/restoreproof/drill.mjs`. It is not minified, so the file a customer reviews reads like
 *   the source it came from.
 */
export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts", drill: "src/drill-entry.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: false,
  clean: true,
  splitting: false,
  minify: false,
});
