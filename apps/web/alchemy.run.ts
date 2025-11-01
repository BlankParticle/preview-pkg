import alchemy from "alchemy";
import { FileSystemStateStore, CloudflareStateStore } from "alchemy/state";
import { R2Bucket, Worker } from "alchemy/cloudflare";

const app = await alchemy("preview-pkg", {
  stateStore: (scope) =>
    scope.local
      ? new FileSystemStateStore(scope)
      : new CloudflareStateStore(scope),
});

const storageBucket = await R2Bucket("storage", {
  empty: false,
  delete: false,
});

export const worker = await Worker("worker", {
  entrypoint: "./src/app.ts",
  compatibility: "node",
  domains: ["pkg.rx2.dev"],
  bindings: {
    STORAGE: storageBucket,
  },
});

await app.finalize();
