import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StorePool } from "../server/store-pool";

interface FakeStore {
  id: string;
  released: boolean;
}

function makeStore(id: string): FakeStore {
  return { id, released: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makePool(options?: { maxLive?: number; ttlMs?: number; now?: () => number }) {
  let clock = 0;
  const created: string[] = [];
  const destroyed: string[] = [];
  const pool = new StorePool<FakeStore>({
    maxLive: options?.maxLive ?? 4,
    ttlMs: options?.ttlMs ?? 1000,
    now: options?.now ?? (() => clock),
    create: async (agentId) => {
      created.push(agentId);
      return makeStore(agentId);
    },
    destroy: (store) => {
      store.released = true;
      destroyed.push(store.id);
    },
  });
  return {
    pool,
    created,
    destroyed,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

describe("StorePool", () => {
  it("evicts the least recently used store past the cap", async () => {
    const { pool, destroyed } = makePool({ maxLive: 2 });
    await pool.acquire("a", undefined);
    await pool.acquire("b", undefined);
    await pool.acquire("c", undefined);
    assert.deepEqual(destroyed, ["a"]);
    assert.equal(pool.has("b"), true);
    assert.equal(pool.has("c"), true);
    assert.equal(pool.has("a"), false);
  });

  it("keeps a recently used store over an older one", async () => {
    const { pool, destroyed } = makePool({ maxLive: 2 });
    await pool.acquire("a", undefined);
    await pool.acquire("b", undefined);
    await pool.acquire("a", undefined);
    await pool.acquire("c", undefined);
    assert.deepEqual(destroyed, ["b"]);
    assert.equal(pool.has("a"), true);
  });

  it("dedupes concurrent acquires for the same agent", async () => {
    const { pool, created } = makePool();
    const [first, second] = await Promise.all([
      pool.acquire("x", undefined),
      pool.acquire("x", undefined),
    ]);
    assert.equal(created.length, 1);
    assert.equal(first, second);
  });

  it("releases stores idle past the TTL", async () => {
    const { pool, destroyed, setClock } = makePool({ ttlMs: 1000 });
    await pool.acquire("a", undefined);
    setClock(500);
    pool.sweep();
    assert.equal(pool.has("a"), true);
    setClock(2000);
    pool.sweep();
    assert.deepEqual(destroyed, ["a"]);
    assert.equal(pool.size, 0);
  });

  it("drops a released store and rebuilds on the next acquire", async () => {
    const { pool, destroyed } = makePool();
    const first = await pool.acquire("a", undefined);
    pool.release("a");
    assert.equal(first.released, true);
    assert.equal(pool.has("a"), false);
    const second = await pool.acquire("a", undefined);
    assert.notEqual(second, first);
    assert.deepEqual(destroyed, ["a"]);
  });

  it("does not cache a store released while it was still attaching", async () => {
    const destroyed: string[] = [];
    const gate = deferred<FakeStore>();
    const pool = new StorePool<FakeStore>({
      maxLive: 4,
      ttlMs: 1000,
      create: () => gate.promise,
      destroy: (store) => {
        store.released = true;
        destroyed.push(store.id);
      },
    });
    const acquiring = pool.acquire("a", undefined);
    pool.release("a");
    gate.resolve(makeStore("a"));
    await assert.rejects(acquiring);
    assert.deepEqual(destroyed, ["a"]);
    assert.equal(pool.has("a"), false);
  });

  it("releases every store on dispose", async () => {
    const { pool, destroyed } = makePool();
    await pool.acquire("a", undefined);
    await pool.acquire("b", undefined);
    pool.dispose();
    assert.deepEqual(destroyed.sort(), ["a", "b"]);
    assert.equal(pool.size, 0);
  });
});
