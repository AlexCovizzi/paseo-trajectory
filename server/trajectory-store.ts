import type { PluginHookContext } from "@getpaseo/plugin/server";
import {
  countSteps,
  entryKey,
  groupEntries,
  itemMeta,
  itemSummary,
  recordSearchText,
  toolCallPreview,
  type ItemColor,
  type ToolCallPreview,
} from "../shared/trajectory-preview";
import type {
  PreviewRow,
  TrajectoryPageResult,
  TrajectorySearchMatch,
  TrajectorySearchResult,
} from "../shared/trajectory-rpc";
import type { TimelineCursor, TimelineEntry } from "../shared/timeline-types";

// Handle types are derived from the daemon-side SDK surface. This file is only
// bundled into the server entry, so the server-only module import is allowed
// here (shared bundle code must stay free of entry-specific modules).
type Paseo = PluginHookContext["paseo"];
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
type TimelineSubscription = ReturnType<AgentHandle["timeline"]["subscribe"]>;

/** Page size while sweeping the full history at seed time. */
const SEED_PAGE_SIZE = 500;
/** Page size for live tail refetches triggered by stream events. */
const STREAM_PAGE_SIZE = 200;
/** Debounce for stream-event → refetch, matching the daemon's merge window. */
const STREAM_REFRESH_MS = 400;
/** Delay before re-establishing a failed timeline subscription. */
const RESUBSCRIBE_DELAY_MS = 5000;
/** Entries kept in memory per agent. Frozen turns release their entries but
 * keep their pre-built preview rows, so the ledger still renders old history
 * while full record content is only served for retained entries. */
const MAX_ENTRIES_PER_AGENT = 10_000;
const DEFAULT_PAGE_ROWS = 200;
/** Cap on matches returned per search query. */
const MAX_SEARCH_MATCHES = 500;
/** Cap on the full-record contribution to one row's searchable text, so one
 * huge tool output cannot dominate a search. */
const SEARCH_TEXT_LIMIT = 8_000;
/** Cached search results per store, invalidated by revision. */
const SEARCH_CACHE_LIMIT = 25;

/** Item-derived fields of one ledger row; cached per entry and immutable once
 * the entry settles. */
interface EntryPreview {
  icon: string;
  color: ItemColor;
  label: string;
  showLabel: boolean;
  summary: string;
  preview: ToolCallPreview | null;
  danger: boolean;
  dim: boolean;
  timestamp: string;
}

interface TurnState {
  key: string;
  turnId: string | null;
  /** Absolute turn number across the whole session; null for the turn-less bucket. */
  index: number | null;
  entries: TimelineEntry[];
  /** Frozen turns keep their pre-built rows but release their entries. */
  frozen: boolean;
  rows: PreviewRow[];
}

export interface TrajectoryStoreOptions {
  handle: AgentHandle;
}

/**
 * Daemon-side panel store for one agent. Created lazily when a panel opens
 * (RPC), it subscribes to the agent's timeline stream, keeps the entries in
 * memory (bounded), and serves the panel's pre-computed ledger rows.
 *
 * Everything it serves comes from the timeline itself plus the agent status
 * the timeline refetch and agent updates carry, so the
 * data is identical whether or not the panel has ever been open. Per-turn
 * usage, model, and outcome are deliberately absent: the daemon does not put
 * them on the timeline, so inventing them here would only be consistent for
 * turns seen while a panel was open.
 *
 * The panel is a dumb renderer over three RPCs: getTrajectoryPage
 * (pre-computed rows, tail-first), getRecordDetail (one full entry, on
 * demand), and searchTrajectory (full-text matches over the session's entry
 * rows).
 */
export class TrajectoryStore {
  private readonly handle: AgentHandle;

  private entries = new Map<string, TimelineEntry>();
  private previews = new Map<string, EntryPreview>();
  private turns: TurnState[] = [];
  private turnIndexByKey = new Map<string, number>();
  private nextTurnIndex = 1;
  /** Flat row list: frozen prefix + live rows. A row's `order` is its index. */
  private rows: PreviewRow[] = [];
  private revision = 0;
  private gap = false;
  private tailCursor: TimelineCursor | null = null;
  /** Agent-level state from the latest agent snapshot (timeline refetch or agent update). */
  private status: string | null = null;
  private seeded = false;
  private seeding: Promise<void> | null = null;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private timelineSub: TimelineSubscription | null = null;
  private agentUnsubscribe: (() => void) | null = null;
  private pendingStreamEvent = false;
  private reseedChain: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Searchable text per entry row, cached by entry object identity. */
  private searchBlobs = new Map<string, { entry: TimelineEntry | undefined; text: string }>();
  /** Search results per query, invalidated by revision. */
  private searchCache = new Map<string, { revision: number; value: TrajectorySearchResult }>();

  constructor(options: TrajectoryStoreOptions) {
    this.handle = options.handle;
  }

  /** Subscribes to the agent and its timeline, then sweeps history. */
  async attach(): Promise<void> {
    this.subscribeAgent();
    this.subscribeTimeline();
    await this.seed();
  }

  release(): void {
    this.disposed = true;
    if (this.streamTimer !== null) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    this.releaseTimelineSub();
    if (this.agentUnsubscribe) {
      const unsubscribe = this.agentUnsubscribe;
      this.agentUnsubscribe = null;
      unsubscribe();
    }
  }

  /** Applies the agent status embedded in a timeline refetch or agent update. */
  private applyAgentSnapshot(agent: { status?: string | null } | null | undefined): void {
    if (!agent) return;
    this.status = agent.status ?? null;
  }

  /** Tracks Paseo's active turn and status through agent updates. */
  private subscribeAgent(): void {
    this.agentUnsubscribe = this.handle.subscribe((update) => {
      if (update.kind === "upsert") this.applyAgentSnapshot(update.agent);
    });
  }

  /** The page RPC: the tail page, or the page immediately older than
   * `beforeOrder` (scrolling up pages history in). */
  page(limit: number = DEFAULT_PAGE_ROWS, beforeOrder?: number): TrajectoryPageResult {
    const end =
      beforeOrder === undefined ? this.rows.length : Math.min(Math.max(beforeOrder, 0), this.rows.length);
    const start = Math.max(0, end - limit);
    return {
      rows: this.rows.slice(start, end),
      hasEarlier: start > 0,
      revision: this.revision,
      gap: this.gap,
      status: this.status,
    };
  }

  /** The detail RPC: one full entry, or null when the entry was evicted. */
  detail(key: string): TimelineEntry | null {
    return this.entries.get(key) ?? null;
  }

  /** The search RPC: entry rows whose searchable text contains every
   * whitespace-separated term (case-insensitive), in row order. Results are
   * cached by revision and query. */
  search(query: string): TrajectorySearchResult {
    const cached = this.searchCache.get(query);
    if (cached && cached.revision === this.revision) return cached.value;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches: TrajectorySearchMatch[] = [];
    let truncated = false;
    if (terms.length > 0) {
      for (const row of this.rows) {
        if (row.kind !== "entry") continue;
        if (terms.every((term) => this.searchText(row).includes(term))) {
          matches.push({ key: row.key });
          if (matches.length >= MAX_SEARCH_MATCHES) {
            truncated = true;
            break;
          }
        }
      }
    }
    const value: TrajectorySearchResult = { revision: this.revision, matches, truncated };
    if (this.searchCache.size >= SEARCH_CACHE_LIMIT) this.searchCache.clear();
    this.searchCache.set(query, { revision: this.revision, value });
    return value;
  }

  /** Lowercased searchable text for one entry row: the pre-computed preview
   * fields (always available) plus the full record text while the entry is
   * retained. Cached per entry object, so in-flight updates rebuild only the
   * rows whose entry changed. */
  private searchText(row: PreviewRow): string {
    const entry = this.entries.get(row.key);
    const cached = this.searchBlobs.get(row.key);
    if (cached && cached.entry === entry) return cached.text;
    const parts = [row.label, row.summary, row.preview?.input, row.preview?.output];
    if (entry) {
      const full = recordSearchText(entry);
      if (full.length > 0) parts.push(full.slice(0, SEARCH_TEXT_LIMIT));
    }
    const text = parts
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n")
      .toLowerCase();
    this.searchBlobs.set(row.key, { entry, text });
    return text;
  }

  // --- Seeding and live updates -------------------------------------------

  private seed(): Promise<void> {
    if (this.seeding) return this.seeding;
    this.seeding = this.doSeed();
    return this.seeding.finally(() => {
      this.seeding = null;
    });
  }

  private async doSeed(): Promise<void> {
    let cursor: TimelineCursor | null = null;
    for (;;) {
      const page = await this.handle.timeline.refetch({
        direction: "after",
        limit: SEED_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (this.disposed) return;
      if (page.reset) {
        // The daemon replaced the timeline mid-seed; start over from the head.
        this.entries.clear();
        this.previews.clear();
        this.searchBlobs.clear();
        this.searchCache.clear();
        this.turns = [];
        this.rows = [];
        this.turnIndexByKey.clear();
        this.nextTurnIndex = 1;
        this.gap = false;
        this.tailCursor = null;
        cursor = null;
        continue;
      }
      if (page.agent) this.applyAgentSnapshot(page.agent);
      if (page.gap) this.gap = true;
      this.upsertEntries(page.entries);
      this.reconcile();
      this.evictIfNeeded();
      this.tailCursor = page.endCursor ?? this.tailCursor;
      cursor = page.endCursor;
      if (!cursor || !page.hasNewer) break;
    }
    this.seeded = true;
    this.bump();
    if (this.pendingStreamEvent) {
      this.pendingStreamEvent = false;
      this.scheduleStreamRefetch();
    }
  }

  /** Full wipe and re-seed, serialized so concurrent replacements cannot
   * interleave. Used for timeline replacement, subscription restore, and
   * subscription failure (which also re-establishes the stream). */
  private reseed(): Promise<void> {
    const run = this.reseedChain.then(() => this.doReseed());
    this.reseedChain = run.catch(() => {});
    return run;
  }

  private async doReseed(): Promise<void> {
    if (this.disposed) return;
    if (this.seeding) {
      await this.seeding.catch(() => {});
      if (this.disposed) return;
    }
    this.releaseTimelineSub();
    this.entries.clear();
    this.previews.clear();
    this.searchBlobs.clear();
    this.searchCache.clear();
    this.turns = [];
    this.turnIndexByKey.clear();
    this.nextTurnIndex = 1;
    this.rows = [];
    this.gap = false;
    this.tailCursor = null;
    this.seeded = false;
    this.subscribeTimeline();
    await this.seed();
  }

  private subscribeTimeline(): void {
    const subscription = this.handle.timeline.subscribe((event) => {
      const inner = event.event;
      if (inner.type === "replacement") {
        void this.reseed();
        return;
      }
      if (inner.type === "error") {
        // The SDK releases the observation on stream errors; reseeding
        // re-establishes it.
        console.error("[paseo-trajectory] timeline stream error:", inner.error);
        void this.reseed();
        return;
      }
      if (inner.type === "subscription_restored") {
        // Live delivery resumed, but history may have been missed.
        void this.reseed();
        return;
      }
      this.scheduleStreamRefetch();
    });
    void subscription.ready.catch((cause: unknown) => {
      if (this.disposed) return;
      console.error("[paseo-trajectory] timeline subscription failed:", cause);
      // Retry after a delay; the store is released when the agent closes.
      setTimeout(() => {
        if (!this.disposed) void this.reseed();
      }, RESUBSCRIBE_DELAY_MS);
    });
    this.timelineSub = subscription;
  }

  private releaseTimelineSub(): void {
    if (this.timelineSub) {
      void this.timelineSub.release();
      this.timelineSub = null;
    }
  }

  private scheduleStreamRefetch(): void {
    if (this.disposed) return;
    if (!this.seeded) {
      // The seed sweep reaches the head and picks these up; remember that
      // events arrived meanwhile so one tail refetch runs right after it.
      this.pendingStreamEvent = true;
      return;
    }
    if (this.streamTimer !== null) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      void this.refetchTail();
    }, STREAM_REFRESH_MS);
  }

  private async refetchTail(): Promise<void> {
    if (this.disposed || !this.seeded) return;
    try {
      const page = await this.handle.timeline.refetch({
        direction: "after",
        limit: STREAM_PAGE_SIZE,
        ...(this.tailCursor ? { cursor: this.tailCursor } : {}),
      });
      if (this.disposed) return;
      if (page.reset || page.staleCursor) {
        void this.reseed();
        return;
      }
      if (page.agent) this.applyAgentSnapshot(page.agent);
      if (page.gap) this.gap = true;
      if (page.entries.length > 0) {
        this.upsertEntries(page.entries);
        this.reconcile();
        this.evictIfNeeded();
        this.bump();
      }
      this.tailCursor = page.endCursor ?? this.tailCursor;
    } catch (error) {
      console.error("[paseo-trajectory] timeline refetch failed:", error);
    }
  }

  private upsertEntries(entries: TimelineEntry[]): void {
    for (const entry of entries) {
      const key = entryKey(entry);
      const existing = this.entries.get(key);
      this.entries.set(key, entry);
      if (!existing || existing !== entry) {
        this.previews.set(key, computeEntryPreview(entry));
      }
    }
  }

  /** Freezes whole turns from the front until the entry budget holds. Never
   * freezes the last turn — it is the one still receiving entries. Frozen
   * turns keep their pre-built rows; their entries are released, so record
   * detail for them reads as unavailable. */
  private evictIfNeeded(): void {
    while (this.entries.size > MAX_ENTRIES_PER_AGENT) {
      const live = this.turns.filter((turn) => !turn.frozen);
      const first = live[0];
      if (!first || live.length <= 1) break;
      for (const entry of first.entries) {
        const key = entryKey(entry);
        this.entries.delete(key);
        this.previews.delete(key);
        this.searchBlobs.delete(key);
      }
      first.entries = [];
      first.frozen = true;
    }
  }

  // --- Row building ---------------------------------------------------------

  /** Regroups the retained entries into turns (preserving absolute turn
   * indexes by group key) and rebuilds the flat row list. Frozen turns keep
   * their rows untouched. Preview computation is cached per entry, so this
   * only assembles row objects. */
  private reconcile(): void {
    const sorted = [...this.entries.values()].sort((a, b) => a.seqStart - b.seqStart);
    const groups = groupEntries(sorted);
    const existingByKey = new Map(
      this.turns.filter((turn) => !turn.frozen).map((turn) => [turn.key, turn]),
    );
    const rebuilt: TurnState[] = groups.map((group) => {
      const existing = existingByKey.get(group.key);
      if (existing) {
        existing.entries = group.entries;
        return existing;
      }
      // Only real turns consume a turn number; the turn-less bucket (entries
      // without a turn id) stays unnumbered so turn labels stay contiguous.
      let index: number | null = null;
      if (group.turnId !== null) {
        index = this.turnIndexByKey.get(group.key) ?? this.nextTurnIndex++;
        this.turnIndexByKey.set(group.key, index);
      }
      return {
        key: group.key,
        turnId: group.turnId,
        index,
        entries: group.entries,
        frozen: false,
        rows: [],
      };
    });
    this.turns = [...this.turns.filter((turn) => turn.frozen), ...rebuilt];
    for (const turn of rebuilt) {
      turn.rows = this.buildTurnRows(turn);
    }
    this.rows = this.turns.flatMap((turn) => turn.rows);
    this.rows.forEach((row, order) => {
      row.order = order;
    });
  }

  private buildTurnRows(turn: TurnState): PreviewRow[] {
    // The turn-less bucket carries no turn header row: its entries flow in the
    // ledger without a turn label or a turn number.
    const rows: PreviewRow[] = turn.turnId !== null ? [this.turnRow(turn)] : [];
    let step = 0;
    let open = false;
    for (const entry of turn.entries) {
      const type = entry.item.type;
      if (type === "assistant_message" || type === "reasoning") {
        // A thinking/assistant run owns the tool calls that follow; the next
        // such run after tools starts a new step.
        if (!open) {
          step += 1;
          open = true;
          rows.push({ key: `step:${entryKey(entry)}`, kind: "step", order: 0 });
        }
      } else if (type === "tool_call") {
        open = false;
      }
      rows.push(this.entryRow(turn, entry, step > 0 ? step : null));
    }
    return rows;
  }

  private entryRow(turn: TurnState, entry: TimelineEntry, step: number | null): PreviewRow {
    const key = entryKey(entry);
    const preview = this.previews.get(key) ?? computeEntryPreview(entry);
    return {
      key,
      kind: "entry",
      order: 0,
      icon: preview.icon,
      color: preview.color,
      label: preview.label,
      showLabel: preview.showLabel,
      summary: preview.summary,
      preview: preview.preview ?? undefined,
      danger: preview.danger,
      dim: preview.dim,
      timestamp: entry.timestamp,
      // Turn-less entries carry no turn number; omitted so the wire schema
      // (turnIndex optional, not nullable) stays happy.
      turnIndex: turn.index ?? undefined,
      step,
      provider: entry.provider ?? null,
    };
  }

  private turnRow(turn: TurnState): PreviewRow {
    return {
      key: `turn:${turn.key}`,
      kind: "turn",
      order: 0,
      turn: {
        id: turn.turnId,
        // Only reached for real turns; the turn-less bucket never builds one.
        index: turn.index ?? 0,
        steps: countSteps(turn.entries),
        tools: turn.entries.filter((entry) => entry.item.type === "tool_call").length,
      },
    };
  }

  private bump(): void {
    this.revision += 1;
  }
}

function computeEntryPreview(entry: TimelineEntry): EntryPreview {
  const meta = itemMeta(entry.item);
  const preview = entry.item.type === "tool_call" ? toolCallPreview(entry.item) : null;
  return {
    icon: meta.icon,
    color: meta.color,
    label: meta.label,
    showLabel: meta.showLabel,
    summary: itemSummary(entry.item),
    preview,
    danger: entry.item.type === "tool_call" && entry.item.status === "failed",
    dim: meta.showLabel || meta.color === "reasoning",
    timestamp: entry.timestamp,
  };
}
