import path from "node:path";
import os from "node:os";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import * as v from "valibot";
import pc from "picocolors";
import * as prompts from "@clack/prompts";
import { GITHUB_CLIENT_ID } from "./config";
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device";
import open from "open";
import { Octokit } from "octokit";

export const GithubOAuthAppAuthentication = v.object({
  clientId: v.string(),
  scopes: v.array(v.string()),
  token: v.string(),
});
export type GithubOAuthAppAuthentication = v.InferOutput<
  typeof GithubOAuthAppAuthentication
>;

export class GithubCredentialsManager {
  static credentialPath = path.join(
    os.homedir(),
    ".config",
    "preview-pkg",
    "github-credentials.json"
  );
  static spinner = prompts.spinner();

  static auth = createOAuthDeviceAuth({
    clientId: GITHUB_CLIENT_ID,
    clientType: "oauth-app",
    scopes: ["read:user", "user:email"],
    onVerification: async (verification) => {
      console.log();
      prompts.intro(
        pc.greenBright("Login with GitHub using Device Flow authentication")
      );
      prompts.log.info(
        `Use this code to login with GitHub: ${pc.bold(
          pc.blueBright(verification.user_code)
        )}`
      );
      prompts.note(
        `Open this URL in your browser: ${pc.underline(
          verification.verification_uri
        )}`
      );
      const shouldOpen = await prompts.confirm({
        message: `Do you want to open your default browser to login with GitHub?`,
        active: "Yes",
        inactive: "No",
      });
      if (prompts.isCancel(shouldOpen)) return process.exit(0);
      if (shouldOpen) await open(verification.verification_uri);
      this.spinner.start("Waiting for authentication...");
    },
  });

  static async getCredentials(): Promise<GithubOAuthAppAuthentication | null> {
    const credentials = await readFile(this.credentialPath, "utf-8").catch(
      () => null
    );
    if (!credentials) return null;
    const parsed = v.safeParse(
      v.pipe(v.string(), v.parseJson(), GithubOAuthAppAuthentication),
      credentials
    );
    if (!parsed.success) {
      console.warn(
        pc.yellow(
          "Failed to parse GitHub credentials, credentials may be corrupted, removing file..."
        )
      );
      await unlink(this.credentialPath).catch(() => {});
      return null;
    }
    return parsed.output;
  }

  static async saveCredentials(
    credentials: GithubOAuthAppAuthentication
  ): Promise<void> {
    await mkdir(path.dirname(this.credentialPath), { recursive: true }).catch(
      (error) => {
        console.warn(
          pc.yellow(
            "Failed to create directory for GitHub credentials, credentials will not be saved"
          )
        );
        console.error(error instanceof Error ? error.message : String(error));
      }
    );
    await writeFile(
      this.credentialPath,
      JSON.stringify(credentials, null, 2)
    ).catch((error) => {
      console.warn(
        pc.yellow(
          `Failed to save GitHub credentials at ${this.credentialPath}, please make sure you have permissions to write to this file`
        )
      );
      console.error(error instanceof Error ? error.message : String(error));
    });
  }

  static async login(): Promise<{
    username: string;
    token: string;
  }> {
    const tokens = await this.auth({ type: "oauth" })
      .catch((error) => {
        console.error(
          pc.red(
            `Failed to login with GitHub: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
        throw error;
      })
      .finally(() => {
        this.spinner.stop("Authenticated with GitHub!");
      });
    const username = await this.getUsername();
    await this.saveCredentials({
      clientId: tokens.clientId,
      scopes: tokens.scopes,
      token: tokens.token,
    });
    prompts.outro(`Logged in as ${pc.bold(pc.greenBright(username))}!`);
    return {
      username,
      token: tokens.token,
    };
  }

  static async getOctokit(): Promise<Octokit> {
    const credentials = await this.getCredentials();
    if (!credentials) throw new Error("No credentials found");
    return new Octokit({ auth: credentials.token });
  }

  static async getUsername(): Promise<string> {
    const octokit = await this.getOctokit();
    const user = await octokit.rest.users.getAuthenticated();
    return user.data.login;
  }
}
