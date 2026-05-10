import type {
  CredentialOwner,
  CredentialStore,
  StoredCredential,
} from "../../types.js";

function key(owner: CredentialOwner, service: string): string {
  return `${owner.type}:${owner.id}:${service}`;
}

export class InMemoryCredentialStore implements CredentialStore {
  private creds = new Map<string, { credential: StoredCredential; connectedAt: string }>();

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    return this.creds.get(key(owner, service))?.credential ?? null;
  }

  async save(
    owner: CredentialOwner,
    service: string,
    credential: StoredCredential,
  ): Promise<void> {
    this.creds.set(key(owner, service), { credential, connectedAt: new Date().toISOString() });
  }

  async delete(owner: CredentialOwner, service: string): Promise<void> {
    this.creds.delete(key(owner, service));
  }

  async list(
    owner: CredentialOwner,
  ): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    const prefix = `${owner.type}:${owner.id}:`;
    const result: { service: string; scopes?: string[]; connectedAt: string }[] = [];
    for (const [k, v] of this.creds) {
      if (k.startsWith(prefix)) {
        result.push({
          service: k.slice(prefix.length),
          scopes: v.credential.scopes,
          connectedAt: v.connectedAt,
        });
      }
    }
    return result;
  }
}
