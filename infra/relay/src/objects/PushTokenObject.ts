// @effect-diagnostics cryptoRandomUUID:off - Durable Object incarnation and retirement tickets are synchronous native state.
import { DurableObject } from "cloudflare:workers";
import { pushTokenName } from "./names.ts";
import { canonicalJson, checkRpc, migrate, summarize } from "./storage.ts";
import {
  normalizedTokenReference,
  tokenClaimDigest,
  tokenPreparationDigest,
} from "./TokenProtocol.ts";
import type {
  TokenReference,
  TokenPreparation,
  TokenRetirement,
  SuccessfulTokenClaim,
  TokenLoss,
} from "./TokenProtocol.ts";
export type { TokenReference, TokenKind } from "./TokenProtocol.ts";

const migrations = [
  `CREATE TABLE token_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation INTEGER NOT NULL, owner TEXT);
   CREATE TABLE token_claims (operation_id TEXT PRIMARY KEY, request TEXT NOT NULL, applied INTEGER NOT NULL, lost_at TEXT)`,
  "ALTER TABLE token_claims ADD COLUMN state TEXT NOT NULL DEFAULT 'settled'; CREATE TABLE token_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value TEXT NOT NULL)",
];
type Metadata = {
  incarnation: string;
  epoch: number;
  published: boolean;
  lastClaim: SuccessfulTokenClaim | null;
  retirement: TokenRetirement | null;
  losses?: TokenLoss[];
  unrecoverableLosses?: true;
};
type Receipt = {
  request: string;
  applied: number;
  lost_at: string | null;
  state: "pending" | "settled" | "rejected";
};

export class PushTokenObject extends DurableObject<unknown> {
  private initialization = crypto.randomUUID();
  private coldIncarnation = crypto.randomUUID();
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized()) return;
      this.ctx.storage.transactionSync(() => {
        migrate(ctx.storage, migrations);
        const existing = this.metadata();
        if (existing) {
          if (existing.losses === undefined) {
            const unknown =
              this.ctx.storage.sql
                .exec(
                  "SELECT 1 FROM token_claims WHERE applied = 1 AND lost_at IS NOT NULL LIMIT 1",
                )
                .toArray().length > 0;
            this.saveMetadata({
              ...existing,
              losses: [],
              ...(unknown ? { unrecoverableLosses: true } : {}),
            });
          }
          return;
        }
        let last: TokenReference | null = null;
        const losses: TokenLoss[] = [];
        const rows = this.ctx.storage.sql
          .exec<Receipt & { operation_id: string }>("SELECT * FROM token_claims")
          .toArray();
        for (const row of rows) {
          const previous = JSON.parse(row.request) as {
            reference: TokenReference;
            expected: number;
          };
          const reference = normalizedTokenReference(previous.reference);
          if (row.applied && row.lost_at)
            losses.push({ id: tokenClaimDigest(reference), reference, at: row.lost_at });
          this.ctx.storage.sql.exec(
            "UPDATE token_claims SET request = ? WHERE operation_id = ?",
            tokenPreparationDigest(reference, previous.expected),
            row.operation_id,
          );
          if (row.applied && (!last || reference.generation > last.generation)) last = reference;
        }
        const owner = this.owner();
        if (owner.owner) {
          last = normalizedTokenReference(owner.owner);
          this.ctx.storage.sql.exec("UPDATE token_owner SET owner = ?", canonicalJson(last));
        }
        this.saveMetadata({
          incarnation: "legacy",
          epoch: 0,
          published: false,
          retirement: null,
          losses,
          lastClaim: last
            ? {
                digest: tokenClaimDigest(last),
                incarnation: "legacy",
                epoch: 0,
                generation: last.generation,
              }
            : null,
        });
      });
    });
  }
  private initialized() {
    return (
      this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'token_owner'")
        .toArray().length > 0
    );
  }
  private metadata() {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM token_metadata")
      .toArray()[0];
    return row ? (JSON.parse(row.value) as Metadata) : null;
  }
  private saveMetadata(value: Metadata) {
    this.ctx.storage.sql.exec(
      "INSERT INTO token_metadata VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET value = excluded.value",
      canonicalJson(value),
    );
  }
  private owner() {
    if (!this.initialized()) return { generation: 0, owner: null as TokenReference | null };
    const row = this.ctx.storage.sql
      .exec<{ generation: number; owner: string | null }>(
        "SELECT generation, owner FROM token_owner",
      )
      .toArray()[0];
    return {
      generation: row?.generation ?? 0,
      owner: row?.owner ? (JSON.parse(row.owner) as TokenReference) : null,
    };
  }
  private receipt(reference: TokenReference) {
    return this.ctx.storage.sql
      .exec<Receipt>(
        "SELECT request, applied, lost_at, state FROM token_claims WHERE operation_id = ?",
        reference.operationId,
      )
      .toArray()[0];
  }
  private check(reference: TokenReference) {
    if (this.ctx.id.name !== pushTokenName(reference.kind, reference.token))
      throw new Error("Push token identity mismatch");
  }
  private matches(left: TokenReference | null, right: TokenReference) {
    return (
      !!left &&
      canonicalJson(normalizedTokenReference(left)) ===
        canonicalJson(normalizedTokenReference(right))
    );
  }
  async read(request: { version: number }) {
    checkRpc(request.version);
    const initialized = this.initialized();
    const meta = initialized ? this.metadata()! : null;
    return {
      ...this.owner(),
      initialized,
      incarnation: meta?.incarnation ?? this.coldIncarnation,
      initialization: initialized ? null : this.initialization,
      epoch: meta?.epoch ?? null,
      published: meta?.published ?? false,
      retirement: meta?.retirement ?? null,
      lastClaim: meta?.lastClaim ?? null,
      pendingLoss: meta?.losses?.[0] ?? null,
    };
  }
  async status(request: { version: number; reference: TokenReference }) {
    checkRpc(request.version);
    this.check(request.reference);
    const current = this.owner();
    const receipt = this.initialized() ? this.receipt(request.reference) : null;
    return {
      live: this.matches(current.owner, request.reference),
      lostAt:
        receipt?.request ===
        tokenPreparationDigest(request.reference, request.reference.generation - 1)
          ? receipt.lost_at
          : null,
    };
  }
  async prepare(request: { version: number; preparation: TokenPreparation }) {
    checkRpc(request.version);
    const ticket = request.preparation;
    const reference = normalizedTokenReference(ticket.reference);
    this.check(reference);
    if (
      !Number.isSafeInteger(ticket.expected) ||
      ticket.expected < 0 ||
      reference.generation !== ticket.expected + 1
    )
      throw new Error("Push token generation mismatch");
    if (
      !this.initialized() &&
      (ticket.initialization !== this.initialization ||
        reference.incarnation !== this.coldIncarnation ||
        ticket.epoch === null)
    )
      return { state: "stale" } as const;
    return this.ctx.storage.transactionSync(() => {
      if (!this.initialized()) {
        migrate(this.ctx.storage, migrations);
        this.saveMetadata({
          incarnation: reference.incarnation,
          epoch: ticket.epoch!,
          published: false,
          lastClaim: null,
          retirement: null,
          losses: [],
        });
      }
      const meta = this.metadata()!;
      if (
        meta.incarnation !== reference.incarnation ||
        (meta.epoch !== 0 && meta.epoch !== ticket.epoch)
      )
        return { state: "stale" } as const;
      if (meta.retirement) return { state: "retiring", retirement: meta.retirement } as const;
      if (meta.epoch === 0 && ticket.epoch !== null)
        this.saveMetadata({ ...meta, epoch: ticket.epoch });
      const digest = tokenPreparationDigest(reference, ticket.expected);
      const old = this.receipt(reference);
      if (old && old.request !== digest) throw new Error("Push token intent mismatch");
      if (old?.state === "rejected") return { state: "rejected" } as const;
      if (!old)
        this.ctx.storage.sql.exec(
          "INSERT INTO token_claims VALUES (?, ?, 0, NULL, 'pending')",
          reference.operationId,
          digest,
        );
      return { state: "prepared" } as const;
    });
  }
  async publish(request: { version: number; incarnation: string; epoch: number }) {
    checkRpc(request.version);
    if (!this.initialized()) return false;
    const meta = this.metadata()!;
    if (
      meta.retirement ||
      meta.incarnation !== request.incarnation ||
      (meta.epoch !== 0 && meta.epoch !== request.epoch)
    )
      return false;
    this.saveMetadata({
      ...meta,
      epoch: request.epoch,
      published: true,
      lastClaim: meta.lastClaim ? { ...meta.lastClaim, epoch: request.epoch } : null,
    });
    return true;
  }
  async acknowledgeLoss(request: { version: number; incarnation: string; id: string }) {
    checkRpc(request.version);
    if (!this.initialized()) return false;
    const meta = this.metadata()!;
    if (meta.incarnation !== request.incarnation || meta.losses?.[0]?.id !== request.id)
      return false;
    this.saveMetadata({ ...meta, losses: meta.losses.slice(1) });
    return true;
  }
  async transfer(request: {
    version: number;
    reference: TokenReference;
    expected: number;
    now: string;
    registered?: true;
  }) {
    checkRpc(request.version);
    const reference = normalizedTokenReference(request.reference);
    this.check(reference);
    if (reference.generation !== request.expected + 1)
      throw new Error("Push token generation mismatch");
    if (!this.initialized()) return { applied: false, stale: true } as const;
    return this.ctx.storage.transactionSync(() => {
      const meta = this.metadata()!;
      if (meta.incarnation !== reference.incarnation)
        return { applied: false, stale: true } as const;
      if (meta.unrecoverableLosses) return { unsupportedHistory: true } as const;
      if (meta.losses?.length) return { pendingLoss: meta.losses[0]! } as const;
      const receipt = this.receipt(reference);
      if (!receipt) return { applied: false, stale: true } as const;
      if (receipt.request !== tokenPreparationDigest(reference, request.expected))
        throw new Error("Push token intent mismatch");
      if (receipt.state === "rejected") return { applied: false };
      if (receipt.state === "settled") return { applied: !!receipt.applied };
      if (!meta.published) return { unpublished: true } as const;
      if (meta.retirement) return { retiring: meta.retirement } as const;
      const current = this.owner();
      const applied = current.generation === request.expected;
      this.ctx.storage.sql.exec(
        "UPDATE token_claims SET applied = ?, state = 'settled' WHERE operation_id = ?",
        Number(applied),
        reference.operationId,
      );
      if (applied) {
        if (current.owner)
          this.ctx.storage.sql.exec(
            "UPDATE token_claims SET lost_at = coalesce(lost_at, ?) WHERE operation_id = ?",
            request.now,
            current.owner.operationId,
          );
        this.ctx.storage.sql.exec(
          "INSERT INTO token_owner VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation, owner = excluded.owner",
          reference.generation,
          canonicalJson(reference),
        );
        this.saveMetadata({
          ...meta,
          lastClaim: {
            digest: tokenClaimDigest(reference),
            incarnation: reference.incarnation,
            epoch: meta.epoch,
            generation: reference.generation,
          },
        });
      }
      if (applied && current.owner) {
        const pendingLoss: TokenLoss = {
          id: tokenClaimDigest(current.owner),
          reference: current.owner,
          at: request.now,
        };
        this.saveMetadata({ ...this.metadata()!, losses: [pendingLoss] });
        return { applied, pendingLoss };
      }
      return { applied };
    });
  }
  async cancel(request: {
    version: number;
    reference: TokenReference;
    expected: number;
    now: string;
    initialization?: string | null;
  }) {
    checkRpc(request.version);
    const reference = normalizedTokenReference(request.reference);
    this.check(reference);
    if (!this.initialized()) {
      if (reference.incarnation === this.coldIncarnation) {
        this.initialization = crypto.randomUUID();
        this.coldIncarnation = crypto.randomUUID();
      }
      return { absent: true, invalidated: true } as const;
    }
    return this.ctx.storage.transactionSync(() => {
      const meta = this.metadata()!;
      if (meta.incarnation !== reference.incarnation) return { stale: true } as const;
      if (meta.retirement) return { retiring: meta.retirement } as const;
      if (meta.unrecoverableLosses && this.matches(this.owner().owner, reference))
        return { unsupportedHistory: true } as const;
      if (meta.losses?.length && this.matches(this.owner().owner, reference))
        return { pendingLoss: meta.losses[0]! } as const;
      const old = this.receipt(reference);
      const digest = tokenPreparationDigest(reference, request.expected);
      if (old && old.request !== digest) throw new Error("Push token intent mismatch");
      this.ctx.storage.sql.exec(
        "INSERT INTO token_claims VALUES (?, ?, 0, NULL, 'rejected') ON CONFLICT(operation_id) DO UPDATE SET state = 'rejected'",
        reference.operationId,
        digest,
      );
      const released = this.matches(this.owner().owner, reference);
      if (released) {
        this.ctx.storage.sql.exec(
          "UPDATE token_claims SET lost_at = coalesce(lost_at, ?) WHERE operation_id = ?",
          request.now,
          reference.operationId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE token_owner SET generation = generation + 1, owner = NULL",
        );
      }
      return { released };
    });
  }
  async clear(request: { version: number; reference: TokenReference; now: string }) {
    const result = await this.cancel({ ...request, expected: request.reference.generation - 1 });
    return "released" in result && result.released;
  }
  async fence(request: {
    version: number;
    reference: TokenReference;
    expected: number;
    now: string;
    registered?: true;
  }) {
    await this.cancel(request);
    return { fenced: true } as const;
  }
  async freeze(request: {
    version: number;
    incarnation: string;
    expiresAt: string;
    admissionExpiresAt: string;
  }) {
    checkRpc(request.version);
    if (!this.initialized()) return { absent: true } as const;
    return this.ctx.storage.transactionSync(() => {
      const meta = this.metadata()!;
      if (meta.incarnation !== request.incarnation) return { stale: true } as const;
      if (meta.retirement) return { retirement: meta.retirement };
      if (meta.unrecoverableLosses) return { unsupportedHistory: true } as const;
      if (meta.losses?.length) return { pendingLoss: meta.losses[0]! } as const;
      if (
        this.owner().owner ||
        this.ctx.storage.sql
          .exec("SELECT 1 FROM token_claims WHERE state = 'pending' LIMIT 1")
          .toArray().length
      )
        return { busy: true } as const;
      if (!meta.published) return { unpublished: true } as const;
      const retirement: TokenRetirement = {
        incarnation: meta.incarnation,
        epoch: meta.epoch,
        generation: this.owner().generation,
        id: crypto.randomUUID(),
        lastClaim: meta.lastClaim,
        expiresAt: request.expiresAt,
        admissionExpiresAt: request.admissionExpiresAt,
      };
      this.saveMetadata({ ...meta, retirement });
      return { retirement };
    });
  }
  async retire(request: { version: number; retirement: TokenRetirement }) {
    checkRpc(request.version);
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized()) return true;
      const meta = this.metadata()!;
      if (
        meta.incarnation !== request.retirement.incarnation ||
        meta.epoch !== request.retirement.epoch ||
        meta.retirement?.id !== request.retirement.id
      )
        return false;
      this.initialization = crypto.randomUUID();
      this.coldIncarnation = crypto.randomUUID();
      await this.ctx.storage.deleteAll();
      return true;
    });
  }
  async inventory(request: { version: number }) {
    checkRpc(request.version);
    const initialized = this.initialized();
    return {
      version: request.version,
      schemaVersion: initialized ? migrations.length : 0,
      tables: [
        summarize(
          "token_owner",
          initialized ? this.ctx.storage.sql.exec("SELECT * FROM token_owner") : [],
        ),
        summarize(
          "token_claims",
          initialized
            ? this.ctx.storage.sql.exec("SELECT * FROM token_claims ORDER BY operation_id")
            : [],
        ),
        summarize(
          "token_metadata",
          initialized ? this.ctx.storage.sql.exec("SELECT * FROM token_metadata") : [],
        ),
      ],
    };
  }
}
