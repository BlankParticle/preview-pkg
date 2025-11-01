import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/cli.ts",
  banner: `#!/usr/bin/env node`,
  outDir: "dist",
  format: "esm",
});
