import { env, type DurableObject } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  listDurableObjectIds,
  reset,
  runInDurableObject,
} from "cloudflare:test";
async function clearObjects<T extends DurableObject<unknown>>(
  namespace: DurableObjectNamespace<T>,
) {
  for (const id of await listDurableObjectIds(namespace))
    await runInDurableObject(namespace.get(id), async (_instance, ctx) => {
      await ctx.storage.deleteAll();
    });
}
export async function resetRegistrationObjects() {
  // The prerelease runtime's global reset alone can leave restarted SQLite objects behind.
  await abortAllDurableObjects();
  await clearObjects(env.ACCOUNTS);
  await clearObjects(env.PUSH_TOKENS);
  await clearObjects(env.INVENTORY);
  await clearObjects(env.EMAILS);
  await clearObjects(env.CREDENTIAL_ROUTES);
  await abortAllDurableObjects();
  await reset();
}

export function namespaceWith<N extends { getByName: (name: string) => unknown }>(
  value: N,
  getByName: N["getByName"],
): N {
  return new Proxy(value, {
    get(target, method) {
      return method === "getByName" ? getByName : Reflect.get(target, method, target);
    },
  });
}
