import type { CredentialStore } from "@valet/engine";

export const LINEAR_APP_SERVICE = "linear_app";

/** Organization app credentials take precedence over the deployment default. */
export async function loadLinearAppConfig(credentials: CredentialStore, orgId: string, env: NodeJS.ProcessEnv = process.env) {
  const saved = await credentials.get({ type: "org", id: orgId }, LINEAR_APP_SERVICE);
  const clientId = saved?.metadata?.clientId;
  if (typeof clientId === "string" && clientId.trim() && saved?.apiKey?.trim()) {
    return { clientId, clientSecret: saved.apiKey, source: "organization" as const };
  }
  if (env.LINEAR_CLIENT_ID?.trim() && env.LINEAR_CLIENT_SECRET?.trim()) {
    return { clientId: env.LINEAR_CLIENT_ID.trim(), clientSecret: env.LINEAR_CLIENT_SECRET.trim(), source: "deployment" as const };
  }
  return null;
}
