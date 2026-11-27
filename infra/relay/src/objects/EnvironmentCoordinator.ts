import type { AccountObject } from "./AccountObject.ts";
import type { EnvironmentObject, MachineCredential } from "./EnvironmentObject.ts";
import type { CredentialRouteObject } from "./CredentialRouteObject.ts";
import type { InventoryObject } from "./InventoryObject.ts";
import type { LinkCommand, LinkIntent, StoredLink } from "./AccountLinks.ts";
import {
  accountName,
  environmentName,
  credentialRouteName,
  inventoryShardName,
  inventoryShardNames,
} from "./names.ts";
import type { ObjectKind } from "./names.ts";
import { RPC_VERSION as version } from "./storage.ts";

export interface EnvironmentBindings {
  ACCOUNTS: DurableObjectNamespace<AccountObject>;
  ENVIRONMENTS: DurableObjectNamespace<EnvironmentObject>;
  CREDENTIAL_ROUTES: DurableObjectNamespace<CredentialRouteObject>;
  INVENTORY: DurableObjectNamespace<InventoryObject>;
}
export const activeLink = (link: StoredLink | null): link is StoredLink =>
  !!link && link.published && !link.revoked;
const candidate = (link: StoredLink, published = link.published) => ({
  userId: link.userId,
  environmentPublicKey: link.environmentPublicKey,
  generation: link.generation,
  revoked: link.revoked,
  published,
  holdWebhooksWhileOffline: link.holdWebhooksWhileOffline,
});
export class EnvironmentCoordinator {
  readonly bindings: EnvironmentBindings;
  constructor(bindings: EnvironmentBindings) {
    this.bindings = bindings;
  }
  account(userId: string) {
    return this.bindings.ACCOUNTS.getByName(accountName(userId));
  }
  environment(environmentId: string) {
    return this.bindings.ENVIRONMENTS.getByName(environmentName(environmentId));
  }
  route(tokenHash: string) {
    return this.bindings.CREDENTIAL_ROUTES.getByName(credentialRouteName("machine", tokenHash));
  }
  async register(kind: ObjectKind, name: string) {
    await this.bindings.INVENTORY.getByName(inventoryShardName(kind, name)).register({
      version,
      references: [{ kind, name }],
    });
  }
  async command(userId: string, command: LinkCommand) {
    return await this.account(userId).links({ version, userId, command });
  }
  async read(userId: string, environmentId: string) {
    return (await this.command(userId, { kind: "get", environmentId })).link;
  }
  async list(userId: string) {
    return (await this.command(userId, { kind: "list" })).links ?? [];
  }
  async owners(environmentId: string, environmentPublicKey?: string) {
    const candidates = await this.environment(environmentId).candidates({ version, environmentId });
    const links: StoredLink[] = [];
    for (const c of candidates) {
      if (
        !c.published ||
        (environmentPublicKey !== undefined && c.environmentPublicKey !== environmentPublicKey)
      )
        continue;
      const link = await this.read(c.userId, environmentId);
      if (
        activeLink(link) &&
        link.generation === c.generation &&
        link.environmentPublicKey === c.environmentPublicKey
      )
        links.push({ ...link, holdWebhooksWhileOffline: c.holdWebhooksWhileOffline });
    }
    return links;
  }
  async beginLink(intent: LinkIntent, operationId: string, now: string) {
    await this.register("account", accountName(intent.userId));
    await this.register("environment", environmentName(intent.environmentId));
    const owners = await this.owners(intent.environmentId, intent.environmentPublicKey);
    const result = await this.command(intent.userId, {
      kind: "begin",
      intent,
      operationId,
      now,
      hold: owners.some((l) => l.holdWebhooksWhileOffline),
    });
    if (!result.link) throw new Error("Missing link intent");
    return result.link;
  }
  async installCandidate(link: StoredLink) {
    const installed = await this.environment(link.environmentId).candidate({
      version,
      environmentId: link.environmentId,
      candidate: candidate(link, false),
    });
    if (!installed) throw new Error("Link candidate superseded");
  }
  async publishLink(link: StoredLink) {
    const result = await this.command(link.userId, {
      kind: "publish",
      environmentId: link.environmentId,
      operationId: link.operationId,
      generation: link.generation,
    });
    if (!result.link) throw new Error("Link publication failed");
    await this.environment(link.environmentId).candidate({
      version,
      environmentId: link.environmentId,
      candidate: candidate(result.link),
    });
    const current = await this.read(link.userId, link.environmentId);
    if (!activeLink(current) || current.generation !== link.generation)
      throw new Error("Link superseded during publication");
  }
  async publishCredential(environmentId: string, credential: MachineCredential) {
    await this.register("environment", environmentName(environmentId));
    await this.environment(environmentId).installCredential({ version, environmentId, credential });
    await this.register("credential-route", credentialRouteName("machine", credential.tokenHash));
    await this.route(credential.tokenHash).publish({ version, destination: environmentId });
    if (
      !(await this.environment(environmentId).publishCredential({
        version,
        environmentId,
        tokenHash: credential.tokenHash,
      }))
    )
      throw new Error("Credential publication failed");
  }
  async finishLink(link: StoredLink) {
    const current = await this.read(link.userId, link.environmentId);
    if (
      !current ||
      current.revoked ||
      current.operationId !== link.operationId ||
      current.generation !== link.generation
    )
      throw new Error("Link operation superseded");
    await this.installCandidate(current);
    if (current.credential)
      await this.publishCredential(current.environmentId, {
        ...current.credential,
        environmentPublicKey: current.environmentPublicKey,
        createdAt: current.updatedAt,
        link: { userId: current.userId, generation: current.generation },
      });
    await this.publishLink(current);
  }
  async upsert(intent: LinkIntent, operationId: string, now: string) {
    const link = await this.beginLink(intent, operationId, now);
    await this.finishLink(link);
  }
  async revoke(userId: string, environmentId: string, operationId: string, now: string) {
    await this.register("account", accountName(userId));
    const result = await this.command(userId, { kind: "revoke", environmentId, operationId, now });
    if (result.link?.revoked)
      await this.environment(environmentId).candidate({
        version,
        environmentId,
        candidate: candidate(result.link),
      });
    return result.changed === true;
  }
  async authenticate(tokenHash: string) {
    const environmentId = await this.route(tokenHash).resolve({ version });
    if (!environmentId) return null;
    const result = await this.environment(environmentId).credential({
      version,
      environmentId,
      tokenHash,
    });
    if (!result) return null;
    const link = await this.read(result.candidate.userId, environmentId);
    if (
      !activeLink(link) ||
      link.generation !== result.candidate.generation ||
      link.environmentPublicKey !== result.environmentPublicKey
    )
      return null;
    return {
      credentialId: result.credentialId,
      environmentId,
      environmentPublicKey: result.environmentPublicKey,
    };
  }
  async prune(updatedBefore: string) {
    // Maintenance only; authentication and account requests never read inventory.
    for (const shard of inventoryShardNames) {
      let after = "";
      for (;;) {
        const refs = await this.bindings.INVENTORY.getByName(shard).list({
          version,
          kind: "environment",
          after,
          limit: 1000,
        });
        for (const ref of refs) {
          const stub = this.bindings.ENVIRONMENTS.getByName(ref.name);
          const environmentId = await stub.owner({ version });
          if (environmentId)
            await stub.activity({
              version,
              environmentId,
              command: { kind: "prune", updatedBefore },
            });
        }
        if (refs.length < 1000) break;
        after = refs[refs.length - 1]!.name;
      }
    }
  }
}
