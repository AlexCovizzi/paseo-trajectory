import { useCallback, useEffect, useRef, useState } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import {
  getRecordDetailRpc,
  getTrajectoryPageRpc,
  searchTrajectoryRpc,
  type PreviewRow,
  type TrajectoryPageResult,
  type TrajectorySearchMatch,
  type TrajectorySearchResult,
} from "../shared/trajectory-rpc";
import type { TimelineEntry } from "../shared/timeline-types";

/**
 * The panel renders pre-computed rows served by the daemon-side trajectory
 * store (see index.server.ts). This module only pages those rows (tail-first),
 * polls for live updates, and fetches full record content on demand.
 */

const INITIAL_PAGE_ROWS = 200;
const OLDER_PAGE_ROWS = 200;
/** Poll cadence while the agent is running. */
const POLL_FAST_MS = 400;
/** Poll cadence while the agent is idle; still catches usage and turn records. */
const POLL_SLOW_MS = 2000;
/** Bounded cache for record details fetched for the inspector. */
const DETAIL_CACHE_LIMIT = 200;

export interface TrajectoryState {
  rows: PreviewRow[];
  loading: boolean;
  loadingOlder: boolean;
  hasEarlier: boolean;
  error: string | null;
  notice: string | null;
  status: string | null;
  /** Store revision; bumps on any change the panel might care about. */
  revision: number;
  refresh(): void;
  loadOlder(): void;
}

/**
 * Loads an agent's trajectory from the daemon-side store. The first page is the
 * session tail (the store numbers turns absolutely, so tail-first needs no
 * full-history scan); scrolling up pages older rows in. Live updates arrive by
 * polling the tail page — fast while the agent runs, slow while it idles — and
 * merge by row key.
 */
export function useTrajectory(agentId: string): TrajectoryState {
  const callPage = useRpc(getTrajectoryPageRpc);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [revision, setRevision] = useState(0);

  const rowsRef = useRef(new Map<string, PreviewRow>());
  const revisionRef = useRef(-1);
  const firstOrderRef = useRef<number | null>(null);
  const hasEarlierRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadedRef = useRef(false);

  const commit = useCallback(() => {
    setRows([...rowsRef.current.values()].sort((a, b) => a.order - b.order));
  }, []);

  const applyPage = useCallback(
    (page: TrajectoryPageResult) => {
      const map = rowsRef.current;
      for (const row of page.rows) map.set(row.key, row);
      if (page.rows.length > 0) {
        const pageFirst = Math.min(...page.rows.map((row) => row.order));
        firstOrderRef.current =
          firstOrderRef.current === null ? pageFirst : Math.min(firstOrderRef.current, pageFirst);
      }
      commit();
      setHasEarlier(page.hasEarlier);
      hasEarlierRef.current = page.hasEarlier;
      setStatus(page.status);
      setNotice(page.gap ? "Some history is unavailable." : null);
      setError(null);
      revisionRef.current = page.revision;
      setRevision(page.revision);
      if (!loadedRef.current) {
        loadedRef.current = true;
        setLoading(false);
      }
    },
    [commit],
  );

  useEffect(() => {
    rowsRef.current.clear();
    revisionRef.current = -1;
    firstOrderRef.current = null;
    hasEarlierRef.current = false;
    loadingOlderRef.current = false;
    loadedRef.current = false;
    setRows([]);
    setHasEarlier(false);
    setNotice(null);
    setError(null);
    setStatus(null);
    setRevision(0);
    setLoading(true);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = POLL_SLOW_MS;

    const poll = async () => {
      if (cancelled) return;
      try {
        const page = await callPage({ agentId, limit: INITIAL_PAGE_ROWS });
        if (cancelled) return;
        if (page.revision !== revisionRef.current || rowsRef.current.size === 0) {
          applyPage(page);
        } else {
          // Revision unmoved: still surface the cheap status line.
          setStatus(page.status);
        }
        delay = page.status === "running" ? POLL_FAST_MS : POLL_SLOW_MS;
      } catch (cause) {
        if (!cancelled) {
          setError(messageOf(cause));
          if (!loadedRef.current) {
            loadedRef.current = true;
            setLoading(false);
          }
        }
        delay = POLL_SLOW_MS;
      }
      if (!cancelled) timer = setTimeout(poll, delay);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [callPage, agentId, applyPage, refreshEpoch]);

  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current || !hasEarlierRef.current) return;
    const beforeOrder = firstOrderRef.current;
    if (beforeOrder === null) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    callPage({ agentId, limit: OLDER_PAGE_ROWS, beforeOrder })
      .then((page) => {
        applyPage(page);
      })
      .catch((cause) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [callPage, agentId, applyPage]);

  const refresh = useCallback(() => {
    setRefreshEpoch((epoch) => epoch + 1);
  }, []);

  return {
    rows,
    loading,
    loadingOlder,
    hasEarlier,
    error,
    notice,
    status,
    revision,
    refresh,
    loadOlder,
  };
}

/** Debounce for keystrokes before a search query hits the daemon. */
const SEARCH_DEBOUNCE_MS = 250;

export interface TrajectorySearchState {
  matches: TrajectorySearchMatch[];
  truncated: boolean;
  /** True while the first search for the current query is in flight. */
  loading: boolean;
  error: string | null;
}

/**
 * Full-text search over the agent's session, served by the daemon-side
 * store (which holds the full record text). The query is debounced; while a
 * query is active the search re-runs whenever the store revision changes, so
 * matches stay live as the agent runs.
 */
export function useTrajectorySearch(
  agentId: string,
  query: string,
  revision: number,
): TrajectorySearchState {
  const callSearch = useRpc(searchTrajectoryRpc);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [result, setResult] = useState<TrajectorySearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once a result lands for the current query; later re-runs (live
   * updates) do not flip the loading state again. */
  const readyRef = useRef(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setDebouncedQuery("");
      return;
    }
    readyRef.current = false;
    const timer = setTimeout(() => setDebouncedQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (!readyRef.current) setLoading(true);
    callSearch({ agentId, query: debouncedQuery })
      .then((searchResult) => {
        if (cancelled) return;
        readyRef.current = true;
        setResult(searchResult);
        setError(null);
        setLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(messageOf(cause));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callSearch, agentId, debouncedQuery, revision]);

  return {
    matches: result?.matches ?? [],
    truncated: result?.truncated ?? false,
    loading,
    error,
  };
}

/**
 * Fetches one full timeline entry for the record inspector. Results are cached
 * (bounded) per key; an evicted entry reads as null.
 */
export function useRecordDetail(
  agentId: string,
  key: string | null,
): { entry: TimelineEntry | null; loading: boolean } {
  const callDetail = useRpc(getRecordDetailRpc);
  const [entry, setEntry] = useState<TimelineEntry | null>(null);
  const [loading, setLoading] = useState(false);
  // Positive entries only; a null (evicted) result is refetched.
  const cacheRef = useRef(new Map<string, TimelineEntry>());

  useEffect(() => {
    if (!key) {
      setEntry(null);
      setLoading(false);
      return;
    }
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      // Re-insert to refresh recency.
      cacheRef.current.delete(key);
      cacheRef.current.set(key, cached);
      setEntry(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    callDetail({ agentId, key })
      .then((result) => {
        if (cancelled) return;
        const value = (result.entry ?? null) as TimelineEntry | null;
        if (value !== null) {
          const cache = cacheRef.current;
          cache.delete(key);
          cache.set(key, value);
          if (cache.size > DETAIL_CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
        }
        setEntry(value);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setEntry(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callDetail, agentId, key]);

  return { entry, loading };
}

export interface WorkspaceAgent {
  id: string;
  title: string;
  status: string;
  provider: string;
  model: string | null;
  /** Recency signal for ordering; the client list exposes `updatedAt`. */
  lastActivityAt: string;
}

export interface WorkspaceAgentsState {
  agents: WorkspaceAgent[];
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/**
 * Lists the active agents in one workspace. The daemon's agent request filters by
 * project keys rather than workspace, so the workspace filter is applied here. A
 * debounced relist keeps the selector current as agents start, stop, or close.
 */
export function useWorkspaceAgents(workspaceId: string): WorkspaceAgentsState {
  const paseo = usePaseo();
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const result = await paseo.agents.list({ scope: "active" });
      if (disposedRef.current) return;
      setAgents(
        result.entries
          .filter((entry) => entry.agent.workspaceId === workspaceId && !entry.agent.archivedAt)
          .map((entry) => ({
            id: entry.agent.id,
            title: agentTitle(entry.agent),
            status: entry.agent.status,
            provider: entry.agent.provider,
            model: entry.agent.model ?? null,
            // The client's agent list carries `updatedAt`, not the SDK
            // snapshot's `lastActivityAt`; use it for recency.
            lastActivityAt: entry.agent.updatedAt,
          }))
          .sort(compareAgents),
      );
      setError(null);
    } catch (cause) {
      if (!disposedRef.current) setError(messageOf(cause));
    }
  }, [paseo, workspaceId]);

  useEffect(() => {
    disposedRef.current = false;
    setLoading(true);
    void load().finally(() => {
      if (!disposedRef.current) setLoading(false);
    });
    const schedule = () => {
      if (timerRef.current !== null) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void load();
      }, POLL_FAST_MS);
    };
    const unsubscribe = paseo.agents.subscribe(() => schedule());
    return () => {
      disposedRef.current = true;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      unsubscribe();
    };
  }, [paseo, load]);

  return {
    agents,
    loading,
    error,
    refresh: () => void load(),
  };
}

export interface WorkspaceOption {
  id: string;
  title: string;
}

export interface WorkspacesState {
  workspaces: WorkspaceOption[];
  loading: boolean;
  error: string | null;
}

/**
 * Lists every workspace. The full-screen trajectory screen uses this to offer a
 * workspace picker when it is opened without a workspace id (for example from
 * the command palette on a compact layout).
 */
export function useWorkspaces(): WorkspacesState {
  const paseo = usePaseo();
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    setLoading(true);
    const load = async () => {
      try {
        const result = await paseo.workspaces.list();
        if (disposedRef.current) return;
        setWorkspaces(
          result.entries
            .filter((workspace) => !workspace.archivingAt)
            .map((workspace) => ({
              id: workspace.id,
              title: workspace.title ?? workspace.name ?? workspace.projectDisplayName,
            })),
        );
        setError(null);
      } catch (cause) {
        if (!disposedRef.current) setError(messageOf(cause));
      }
    };
    void load().finally(() => {
      if (!disposedRef.current) setLoading(false);
    });
    const unsubscribe = paseo.workspaces.subscribe(() => void load());
    return () => {
      disposedRef.current = true;
      unsubscribe();
    };
  }, [paseo]);

  return { workspaces, loading, error };
}

/** Running agents first, then the most recently active. */
function compareAgents(a: WorkspaceAgent, b: WorkspaceAgent): number {
  const rank = (agent: WorkspaceAgent) => (agent.status === "running" ? 0 : 1);
  const byStatus = rank(a) - rank(b);
  return byStatus !== 0 ? byStatus : b.lastActivityAt.localeCompare(a.lastActivityAt);
}

function agentTitle(agent: { title: string | null; provider: string; id: string }): string {
  if (agent.title) return agent.title;
  return agent.id.length > 8 ? `${agent.provider} · ${agent.id.slice(0, 8)}` : `${agent.provider} · ${agent.id}`;
}

/** Precise local wall clock with milliseconds. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${time}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
