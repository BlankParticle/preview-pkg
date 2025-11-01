import { Hono } from "hono";
import type { worker } from "../alchemy.run";
import { vValidator } from "@hono/valibot-validator";
import * as v from "valibot";
import { Octokit } from "octokit";

export type HonoCtx = {
  Bindings: typeof worker.Env;
};

const app = new Hono<HonoCtx>();

app.get("/", (c) => c.redirect("https://github.com/BlankParticle/preview-pkg"));

const LowercaseAlphaNumericWithDashRegex = v.regex(/^[a-z0-9-]+$/);
const MixedCaseAlphaNumericWithDashRegex = v.regex(/^[a-zA-Z0-9-]+$/);

const GithubUsername = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.maxLength(39),
  MixedCaseAlphaNumericWithDashRegex
);
const PackageInfo = v.object({
  org: v.optional(
    v.pipe(
      v.string(),
      v.nonEmpty(),
      v.maxLength(32),
      LowercaseAlphaNumericWithDashRegex
    )
  ),
  packageName: v.pipe(
    v.string(),
    v.nonEmpty(),
    v.maxLength(32),
    LowercaseAlphaNumericWithDashRegex
  ),
  version: v.pipe(
    v.string(),
    v.nonEmpty(),
    v.maxLength(32),
    LowercaseAlphaNumericWithDashRegex
  ),
});

const PackageParams = v.object({
  // Github username
  username: GithubUsername,
  // Package in format package-name@version or @org/package-name@version
  package: v.pipe(
    v.string(),
    v.transform((str) => {
      if (str.startsWith("@")) {
        const [org, name] = str.split("/");
        const [packageName, version] = name.split("@");
        return { org: org?.slice(1), packageName, version };
      } else {
        const [packageName, version] = str.split("@");
        return { packageName, version };
      }
    }),
    PackageInfo
  ),
});

type StorageKeyArgs = {
  username: string;
  org?: string;
  packageName: string;
  version: string;
};

const storageKey = (args: StorageKeyArgs) => {
  const { username, org, packageName, version } = args;
  return `preview-pkg/${username}/${
    org ? `@${org}__${packageName}` : packageName
  }@${version}`;
};

const validatePackageParams = vValidator(
  "param",
  PackageParams,
  (result, c) => {
    if (!result.success)
      return c.json(
        {
          error: "Invalid package format",
          issues: v.flatten(result.issues),
        },
        400
      );
  }
);

app.get("/:username/:package{.+}", validatePackageParams, async (c) => {
  const {
    username,
    package: { org, packageName, version },
  } = c.req.valid("param");

  const packageKey = storageKey({ username, org, packageName, version });
  const packageInfo = await c.env.STORAGE.head(packageKey);
  if (!packageInfo) return c.json({ error: "Package not found" }, 404);

  const packageBody = await c.env.STORAGE.get(packageKey);
  if (!packageBody) return c.json({ error: "Package not found" }, 404);
  c.header("Content-Type", "application/tar+gzip");

  return c.body(packageBody.body, 200);
});

app.post(
  "/:username/:package{.+}",
  validatePackageParams,
  vValidator(
    "form",
    v.object({
      tarball: v.pipe(
        v.file(),
        v.maxSize(1024 * 1024 * 10, `Maximum package size is 10MB`)
      ),
      sha256: v.pipe(v.string(), v.length(64)),
    }),
    (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: "Invalid package format",
            issues: v.flatten(result.issues),
          },
          400
        );
    }
  ),
  vValidator("header", v.object({ authorization: v.string() })),
  async (c) => {
    const {
      username,
      package: { org, packageName, version },
    } = c.req.valid("param");
    const { tarball, sha256 } = c.req.valid("form");

    const octokit = new Octokit({ auth: c.req.header("Authorization") });
    const authUser = await octokit.rest.users.getAuthenticated();

    if (authUser.data.login !== username) {
      return c.json(
        {
          error: `Unauthorized: You are trying to publish a package for ${username} but you are logged in as ${authUser.data.login}`,
        },
        401
      );
    }

    const packageKey = storageKey({ username, org, packageName, version });
    const existingPackage = await c.env.STORAGE.head(packageKey);

    if (existingPackage && existingPackage.checksums.sha256)
      return c.json(
        {
          error: `Package ${
            org ? `@${org}/` : ""
          }${packageName}@${version} already exists`,
          sha256: Buffer.from(existingPackage.checksums.sha256).toString("hex"),
        },
        409
      );

    const res = await c.env.STORAGE.put(
      packageKey,
      await tarball.arrayBuffer(),
      {
        customMetadata: { org: org ?? "", packageName, version },
        sha256,
      }
    ).catch((error) =>
      error instanceof Error ? error : new Error(String(error))
    );

    if (res instanceof Error) {
      if (res.message.includes("SHA-256")) {
        return c.json({ error: "Invalid SHA-256 checksum" }, 400);
      } else {
        return c.json({ error: "Failed to upload package to storage" }, 500);
      }
    }

    return c.json({ message: "Package created" }, 201);
  }
);

export default app;
