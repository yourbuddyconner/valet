import type { CredentialStore } from "@valet/engine";
import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { linearInstallations } from "../schema/index.js";
import type { GetLinearConnectionResponse } from "../wire/types.js";

/** Event ingress uses the organization OAuth connection, never a personal MCP connection. */
export async function getLinearIngressStatus(
  db: AppDb, credentials: CredentialStore, orgId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<GetLinearConnectionResponse> {
  const [[install], credential] = await Promise.all([
    db.select().from(linearInstallations).where(eq(linearInstallations.orgId,orgId)).limit(1),
    credentials.get({ type: "org", id: orgId },"linear"),
  ]);
  const configured = !!env.LINEAR_CLIENT_ID?.trim() && !!env.LINEAR_CLIENT_SECRET?.trim();
  const secret = credential?.metadata?.webhookSecret;
  const webhookConfigured = typeof install?.webhookId === "string" && !!install.webhookId.trim()
    && typeof secret === "string" && !!secret.trim();
  const connected = credential !== null && install !== undefined;
  const workspaceMatches = !credential?.metadata?.workspaceId || credential.metadata.workspaceId === install?.workspaceId;
  const ready = connected && webhookConfigured && workspaceMatches;
  const reason = ready ? undefined : !configured
    ? "Ask your operator to configure Linear OAuth. Then connect Linear in Organization settings > Linear events."
    : !connected
      ? "Ask an organization admin to connect Linear in Organization settings > Linear events. Personal connections only enable tools."
      : "Ask an organization admin to reconnect Linear in Organization settings > Linear events to restore the event webhook.";
  return { configured, connected, webhookConfigured, ready, ...(install ? { workspaceName: install.workspaceName } : {}), ...(reason ? { reason } : {}) };
}

export async function linearEventArmBlock(
  db: AppDb, credentials: CredentialStore, orgId: string, eventKeys: readonly string[],
): Promise<string | undefined> {
  if (!eventKeys.some(key => key.startsWith("linear."))) return undefined;
  const status = await getLinearIngressStatus(db,credentials,orgId);
  return status.ready ? undefined : status.reason;
}
