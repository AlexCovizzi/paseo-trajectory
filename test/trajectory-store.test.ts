import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TrajectoryStore } from "../server/trajectory-store";
import { entryKey } from "../shared/trajectory-preview";
import type { TimelineEntry, TimelineItem } from "../shared/timeline-types";

type StoreHandle = ConstructorParameters<typeof TrajectoryStore>[0]["handle"];

/** One scripted timeline page, shaped like the daemon's refetch result. */
interface FakePage {
  entries: TimelineEntry[];
  endCursor?: { epoch: string; seq: number } | null;
  hasNewer?: boolean;
  reset?: boolean;
  gap?: boolean;
  agent?: { status?: string | null };
}

let seqCounter = 0;

function entry(item: TimelineItem, turnId?: string): TimelineEntry {
  seqCounter += 1;
  return {
    provider: "test",
    item,
    turnId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seqCounter)).toISOString(),
    seqStart: seqCounter,
  };
}

/** One minimal turn: user message, assistant reply, completed shell call. */
function turn(turnId: string, command = `cmd-${turnId}`): TimelineEntry[] {
  return [
    entry({ type: "user_message", text: `message ${turnId}` }, turnId),
    entry({ type: "assistant_message", text: `reply ${turnId}` }, turnId),
    entry(
      {
        type: "tool_call",
        callId: `call-${turnId}`,
        name: "shell",
        detail: { type: "shell", command, output: `done ${turnId}` },
        status: "completed",
        error: null,
      },
      turnId,
    ),
  ];
}

function fakeHandle(pages: FakePage[]) {
  const listeners = new Set<(event: { event: { type: string } }) => void>();
  let next = 0;
  const handle = {
    timeline: {
      refetch: async () => {
        if (next >= pages.length) return { entries: [], endCursor: null, hasNewer: false };
        return pages[next++];
      },
      subscribe: (listener: (event: { event: { type: string } }) => void) => {
        listeners.add(listener);
        return {
          ready: Promise.resolve(),
          release: async () => {
            listeners.delete(listener);
          },
        };
      },
    },
    subscribe: () => () => {},
  };
  return {
    handle,
    pages,
    emit(type: string) {
      for (const listener of listeners) listener({ event: { type } });
    },
  };
}

async function makeStore(pages: FakePage[]) {
  const fake = fakeHandle(pages);
  const store = new TrajectoryStore({
    handle: fake.handle as unknown as StoreHandle,
  });
  await store.attach();
  return { store, ...fake };
}

describe("TrajectoryStore", () => {
  it("numbers turns absolutely across seed pages and exposes the agent status", async () => {
    const { store } = await makeStore([
      { entries: turn("a"), endCursor: { epoch: "e", seq: 3 }, hasNewer: true, agent: { status: "running" } },
      { entries: turn("b"), endCursor: null, hasNewer: false },
    ]);
    const result = store.page();
    const turnRows = result.rows.filter((row) => row.kind === "turn");
    assert.deepEqual(turnRows.map((row) => row.turn?.index), [1, 2]);
    assert.deepEqual(turnRows.map((row) => row.turn?.id), ["a", "b"]);
    assert.equal(result.status, "running");
    assert.equal(result.hasEarlier, false);
    assert.equal(result.gap, false);
  });

  it("serves the tail page and pages older rows in with beforeOrder", async () => {
    const { store } = await makeStore([
      { entries: turn("a"), endCursor: { epoch: "e", seq: 3 }, hasNewer: true },
      { entries: turn("b"), endCursor: null, hasNewer: false },
    ]);
    // Two turns, each one turn row + user entry + step rule + two entries.
    assert.equal(store.page().rows.length, 10);

    const tail = store.page(2);
    assert.equal(tail.rows.length, 2);
    assert.equal(tail.hasEarlier, true);
    assert.deepEqual(tail.rows.map((row) => row.turnIndex), [2, 2]);

    const older = store.page(3, tail.rows[0].order);
    assert.equal(older.rows.length, 3);
    assert.equal(older.hasEarlier, true);
    // The pages are adjacent in row order.
    assert.equal(older.rows[2].order, tail.rows[0].order - 1);

    const head = store.page(10);
    assert.equal(head.hasEarlier, false);
  });

  it("reports a gap in the loaded history", async () => {
    const { store } = await makeStore([
      { entries: turn("a"), endCursor: null, hasNewer: false, gap: true },
    ]);
    assert.equal(store.page().gap, true);
  });

  it("serves one full entry for the record inspector", async () => {
    const { store } = await makeStore([
      { entries: turn("a"), endCursor: null, hasNewer: false },
    ]);
    const row = store.page().rows.find((row) => row.kind === "entry");
    assert.ok(row);
    assert.ok(store.detail(row.key));
    assert.equal(store.detail("missing:1"), null);
  });

  describe("search", () => {
    it("matches rows containing every whitespace-separated term, case-insensitive", async () => {
      const { store } = await makeStore([
        { entries: turn("a"), endCursor: null, hasNewer: false },
      ]);
      assert.deepEqual(
        store.search("MESSAGE").matches.map((match) => match.key.length > 0),
        [true],
      );
      // Both terms must land in the same row's text.
      assert.equal(store.search("message done").matches.length, 0);
      // The tool row carries the command and the output.
      assert.equal(store.search("cmd-a").matches.length, 1);
      assert.equal(store.search("nothing-matches-this").matches.length, 0);
    });

    it("re-runs a cached query when the store revision moves", async () => {
      const { store, pages } = await makeStore([
        { entries: turn("a"), endCursor: { epoch: "e", seq: 3 }, hasNewer: false },
      ]);
      assert.equal(store.search("message").matches.length, 1);

      // A live update streams a new turn in; the cached result must not stick.
      pages.push({ entries: turn("c"), endCursor: null, hasNewer: false });
      await (store as unknown as { refetchTail(): Promise<void> }).refetchTail();
      assert.equal(store.search("message").matches.length, 2);
      assert.equal(store.page().rows.filter((row) => row.kind === "turn").length, 2);
    });
  });

  it("freezes evicted turns but keeps their pre-built rows", async () => {
    // 3340 turns x 3 entries = 10020 entries; the budget (10k) freezes the
    // first 7 turns (21 entries) and retains the rest.
    const entries: TimelineEntry[] = [];
    for (let index = 0; index < 3340; index += 1) entries.push(...turn(`t${index}`));
    const pages: FakePage[] = [];
    for (let offset = 0; offset < entries.length; offset += 500) {
      const last = offset + 500 >= entries.length;
      pages.push({
        entries: entries.slice(offset, offset + 500),
        endCursor: { epoch: "e", seq: offset + 500 },
        hasNewer: !last,
      });
    }
    const { store, pages: livePages } = await makeStore(pages);

    const state = store as unknown as { turns: Array<{ frozen: boolean }>; frozenTurns: number };
    assert.equal(state.turns.some((turn) => turn.frozen), true);
    assert.equal(state.turns[0].frozen, true);

    // Record content of an evicted entry is gone, but its ledger row remains.
    const key = entryKey(entries[0]);
    assert.equal(store.detail(key), null);
    assert.ok(store.page(20_000).rows.some((row) => row.kind === "entry" && row.key === key));

    // A live reconcile keeps the frozen prefix (and its count) intact and can
    // still evict.
    livePages.push({ entries: turn("live"), endCursor: null, hasNewer: false });
    await (store as unknown as { refetchTail(): Promise<void> }).refetchTail();
    assert.equal(state.frozenTurns, state.turns.filter((turn) => turn.frozen).length);
    assert.equal(state.turns.slice(0, state.frozenTurns).every((turn) => turn.frozen), true);
  });

  it("reseeds from scratch when the timeline is replaced", async () => {
    const { store, emit, pages } = await makeStore([
      { entries: turn("a"), endCursor: { epoch: "e", seq: 3 }, hasNewer: true },
      { entries: turn("b"), endCursor: null, hasNewer: false },
    ]);
    assert.equal(store.page().rows.length, 10);

    pages.push({ entries: turn("z"), endCursor: null, hasNewer: false });
    emit("replacement");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The replacement history becomes the whole ledger, renumbered from 1.
    const result = store.page();
    assert.equal(result.rows.length, 5);
    const turnRow = result.rows.find((row) => row.kind === "turn");
    assert.equal(turnRow?.turn?.id, "z");
    assert.equal(turnRow?.turn?.index, 1);
  });
});
