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
import * as prompts from "@clack/prompts";

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

const PackageManager = v.picklist(["pnpm", "bun", "yarn", "npm"]);
type PackageManager = v.InferOutput<typeof PackageManager>;

const router = t.router({
  login: t.procedure.mutation(async () => {
    await GithubCredentialsManager.login();
  }),
  // Mostly based on pkg.pr.new's publish command
  publish: t.procedure
    .input(
      v.tuple([
        v.pipe(v.optional(v.array(v.string()), []), v.description("paths")),
        v.object({
          packer: v.optional(PackageManager, detectPackageManager()),
          version: v.optional(v.string()),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      prompts.intro(
        pc.bold(pc.bgBlueBright(pc.black(" preview-pkg publish ")))
      );

      const credentials = await GithubCredentialsManager.getCredentials();
      if (!credentials) {
        prompts.log.error(
          "Please login using GitHub with `preview-pkg login` before publishing packages."
        );
        prompts.outro(pc.red("Authentication required"));
        return;
      }

      // Expand paths using glob to handle directory patterns
      const s1 = prompts.spinner();
      s1.start("Scanning for packages...");

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
        if (gitVersion.exitCode !== 0) {
          s1.stop("Failed to get Git version");
          prompts.log.error(
            "Failed to get the Git commit hash, please pass in version manually with --version flag"
          );
          prompts.outro(pc.red("Version detection failed"));
          return;
        }
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
          prompts.log.warn(`Skipping ${p}: package.json not found`);
          continue;
        }

        if (!pJson.name) {
          prompts.log.warn(`Skipping ${p}: package name not defined`);
          continue;
        }

        if (pJson.private) {
          prompts.log.warn(`Skipping ${p}: package is private`);
          continue;
        }

        if (!pJson.version) {
          prompts.log.warn(`Skipping ${p}: package version not defined`);
          continue;
        }

        packageInfos.push({ path: p, pJson });

        // Build the package URL for this package
        const packageUrl = `${API_URL_BASE}/${username}/${pJson.name}@${publishingVersion}`;
        deps.set(pJson.name, packageUrl);
      }

      s1.stop("Package scan complete");

      if (packageInfos.length === 0) {
        prompts.log.error("No valid packages found to publish");
        prompts.outro(pc.red("No packages to publish"));
        return;
      }

      prompts.note(
        [
          pc.bold(`Version: ${pc.green(publishingVersion)}`),
          pc.bold(`Package Manager: ${pc.blue(input[1].packer)}`),
          "",
          pc.bold("Packages to publish:"),
          ...packageInfos.map(
            (info) =>
              `  ${pc.cyan(info.pJson.name!)} ${pc.dim(
                `v${info.pJson.version}`
              )}`
          ),
        ].join("\n")
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
          output: string;
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

      // PASS 5: Upload all packed packages
      const uploadResults: Array<{
        pJson: PackageJson;
        packageUrl: string;
        status: "success" | "exists" | "error";
        errorMessage?: string;
      }> = [];

      await prompts.tasks(
        packedPackages.map(({ pJson, packResult }) => ({
          title: pc.bold(
            `Publishing ${pc.cyan(pJson.name!)}@${pc.green(publishingVersion)}`
          ),
          task: async (message) => {
            const packageUrl = deps.get(pJson.name!)!;

            try {
              const form = new FormData();
              form.append(
                "tarball",
                new File([packResult.file], packResult.filename)
              );
              form.append("sha256", packResult.sha256);

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
                const errorDetails = inspect(v.flatten(response.issues), {
                  depth: null,
                  colors: false,
                });
                uploadResults.push({
                  pJson,
                  packageUrl,
                  status: "error",
                  errorMessage: `Failed to parse response: ${errorDetails}`,
                });
                return pc.bold(pc.red("Failed to parse response"));
              }

              if (uploadRes.status === 409) {
                if ("sha256" in response.output) {
                  if (response.output.sha256 === packResult.sha256) {
                    uploadResults.push({ pJson, packageUrl, status: "exists" });
                    return pc.bold(pc.dim("Package already exists"));
                  } else {
                    uploadResults.push({
                      pJson,
                      packageUrl,
                      status: "error",
                      errorMessage: `Same version exists with different SHA-256 checksum\nExpected: ${response.output.sha256}\nActual: ${packResult.sha256}`,
                    });
                    return pc.bold(pc.red("Version conflict"));
                  }
                }
              }

              if (!uploadRes.ok) {
                const errorDetails = inspect(response.output, {
                  depth: null,
                  colors: false,
                });
                uploadResults.push({
                  pJson,
                  packageUrl,
                  status: "error",
                  errorMessage: errorDetails,
                });
                return pc.bold(
                  pc.red(`Upload failed: ${uploadRes.statusText}`)
                );
              }

              uploadResults.push({ pJson, packageUrl, status: "success" });
              return pc.bold(pc.green(`Published ${pJson.name!}`));
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              uploadResults.push({
                pJson,
                packageUrl,
                status: "error",
                errorMessage,
              });
              return pc.bold(pc.red(errorMessage));
            }
          },
        }))
      );

      // Display any error details
      const errorUploads = uploadResults.filter((r) => r.status === "error");
      if (errorUploads.length > 0) {
        prompts.log.info("");
        for (const { pJson, errorMessage } of errorUploads) {
          if (errorMessage) {
            prompts.log.error(`${pJson.name!}:`);
            prompts.log.info(errorMessage);
          }
        }
      }

      const successfulUploads = uploadResults.filter(
        (r) => r.status === "success"
      );
      const existingPackages = uploadResults.filter(
        (r) => r.status === "exists"
      );

      if (successfulUploads.length > 0 || existingPackages.length > 0) {
        prompts.log.info(pc.bold("Installation Commands:"));
        prompts.log.success(
          successfulUploads
            .concat(existingPackages)
            .map((r) =>
              formatInstallationCommand(r.packageUrl, input[1].packer)
            )
            .join("\n")
        );
      }

      if (successfulUploads.length > 0) {
        prompts.outro(
          pc.green(
            `✅ Successfully published ${successfulUploads.length} package${
              successfulUploads.length > 1 ? "s" : ""
            }!`
          )
        );
      } else if (existingPackages.length > 0) {
        prompts.outro(
          pc.yellow(`All packages already exist with the same content`)
        );
      } else {
        prompts.outro(pc.red("No packages were published"));
      }
    }),
});

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

  const output = (res.stdout + res.stderr).trim();

  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to pack ${cwd} with ${packageManager}${
        output ? `:\n${output}` : ""
      }`
    );
  }

  const filename = join(cwd, `${packageIdentifier}.tgz`);
  const file = await readFile(filename).catch(() => null);
  const stats = await stat(filename);
  if (!file) {
    throw new Error(
      `Pack command returned success but no output file was found, this is likely a bug`
    );
  }

  const sha256 = createHash("sha256").update(file).digest("hex");

  // Cleanup the file once we have everything we need
  if (!keepFile) await unlink(filename);

  return { filename, file, sha256, size: stats.size, output };
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

function detectPackageManager(): PackageManager {
  const packageManager = process.env.npm_config_user_agent;
  if (packageManager?.includes("pnpm")) return "pnpm";
  if (packageManager?.includes("bun")) return "bun";
  if (packageManager?.includes("yarn")) return "yarn";
  return "npm";
}

function formatInstallationCommand(
  packageUrl: string,
  packageManager: PackageManager
) {
  return [
    pc.green(packageManager),
    pc.green(packageManager === "yarn" ? "add" : "install"),
    pc.underline(pc.blue(packageUrl)),
  ].join(" ");
}

createCli({ router }).run({
  formatError(error) {
    return pc.bold(
      pc.red(error instanceof Error ? error.message : String(error))
    );
  },
});
