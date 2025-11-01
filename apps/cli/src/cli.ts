import { createCli, type TrpcCliMeta } from "trpc-cli";
import { initTRPC } from "@trpc/server";
import { GithubCredentialsManager } from "./credential-manager";
import * as v from "valibot";
import pc from "picocolors";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { x } from "tinyexec";
import { API_URL_BASE } from "./config";
import { inspect } from "node:util";
import { createHash } from "node:crypto";
import { glob } from "glob";

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: any;
};

const t = initTRPC.meta<TrpcCliMeta>().create();

const router = t.router({
  login: t.procedure.mutation(async () => {
    await GithubCredentialsManager.login();
  }),
  publish: t.procedure
    .input(
      v.tuple([
        v.pipe(v.optional(v.array(v.string()), []), v.description("paths")),
        v.object({
          packer: v.optional(
            v.picklist(["pnpm", "bun", "yarn", "npm"]),
            "pnpm"
          ),
          version: v.optional(v.string()),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      const credentials = await GithubCredentialsManager.getCredentials();
      if (!credentials)
        return console.log(
          pc.red(
            "Please login using GitHub with `preview-pkg login` before publishing packages."
          )
        );

      // Expand paths using glob to handle directory patterns
      const paths =
        input[0]?.length > 0
          ? (
              await Promise.all(
                input[0].map((pattern) =>
                  glob(pattern, {
                    withFileTypes: false,
                    absolute: true,
                  })
                )
              )
            )
              .flat()
              .filter((p) => p) // Filter out any empty results
          : [process.cwd()];

      let publishingVersion = input[1].version;
      if (!publishingVersion) {
        // Get git version first
        const gitVersion = await x(`git`, ["rev-parse", "HEAD"]);
        if (gitVersion.exitCode !== 0)
          return console.log(
            pc.red(
              "Failed to get the Git commit hash, please pass in version manually with --version flag"
            )
          );
        publishingVersion = gitVersion.stdout.trim().slice(0, 7);
      }

      const username = await GithubCredentialsManager.getUsername();

      // PASS 1: Read all package.json files and build dependency map
      const deps = new Map<string, string>();
      const packageInfos: Array<{ path: string; pJson: PackageJson }> = [];

      for (const p of paths) {
        const pJsonPath = join(p, "package.json");
        const pJson = await readPackageJson(pJsonPath);

        if (!pJson) {
          console.log(pc.yellow(`⚠️  Skipping ${p}: package.json not found`));
          continue;
        }

        if (!pJson.name) {
          console.log(pc.yellow(`⚠️  Skipping ${p}: package name not defined`));
          continue;
        }

        if (pJson.private) {
          console.log(pc.yellow(`⚠️  Skipping ${p}: package is private`));
          continue;
        }

        packageInfos.push({ path: p, pJson });

        // Build the package URL for this package
        const packageUrl = `${API_URL_BASE}/${username}/${pJson.name}@${publishingVersion}`;
        deps.set(pJson.name, packageUrl);
      }

      if (packageInfos.length === 0) {
        console.log(pc.red("No valid packages found to publish"));
        return;
      }

      console.log(
        pc.green(`🔍 Publishing version: ${pc.bold(publishingVersion)}\n`)
      );

      // PASS 2: Modify package.json files to replace workspace dependencies
      const restoreMap = new Map<string, () => Promise<void>>();

      for (const { path: p, pJson } of packageInfos) {
        const pJsonPath = join(p, "package.json");
        const originalContents = await readFile(pJsonPath, "utf-8");

        const restore = await writeDeps(
          pJsonPath,
          originalContents,
          pJson,
          deps
        );
        restoreMap.set(p, restore);
      }

      // PASS 3: Pack all packages and collect results
      const packedPackages: Array<{
        path: string;
        pJson: PackageJson;
        packageIdentifier: string;
        packResult: {
          filename: string;
          file: Buffer<ArrayBuffer>;
          sha256: string;
          size: number;
        };
      }> = [];

      for (const { path: p, pJson } of packageInfos) {
        const packageIdentifier = `${pJson
          .name!.replace("@", "")
          .replace("/", "-")}-${pJson.version}`;

        const packResult = await pack({
          packageManager: input[1].packer,
          cwd: p,
          packageIdentifier,
        });

        if (!packResult) {
          console.log(pc.red(`❌ Failed to pack ${pJson.name}`));
          continue;
        }

        console.log(
          pc.green(`📦 Packed ${packageIdentifier} with ${input[1].packer}`)
        );

        console.log(
          pc.blue(
            `   Tarball Size: ${(packResult.size / 1024 / 1024).toFixed(2)} MB`
          )
        );

        packedPackages.push({
          path: p,
          pJson,
          packageIdentifier,
          packResult,
        });
      }

      // PASS 4: Restore all package.json files
      for (const restore of restoreMap.values()) {
        await restore();
      }

      console.log(pc.green(`\n✅ All packages packed and restored\n`));

      // PASS 5: Upload all packed packages
      for (const { pJson, packResult } of packedPackages) {
        const form = new FormData();
        form.append(
          "tarball",
          new File([packResult.file], packResult.filename)
        );
        form.append("sha256", packResult.sha256);

        const packageUrl = deps.get(pJson.name!)!;

        const uploadRes = await fetch(packageUrl, {
          method: "POST",
          body: form,
          headers: {
            Authorization: `Bearer ${credentials.token}`,
          },
        });

        const response = v.safeParse(
          v.pipe(
            v.string(),
            v.parseJson(),
            v.union([
              v.looseObject({
                message: v.string(),
              }),
              v.looseObject({
                error: v.string(),
              }),
            ])
          ),
          await uploadRes.text()
        );

        if (!response.success) {
          console.log(
            pc.red(`❌ Failed to parse the response for ${pJson.name}`)
          );
          console.error(
            inspect(v.flatten(response.issues), {
              depth: null,
              colors: true,
            })
          );
          continue;
        }

        if (uploadRes.status === 409) {
          if ("sha256" in response.output) {
            if (response.output.sha256 === packResult.sha256) {
              console.log(pc.green(`🎉 ${pJson.name} already exists`));
              console.log(
                pc.bold(
                  `   ${pc.blueBright(input[1].packer)} ${
                    input[1].packer === "yarn" ? "add" : "install"
                  } ${pc.greenBright(packageUrl)}`
                )
              );
              console.log();
              continue;
            } else {
              console.log(
                pc.red(
                  `❌ ${pJson.name}: Same version exists with different SHA-256 checksum`
                )
              );
              console.error(pc.green(`   Expected: ${response.output.sha256}`));
              console.error(pc.red(`   Actual: ${packResult.sha256}`));
              console.log();
              continue;
            }
          }
        }

        if (!uploadRes.ok) {
          console.log(pc.red(`❌ Failed to upload ${pJson.name}`));
          console.error(
            inspect(response.output, {
              depth: null,
              colors: true,
            })
          );
          console.log();
          continue;
        }

        console.log(
          pc.green(`🎉 Published ${pJson.name}@${publishingVersion}`)
        );
        console.log(pc.blue(`   Tarball URL: ${pc.underline(packageUrl)}`));
        console.log(
          pc.bold(
            `   ${pc.blueBright(input[1].packer)} ${
              input[1].packer === "yarn" ? "add" : "install"
            } ${pc.greenBright(packageUrl)}`
          )
        );
        console.log();
      }
    }),
});

type PackageManager = "pnpm" | "bun" | "npm" | "yarn";

type PackOptions = {
  packageManager: PackageManager;
  cwd: string;
  packageIdentifier: string;
  keepFile?: boolean;
};

async function pack(options: PackOptions) {
  const { packageManager, cwd, packageIdentifier, keepFile = false } = options;

  const packArgs = ["pack"];

  // Bun & Yarn, the problem children
  if (packageManager === "bun") packArgs.unshift("pm");
  if (packageManager === "yarn")
    packArgs.push("--filename", `${packageIdentifier}.tgz`);

  const res = await x(packageManager, packArgs, {
    nodeOptions: { cwd, stdio: "inherit" },
  });

  if (res.exitCode !== 0) {
    console.log(pc.red(`Failed to pack ${cwd} with ${packageManager}`));
    return null;
  }

  const filename = join(cwd, `${packageIdentifier}.tgz`);
  const file = await readFile(filename).catch(() => null);
  const stats = await stat(filename);
  if (!file) {
    console.log(
      pc.red(
        `Pack command returned success but no output file was found, this is likely a bug`
      )
    );
    return null;
  }

  const sha256 = createHash("sha256").update(file).digest("hex");

  // Cleanup the file once we have everything we need
  if (!keepFile) await unlink(filename);

  return { filename, file, sha256, size: stats.size };
}

async function readPackageJson(path: string): Promise<PackageJson | null> {
  try {
    const contents = await readFile(path, "utf-8");
    return JSON.parse(contents) as PackageJson;
  } catch {
    return null;
  }
}

async function writeDeps(
  pJsonPath: string,
  originalContents: string,
  pJson: PackageJson,
  deps: Map<string, string>
) {
  // Hijack dependencies to point to our published URLs
  hijackDeps(deps, pJson.dependencies);
  hijackDeps(deps, pJson.devDependencies);
  hijackDeps(deps, pJson.optionalDependencies);

  // Write the modified package.json
  await writeFile(pJsonPath, JSON.stringify(pJson, null, 2));

  // Return a restore function that restores the original contents
  return () => writeFile(pJsonPath, originalContents);
}

function hijackDeps(
  newDeps: Map<string, string>,
  oldDeps?: Record<string, string>
) {
  if (!oldDeps) {
    return;
  }
  for (const [newDep, url] of newDeps) {
    if (newDep in oldDeps) {
      oldDeps[newDep] = url;
    }
  }
}

createCli({ router }).run({});
