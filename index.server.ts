import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { getRecordDetailRpc, getTrajectoryPageRpc, searchTrajectoryRpc } from "./shared/trajectory-rpc";
import { TrajectoryStore } from "./server/trajectory-store";

/**
 * Daemon-side trajectory host.
 *
 * One TrajectoryStore per agent, created lazily on the panel's RPCs and
 * released when the agent is archived or closed. There is no background work:
 * the store reads only the agent's timeline and the agent snapshot the
 * timeline refetch carries, so the ledger is identical whether or not a panel
 * has ever been open. The daemon does not put per-turn usage, model, or
 * outcome on the timeline, so the store leaves those empty rather than
 * reporting them for some turns and not others.
 */
export default function contribute(server: PluginServerContext) {
  const stores = new Map<string, TrajectoryStore>();
  const storeAttaches = new Map<string, Promise<TrajectoryStore>>();

  const ensureStore = (
    agentId: string,
    paseo: PluginHookContext["paseo"],
  ): Promise<TrajectoryStore> => {
    // The in-flight map only dedupes concurrent calls; the settled instance
    // lives in `stores` so start/end and the panel share one store.
    const cached = stores.get(agentId);
    if (cached) return Promise.resolve(cached);
    let pending = storeAttaches.get(agentId);
    if (!pending) {
      pending = (async () => {
        const store = new TrajectoryStore({ handle: paseo.agents.ref(agentId) });
        stores.set(agentId, store);
        try {
          await store.attach();
        } catch (error) {
          // A failed seed must not leave a broken store cached: drop it so the
          // next RPC rebuilds from scratch.
          stores.delete(agentId);
          store.release();
          throw error;
        }
        return store;
      })();
      storeAttaches.set(agentId, pending);
      // Clear the slot once settled; the rejection stays with the callers.
      void pending.then(
        () => storeAttaches.delete(agentId),
        () => storeAttaches.delete(agentId),
      );
    }
    return pending;
  };

  const releaseStore = (agentId: string) => {
    storeAttaches.delete(agentId);
    const store = stores.get(agentId);
    if (!store) return;
    stores.delete(agentId);
    store.release();
  };

  const unsubscribes = [
    server.on("agent.archived", (event) => releaseStore(event.agent.id)),
    server.on("agent.closed", (event) => releaseStore(event.agent.id)),
  ];

  server.handle(getTrajectoryPageRpc, async (input, context) => {
    const store = await ensureStore(input.agentId, context.paseo);
    return store.page(input.limit, input.beforeOrder);
  });

  server.handle(getRecordDetailRpc, async (input, context) => {
    const store = await ensureStore(input.agentId, context.paseo);
    return { entry: store.detail(input.key) };
  });

  server.handle(searchTrajectoryRpc, async (input, context) => {
    const store = await ensureStore(input.agentId, context.paseo);
    return store.search(input.query);
  });

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const agentId of [...stores.keys()]) releaseStore(agentId);
  };
}
