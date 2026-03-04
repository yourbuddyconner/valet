/**
 * 1Password secrets provider — resolves op:// references using the 1Password SDK.
 *
 * This is the only file that imports @1password/sdk. It implements SecretsProvider
 * so the rest of the system is provider-agnostic.
 */

import type { SecretsProvider, SecretListEntry } from "./secrets.js";

// Lazy-imported SDK types (matches @1password/sdk v0.3.x)
type OPClient = {
  secrets: { resolve: (ref: string) => Promise<string> };
  vaults: { list: () => Promise<{ id: string; title: string }[]> };
  items: { list: (vaultId: string) => Promise<{ id: string; title: string; vaultId: string }[]> };
};

let clientInstance: OPClient | null = null;
let initFailed = false;

export class OnePasswordProvider implements SecretsProvider {
  readonly name = "1password";
  readonly referencePattern = /op:\/\/[^\s"'}\]]+/g;

  async initialize(): Promise<void> {
    if (clientInstance) return;
    if (initFailed) throw new Error("1Password SDK initialization previously failed");

    const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    if (!token) {
      throw new Error("OP_SERVICE_ACCOUNT_TOKEN is not set");
    }

    try {
      const sdk = await import("@1password/sdk");
      clientInstance = await sdk.createClient({
        auth: token,
        integrationName: "Valet Runner",
        integrationVersion: "1.0.0",
      }) as unknown as OPClient;
    } catch (err) {
      initFailed = false; // Allow retries
      throw err;
    }
  }

  async listSecrets(options?: { vaultId?: string }): Promise<SecretListEntry[]> {
    if (!clientInstance) await this.initialize();
    const client = clientInstance!;

    const entries: SecretListEntry[] = [];

    if (options?.vaultId) {
      await this.listVaultItems(client, options.vaultId, entries);
    } else {
      const vaults = await client.vaults.list();
      for (const vault of vaults) {
        await this.listVaultItems(client, vault.id, entries, vault.title);
      }
    }

    return entries;
  }

  private async listVaultItems(
    client: OPClient,
    vaultId: string,
    entries: SecretListEntry[],
    vaultTitle?: string,
  ): Promise<void> {
    const resolvedTitle = vaultTitle || vaultId;

    const items = await client.items.list(vaultId);
    for (const item of items) {
      entries.push({
        provider: this.name,
        vault: resolvedTitle,
        item: item.title,
        reference: `op://${resolvedTitle}/${item.title}`,
      });
    }
  }

  async resolveSecret(reference: string): Promise<string> {
    if (!clientInstance) await this.initialize();
    return clientInstance!.secrets.resolve(reference);
  }
}
