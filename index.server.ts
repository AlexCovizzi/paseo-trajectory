import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { getRecordDetailRpc, getTrajectoryPageRpc, searchTrajectoryRpc } from "./shared/trajectory-rpc";
import { StorePool } from "./server/store-pool";
import { TrajectoryStore } from "./server/trajectory-store";

/** Max live stores across all agents; the least recently used is evicted. */
const MAX_LIVE_STORES = 8;
/** Idle time after which a store is released. */
const STORE_TTL_MS = 10 * 60 * 1000;
/** How often idle stores are swept. */
const TTL_SWEEP_MS = 60 * 1000;

/**
 * Daemon-side trajectory host.
 *
 * One TrajectoryStore per agent, created lazily on the panel's RPCs, released
 * when the agent is archived or closed, evicted oldest-first past a global cap,
 * and released after an idle TTL. Aside from the TTL sweep there is no
 * background work: the store reads only the agent's timeline and the agent
 * snapshot the timeline refetch carries, so the ledger is identical whether or
 * not a panel has ever been open. The daemon does not put per-turn usage,
 * model, or outcome on the timeline, so the store leaves those empty rather
 * than reporting them for some turns and not others.
 */
export default function contribute(server: PluginServerContext) {
  const pool = new StorePool<TrajectoryStore, PluginHookContext["paseo"]>({
    maxLive: MAX_LIVE_STORES,
    ttlMs: STORE_TTL_MS,
    create: async (agentId, paseo) => {
      const store = new TrajectoryStore({ handle: paseo.agents.ref(agentId) });
      try {
        await store.attach();
      } catch (error) {
        // A failed seed must not leak the store.
        store.release();
        throw error;
      }
      return store;
    },
    destroy: (store) => store.release(),
  });

  const unsubscribes = [
    server.on("agent.archived", (event) => pool.release(event.agent.id)),
    server.on("agent.closed", (event) => pool.release(event.agent.id)),
  ];

  const sweepTimer = setInterval(() => pool.sweep(), TTL_SWEEP_MS);
  sweepTimer.unref?.();

  server.handle(getTrajectoryPageRpc, async (input, context) => {
    const store = await pool.acquire(input.agentId, context.paseo);
    return store.page(input.limit, input.beforeOrder);
  });

  server.handle(getRecordDetailRpc, async (input, context) => {
    const store = await pool.acquire(input.agentId, context.paseo);
    return { entry: store.detail(input.key) };
  });

  server.handle(searchTrajectoryRpc, async (input, context) => {
    const store = await pool.acquire(input.agentId, context.paseo);
    return store.search(input.query);
  });

  return () => {
    clearInterval(sweepTimer);
    for (const unsubscribe of unsubscribes) unsubscribe();
    pool.dispose();
  };
}
