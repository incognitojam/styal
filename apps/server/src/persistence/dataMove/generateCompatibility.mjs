// The fixture must use the source checkout's own Effect version, including its arbitrary hooks.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeZlib from "node:zlib";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
const root = NodeFS.realpathSync(process.argv[2]);
const output = process.argv[3];
if (
  NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim() !== "68e0ea592ac9a2262d04f2457d83e3f21d73ac73"
)
  throw new Error("Unrecognised source revision");
const r = NodeModule.createRequire(root + "/apps/server/package.json");
const imp = (n) => import(NodeURL.pathToFileURL(r.resolve(n)));
const S = await imp("effect/Schema"),
  AST = await imp("effect/SchemaAST"),
  E = await imp("effect/Effect"),
  A = await imp("effect/Arbitrary");
const C = await import(NodeURL.pathToFileURL(root + "/packages/contracts/src/index.ts"));
const cache = new Map(),
  obligations = new Set(),
  covered = new Set();
const key = (p, t) => p.join(".") + " / " + t;
const clean = (a) => AST.replaceContext(a, undefined);
const is = (a, v) => S.is(S.make(clean(a)))(v);
async function leaf(a) {
  if (a._tag === "Unknown" || a._tag === "Any")
    return { syntheticOpaque: { items: [1, "synthetic", null] } };
  const candidates =
    a._tag === "String"
      ? [
          "synthetic",
          "data:image/png;base64,c3ludGhldGlj",
          "{{body.id}}",
          "body.id",
          "image/png",
          "synthetic-id",
          "2026-01-01T00:00:00.000Z",
          "00:00",
          "UTC",
          "00000000-0000-4000-8000-000000000000",
          "https://example.test/synthetic",
          "synthetic/path",
          "a".repeat(64),
        ]
      : a._tag === "Number"
        ? [1, 0, 60000, 100, 1024]
        : [null, false, {}, [], "synthetic"];
  for (const v of candidates) if (is(a, v)) return v;
  try {
    return (
      await E.runPromise(
        A.sampleEffect(A.schema(S.make(clean(a))), {
          count: 1,
          size: 1,
          seed: 42,
          maxDiscards: 2000,
        }),
      )
    )[0];
  } catch {
    throw new Error("No synthetic leaf " + a._tag + " " + JSON.stringify(a.checks));
  }
}
async function base(a, seen = new Set()) {
  a = clean(a);
  if (cache.has(a)) return cache.get(a);
  let v;
  if (a._tag === "Literal") v = a.literal;
  else if (a._tag === "Null") v = null;
  else if (a._tag === "Boolean") v = false;
  else if (a._tag === "Union")
    v = await base(a.types.find((t) => t._tag === "Null") ?? a.types[0], seen);
  else if (a._tag === "Objects") {
    v = {};
    for (const p of a.propertySignatures)
      try {
        v[p.name] = await base(p.type, seen);
      } catch (e) {
        throw new Error(p.name + " > " + e.message, { cause: e });
      }
  } else if (a._tag === "Arrays") {
    v = [];
    for (const e of a.elements) v.push(await base(e, seen));
    if (!is(a, v) && a.rest.length) v.push(await base(a.rest[0], seen));
  } else if (a._tag === "Suspend") {
    if (seen.has(a)) throw new Error("Required recursive value");
    v = await base(a.thunk(), new Set([...seen, a]));
  } else v = await leaf(a);
  if (!is(a, v)) {
    try {
      v = await leaf(a);
    } catch {
      throw new Error("Invalid synthetic base " + a._tag);
    }
  }
  cache.set(a, v);
  return v;
}
async function variants(a, path = [], seen = new Set()) {
  const original = a;
  a = clean(a);
  const b = await base(a);
  const out = [{ value: b, covers: [] }];
  if (seen.has(original)) return out;
  const next = new Set([...seen, original]);
  if (a._tag === "Union") {
    for (let i = 0; i < a.types.length; i++) {
      const id = key(path, "union:" + i);
      obligations.add(id);
      for (const v of await variants(a.types[i], path, next))
        out.push({ value: v.value, covers: [id, ...v.covers] });
    }
  } else if (a._tag === "Objects") {
    for (const p of a.propertySignatures) {
      const id = key([...path, p.name], "field");
      obligations.add(id);
      for (const v of await variants(p.type, [...path, p.name], next))
        out.push({ value: { ...b, [p.name]: v.value }, covers: [id, ...v.covers] });
    }
    for (const p of a.indexSignatures ?? []) {
      const k = await base(p.parameter);
      for (const v of await variants(p.type, [...path, "{}"], next))
        out.push({ value: { ...b, [k]: v.value }, covers: v.covers });
    }
  } else if (a._tag === "Arrays") {
    for (let i = 0; i < a.elements.length; i++)
      for (const v of await variants(a.elements[i], [...path, i], next)) {
        const value = [...b];
        while (value.length < i) value.push(await base(a.elements[value.length]));
        value[i] = v.value;
        out.push({ value, covers: v.covers });
      }
    if (a.rest.length)
      for (const v of await variants(a.rest[0], [...path, "[]"], next))
        out.push({ value: [...b.slice(0, a.elements.length), v.value], covers: v.covers });
  } else if (a._tag === "Suspend") return variants(a.thunk(), path, next);
  return out;
}
function repair(v) {
  if (Array.isArray(v)) return v.filter((x) => x !== undefined).map(repair);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const r = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, repair(x)]));
    if (typeof r.start === "number" && typeof r.end === "number" && r.end <= r.start)
      r.end = r.start + 1;
    return r;
  }
  return v;
}
const names = [
  "AppThreadJson",
  "RunJson",
  "RunAttemptJson",
  "ExecutionNodeJson",
  "ProviderSessionJson",
  "ProviderThreadJson",
  "ProviderTurnJson",
  "RuntimeRequestJson",
  "ConversationMessageJson",
  "PlanArtifact",
  "TurnItemJson",
  "CheckpointScopeJson",
  "CheckpointJson",
  "ContextHandoffJson",
  "ContextTransferJson",
  "SubagentJson",
];
const extra = [
  "ProjectScript",
  "ModelSelection",
  "StoredProjectIcon",
  "ThreadPullRequestSnapshot",
  "ThreadPullRequestStack",
  "PullRequestReviewGuide",
  "ThreadLinkedPullRequest",
  "ChatAttachment",
  "OrchestrationMessageContext",
  "ScheduledTaskSchedule",
  "ScheduledTask",
  "AuthEnvironmentScopes",
  "AuthClientMetadata",
  "ApplicationEventMetadata",
  "AgentSessionImportSource",
];
const sourceRuntime = await import(
  NodeURL.pathToFileURL(root + "/apps/server/src/persistence/ProviderSessionRuntime.ts")
);
const sourceAuth = await import(
  NodeURL.pathToFileURL(root + "/apps/server/src/persistence/AuthSessions.ts")
);
const sourcePairing = await import(
  NodeURL.pathToFileURL(root + "/apps/server/src/persistence/AuthPairingLinks.ts")
);
const sourceEffects = await import(
  NodeURL.pathToFileURL(root + "/apps/server/src/orchestration-v2/EffectOutbox.ts")
);
const schemas = [
  ["runtime.ProviderSessionRuntime", sourceRuntime.ProviderSessionRuntime],
  ["runtime.AuthSessionRecord", sourceAuth.AuthSessionRecord],
  ["runtime.AuthPairingLinkRecord", sourcePairing.AuthPairingLinkRecord],
  ["execution.EffectRequest", sourceEffects.OrchestrationEffectRequestV2],
  [
    "column.WebhookRequest",
    S.Struct({
      method: S.String,
      path: S.String,
      query: S.String,
      headers: S.Record(S.String, S.String),
      bodyText: S.String,
    }),
  ],
  ["column.StringList", S.Array(S.String)],
  ["column.StringMap", S.Record(S.String, S.String)],
  ...names.map((n) => ["projection." + n, C["OrchestrationV2" + n]]),
  ...extra.map((n) => ["column." + n, C[n]]),
  ["thread-event", C.OrchestrationV2DomainEventJson],
  ["project-event", C.ApplicationProjectEvent],
];
const result = [];
const failures = [];
for (const [name, schema] of schemas) {
  try {
    const cases = await variants(S.toType(schema).ast, [name]);
    const unique = new Map();
    for (const c of cases) {
      try {
        const value = S.encodeUnknownSync(schema)(repair(c.value));
        S.decodeUnknownSync(schema)(value);
        for (const id of c.covers) covered.add(id);
        const json = JSON.stringify(value);
        const previous = unique.get(json);
        unique.set(json, {
          name,
          value,
          covers: [...new Set([...(previous?.covers ?? []), ...c.covers])].sort(),
        });
      } catch {
        if (!failures.some((f) => f.name === name)) console.log("Invalid source witness", name);
        failures.push({ name, covers: c.covers });
      }
    }
    result.push(...unique.values());
    console.log(name, unique.size);
  } catch {
    console.log("Source generation failed", name);
    failures.push({ name });
  }
}
if (failures.length || [...obligations].some((k) => !covered.has(k)))
  throw new Error("Incomplete source shape coverage");
NodeFS.writeFileSync(
  output,
  NodeZlib.gzipSync(
    JSON.stringify({
      source: "68e0ea592ac9a2262d04f2457d83e3f21d73ac73",
      obligations: [...obligations].sort(),
      shapes: result,
    }),
  ),
);
console.log(
  JSON.stringify({ shapes: result.length, obligations: obligations.size, covered: covered.size }),
);
