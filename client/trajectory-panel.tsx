import type { PluginTheme } from "@getpaseo/plugin";
import {
  FlatList,
  Icon,
  Modal,
  ScrollView,
  TextInput as ModalTextInput,
} from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  Text,
  TextInput,
  View,
  type FlatList as NativeFlatList,
  type TextInput as NativeTextInput,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { itemColor, mixColor } from "../shared/trajectory-preview";
import type { PreviewRow, PreviewTurn } from "../shared/trajectory-rpc";
import { buildDisplayRows, toolStepKey, type LedgerRow } from "./trajectory-rows";
import { IconButton } from "./icon-button";
import { RecordDetail, RecordDetailHeader } from "./record-detail";
import { TrajectoryTimeline } from "./trajectory-timeline";
import {
  useRecordDetail,
  useTrajectory,
  useTrajectorySearch,
  useWorkspaceAgents,
  type WorkspaceAgent,
} from "./trajectory-data";

/**
 * Props the ledger needs, shared by the workspace panel and the full-screen
 * trajectory screen so both render the exact same view.
 */
export type TrajectoryViewProps = {
  theme: PluginTheme;
  layout: { compact: boolean };
  workspaceId: string;
};

const DEFAULT_INSPECTOR_WIDTH = 380;
const MIN_INSPECTOR_WIDTH = 120;
const MIN_LEDGER_WIDTH = 100;
const MAX_INSPECTOR_WIDTH = 720;
const DEFAULT_INSPECTOR_HEIGHT = 320;
const MIN_INSPECTOR_HEIGHT = 100;
const MIN_LEDGER_HEIGHT = 120;
const MAX_INSPECTOR_HEIGHT = 720;
/** Measured body width below which the inspector docks below the ledger instead of beside it. */
const SIDE_PLACEMENT_MIN_WIDTH = 560;
/** Ledger width below which turn margin labels collapse to `#N`. */
const NARROW_TURN_LABEL_WIDTH = 380;
/** Cap on rows mounted with the first tail page: the page mounts in one commit,
 * so the ledger's content height is final before the tail scroll runs. */
const INITIAL_RENDER_ROWS = 1000;
/** Safety reveal for the hidden-until-tail-positioned ledger. */
const TAIL_REVEAL_FALLBACK_MS = 400;

type InspectorPlacement = "side" | "bottom";

function createStyles(theme: PluginTheme, compact: boolean) {
  // One density token for every horizontal inset so desktop and compact share
  // a single spacing curve.
  const pad = 4;
  // The toolbar sits above the timeline band; it breathes a little more from
  // the pane edges than the ledger rows below.
  const toolbarPad = 8;
  // A hair below the brightest text so rows read softer than the app's primary
  // text without dropping all the way to the muted token.
  const entryText = mixColor(theme.colors.foreground, theme.colors.surface0, 0.18);
  const entryDetail = mixColor(theme.colors.foreground, theme.colors.surface0, 0.44);
  const stepLine = mixColor(theme.colors.foreground, theme.colors.surface0, 0.85);
  return {
    root: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 } satisfies ViewStyle,
    toolbar: {} satisfies ViewStyle,
    // The agent/reload row is the header.
    toolbarHeader: {
      paddingHorizontal: toolbarPad,
      paddingTop: 10,
      paddingBottom: 6,
    } satisfies ViewStyle,
    // The find-bar row is grouped with the ledger it filters: a roomier gap
    // above it, a tighter one below.
    toolbarFindRow: {
      paddingHorizontal: toolbarPad,
      paddingTop: 10,
      paddingBottom: 4,
    } satisfies ViewStyle,
    toolbarRow: { flexDirection: "row", alignItems: "center", gap: 8 } satisfies ViewStyle,
    toolbarMeta: { color: theme.colors.foregroundMuted, fontSize: 12, flex: 1 } satisfies TextStyle,
    // Empty header-row filler so the find-bar and actions stay right-aligned.
    toolbarSpacer: { flex: 1 } satisfies ViewStyle,
    // Collapse/expand-all ghost button: borderless so it sits quietly beside
    // the bordered find-bar, matching the header's icon-button controls.
    turnsToggle: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      flexShrink: 0,
      paddingHorizontal: 5,
      paddingVertical: 2,
      borderRadius: 6,
      minHeight: 20,
    } satisfies ViewStyle,
    turnsToggleHovered: { backgroundColor: theme.colors.surface2 } satisfies ViewStyle,
    turnsToggleLabel: { color: theme.colors.foregroundMuted, fontSize: 12 } satisfies TextStyle,
    // Inline find-bar (wide layouts); compact layouts get a full-width row.
    // Grows with the pane (capped) so the input keeps room when the match
    // controls appear.
    searchBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      // Pin the height so the clear button appearing cannot grow the box:
      // clear button (20) + padding (6) + border (2) = 28.
      minHeight: 28,
      flexBasis: 280,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 220,
      maxWidth: 420,
    } satisfies ViewStyle,
    // Compact: the search box fills the right half of the row, with the fold
    // control on the left half.
    searchBoxCompact: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      minHeight: 28,
      flexGrow: 0,
      flexShrink: 1,
      flexBasis: "50%",
      minWidth: 140,
    } satisfies ViewStyle,
    searchInput: {
      flex: 1,
      minWidth: 0,
      padding: 0,
      color: theme.colors.foreground,
      fontSize: 12,
    } satisfies TextStyle,
    searchCount: { color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 0 } satisfies TextStyle,
    agentSelector: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      flexShrink: 1,
      minWidth: 0,
      maxWidth: compact ? 180 : 260,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: theme.colors.border,
      // Match the search box and refresh control so the header row reads level.
      minHeight: 28,
    } satisfies ViewStyle,
    agentSelectorDisabled: { opacity: 0.5 } satisfies ViewStyle,
    agentSelectorLabel: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 } satisfies TextStyle,
    agentStatusDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 } satisfies ViewStyle,
    // Picker search row, above the agent list.
    agentSearchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    } satisfies ViewStyle,
    agentSearchInput: { flex: 1, minWidth: 0, padding: 0, color: theme.colors.foreground, fontSize: 13 } satisfies TextStyle,
    agentList: { flex: 1 } satisfies ViewStyle,
    agentRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    } satisfies ViewStyle,
    agentRowSelected: { backgroundColor: theme.colors.surface2 } satisfies ViewStyle,
    agentRowHovered: { backgroundColor: theme.colors.surface1 } satisfies ViewStyle,
    agentRowText: { flex: 1, minWidth: 0, gap: 2 } satisfies ViewStyle,
    agentRowTitle: { color: theme.colors.foreground, fontSize: 13, flex: 1 } satisfies TextStyle,
    agentRowMeta: { color: theme.colors.foregroundMuted, fontSize: 11 } satisfies TextStyle,
    body: { flex: 1, minHeight: 0 } satisfies ViewStyle,
    bodySide: { flexDirection: "row" } satisfies ViewStyle,
    bodyBottom: { flexDirection: "column" } satisfies ViewStyle,
    // Web-only style (RN's ViewStyle type omits userSelect) used to stop text
    // selection while dragging the divider past a clamp limit.
    bodyResizing: { userSelect: "none" } as unknown as ViewStyle,
    ledger: { flex: 1, minHeight: 0, minWidth: 0 } satisfies ViewStyle,
    list: { flex: 1 } satisfies ViewStyle,
    // Ledger pre-positioning: never paint mid-page before the tail scroll.
    hidden: { opacity: 0 } satisfies ViewStyle,
    listContent: { paddingVertical: 4 } satisfies ViewStyle,
    footer: { paddingVertical: 12, alignItems: "center" } satisfies ViewStyle,
    inspector: {
      // RN's ScrollView frame sets flexGrow/flexShrink, which would override the
      // explicit width/height we set for the divider drag.
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: "auto",
      backgroundColor: theme.colors.surface1,
      minWidth: 0,
      minHeight: 0,
    } satisfies ViewStyle,
    inspectorSide: { borderLeftWidth: 1, borderLeftColor: theme.colors.border } satisfies ViewStyle,
    inspectorBottom: { borderTopWidth: 1, borderTopColor: theme.colors.border } satisfies ViewStyle,
    inspectorContent: { flexGrow: 1 } satisfies ViewStyle,
    resizerSide: {
      width: 5,
      alignSelf: "stretch",
      backgroundColor: "transparent",
      userSelect: "none",
      // Web supports col-resize even though RN's CursorValue type does not list it.
      cursor: "col-resize",
    } as unknown as ViewStyle,
    resizerBottom: {
      height: 5,
      alignSelf: "stretch",
      backgroundColor: "transparent",
      userSelect: "none",
      cursor: "row-resize",
    } as unknown as ViewStyle,
    centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 } satisfies ViewStyle,
    muted: { color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" } satisfies TextStyle,
    error: { color: theme.colors.statusDanger, fontSize: 13, textAlign: "center" } satisfies TextStyle,
    stepRule: {
      height: 0.5,
      backgroundColor: stepLine,
    } satisfies ViewStyle,
    // Left-margin turn label: a non-interactive chip aligned with a turn's
    // first ledger row — `Turn N` when wide, `#N` when narrow. The
    // session-level group (no turn id) leaves it blank.
    turnGutter: { width: 42, paddingRight: 0 } satisfies ViewStyle,
    turnGutterNarrow: { width: 28, paddingRight: 0 } satisfies ViewStyle,
    turnGutterChip: {
      alignSelf: "flex-start",
      paddingHorizontal: 2,
      paddingVertical: 1,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: mixColor(theme.colors.surface0, itemColor("user", theme), 0.4),
      backgroundColor: mixColor(theme.colors.surface0, itemColor("user", theme), 0.16),
    } satisfies ViewStyle,
    turnGutterLabel: { color: theme.colors.foreground, fontSize: 9 } satisfies TextStyle,
    // Thicker rule marking the top of a turn, above its first (user) record.
    turnStart: {
      borderTopWidth: 1,
      borderTopColor: mixColor(theme.colors.foreground, theme.colors.surface0, 0.72),
    } satisfies ViewStyle,
    entryRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: pad,
      paddingVertical: 6,
    } satisfies ViewStyle,
    entryRowSelected: { backgroundColor: theme.colors.surface2 } satisfies ViewStyle,
    entryRowHovered: { backgroundColor: theme.colors.surface1 } satisfies ViewStyle,
    entryIcon: { width: 18, alignItems: "center" } satisfies ViewStyle,
    entryBody: { flex: 1, minWidth: 0 } satisfies ViewStyle,
    entryLine: { color: entryText, fontSize: 13, lineHeight: 18 } satisfies TextStyle,
    // The fold summary reads as a record row: same chrome and hover
    // highlight, its text aligned with the record body.
    foldText: { color: entryDetail, fontSize: 13, lineHeight: 18 } satisfies TextStyle,
    entryLineRow: { flexDirection: "row", alignItems: "center" } satisfies ViewStyle,
    entryLabel: { color: entryText, fontSize: 13, lineHeight: 18, paddingRight: 8 } satisfies TextStyle,
    // Label + input size to their content, capped at half the row, so the
    // arrow hugs the input and never passes the row's middle.
    entryInputGroup: {
      flexDirection: "row",
      alignItems: "center",
      maxWidth: "50%",
    } satisfies ViewStyle,
    entryInput: { color: entryText, fontSize: 13, lineHeight: 18, flexShrink: 1 } satisfies TextStyle,
    entryOutput: { color: entryText, fontSize: 13, lineHeight: 18, flex: 1, textAlign: "left" } satisfies TextStyle,
    entryArrow: { color: entryText, fontSize: 13, lineHeight: 18, paddingHorizontal: 6 } satisfies TextStyle,
    entrySummary: { color: entryDetail } satisfies TextStyle,
    entryError: { color: theme.colors.statusDanger } satisfies TextStyle,
    inspectorScroll: { flex: 1, minHeight: 0 } satisfies ViewStyle,
    banner: {
      marginHorizontal: pad,
      marginTop: 8,
      marginBottom: 4,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    } satisfies ViewStyle,
    bannerErrorText: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 16 } satisfies TextStyle,
    bannerNoticeText: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 } satisfies TextStyle,
  };
}

type Styles = ReturnType<typeof createStyles>;

/**
 * Workspace trajectory: one panel per workspace with an agent selector. The
 * selected agent's ledger is delegated to {@link TrajectoryLedger}.
 */
export function TrajectoryPanel({ theme, layout, workspaceId }: TrajectoryViewProps) {
  const compact = layout.compact;
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const { agents, loading, error, refresh } = useWorkspaceAgents(workspaceId);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Manual inspector placement choice; null follows the width-derived default.
  const [placementOverride, setPlacementOverride] = useState<InspectorPlacement | null>(null);

  useEffect(() => {
    if (agents.length === 0) {
      if (selectedAgentId !== null) setSelectedAgentId(null);
      return;
    }
    if (!selectedAgentId || !agents.some((agent) => agent.id === selectedAgentId)) {
      // Default to the first agent (running-first, then most recently active).
      setSelectedAgentId(agents[0].id);
    }
  }, [agents, selectedAgentId]);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;

  const accessory = (
    <AgentSelector
      title={selectedAgent?.title ?? null}
      status={selectedAgent?.status ?? null}
      label={loading ? "Loading agents…" : "No agents"}
      disabled={agents.length === 0}
      onPress={() => setPickerOpen(true)}
      styles={styles}
      theme={theme}
    />
  );

  return (
    <View style={styles.root}>
      {selectedAgentId ? (
        <TrajectoryLedger
          key={selectedAgentId}
          agentId={selectedAgentId}
          theme={theme}
          compact={compact}
          headerAccessory={accessory}
          placementOverride={placementOverride}
          onSetPlacementOverride={setPlacementOverride}
        />
      ) : (
        <>
          <TrajectoryToolbar
            accessory={accessory}
            compact={compact}
            meta={error ?? (loading ? "Loading agents…" : "No agents")}
            onRefresh={refresh}
            styles={styles}
            theme={theme}
          />
          <View style={styles.centered}>
            <Text style={error ? styles.error : styles.muted}>
              {error ?? (loading ? "Loading agents…" : "No agents in this workspace yet.")}
            </Text>
          </View>
        </>
      )}
      <AgentPicker
        agents={agents}
        selectedAgentId={selectedAgentId}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={setSelectedAgentId}
        compact={compact}
        styles={styles}
        theme={theme}
      />
    </View>
  );
}

/** One agent's trajectory: a turn-aware event ledger with a record inspector. */
function TrajectoryLedger({
  agentId,
  theme,
  compact,
  headerAccessory,
  placementOverride,
  onSetPlacementOverride,
}: {
  agentId: string;
  theme: PluginTheme;
  compact: boolean;
  headerAccessory?: ReactNode;
  placementOverride: InspectorPlacement | null;
  onSetPlacementOverride(placement: InspectorPlacement): void;
}) {
  const trajectory = useTrajectory(agentId);
  const { rows, refresh, revision } = trajectory;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const search = useTrajectorySearch(agentId, searchQuery, revision);
  // Steps whose tool calls are folded behind a summary row, keyed by
  // turn index + step number (both always present on entry rows). The global
  // Calls toggle folds every step; tapping a summary row unfolds just that one.
  const [collapsedToolSteps, setCollapsedToolSteps] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toolStepKeys = useMemo(() => {
    const keys: string[] = [];
    for (const row of rows) {
      const key = toolStepKey(row);
      if (key !== null && !keys.includes(key)) keys.push(key);
    }
    return keys;
  }, [rows]);
  const allToolStepsCollapsed =
    toolStepKeys.length > 0 && toolStepKeys.every((key) => collapsedToolSteps.has(key));
  /** Folds every step's tool calls, or unfolds them all when already folded. */
  const toggleAllToolSteps = useCallback(() => {
    setCollapsedToolSteps((current) => {
      if (toolStepKeys.length === 0) return current;
      return toolStepKeys.every((key) => current.has(key)) ? new Set() : new Set(toolStepKeys);
    });
  }, [toolStepKeys]);
  /** Re-expands one step's tool calls (its summary row's tap). */
  const expandToolStep = useCallback((key: string) => {
    setCollapsedToolSteps((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  // Turns folded away by the toolbar's Turns control. The turn label itself
  // stays inert; folding is only reachable from the global control (or a
  // folded turn's summary row).
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const turnIds = useMemo(
    () =>
      rows.reduce<string[]>((ids, row) => {
        if (row.kind === "turn" && row.turn?.id) ids.push(row.turn.id);
        return ids;
      }, []),
    [rows],
  );
  const allTurnsCollapsed = turnIds.length > 0 && turnIds.every((id) => collapsedTurns.has(id));
  /** Folds every turn, or unfolds them all when already folded. */
  const toggleAllTurns = useCallback(() => {
    setCollapsedTurns((current) => {
      if (turnIds.length === 0) return current;
      return turnIds.every((id) => current.has(id)) ? new Set() : new Set(turnIds);
    });
  }, [turnIds]);
  /** Re-expands one folded turn (its summary row's tap). */
  const expandTurn = useCallback((turnId: string | null) => {
    if (turnId === null) return;
    setCollapsedTurns((current) =>
      current.has(turnId) ? new Set([...current].filter((id) => id !== turnId)) : current,
    );
  }, []);
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [inspectorHeight, setInspectorHeight] = useState(DEFAULT_INSPECTOR_HEIGHT);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [ledgerWidth, setLedgerWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  // Dock beside the ledger while the body has room for both columns; stack
  // below it in narrower panes (explorer sidebar, split layouts) — the same
  // stacked shape compact layouts get. A manual choice via the toolbar toggle
  // wins over this default.
  const autoPlacement: InspectorPlacement =
    bodyWidth > 0 && bodyWidth < SIDE_PLACEMENT_MIN_WIDTH ? "bottom" : "side";
  const placement: InspectorPlacement = placementOverride ?? autoPlacement;
  const listRef = useRef<NativeFlatList<LedgerRow>>(null);
  // Starts pinned to the tail (the initial page is the session tail); flips
  // false once the user scrolls away so live rows stop interrupting, and
  // scroll-up near the top loads the next older page.
  const followRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  // Opening must land on the newest records without a visible jump: the list
  // mounts hidden and is revealed only once it is verified parked at the end
  // (a scroll event at the tail, a page that fits the viewport, or the safety
  // timer below).
  const [tailPositioned, setTailPositioned] = useState(false);
  const initialRenderRowsRef = useRef<number | null>(null);
  const listHeightRef = useRef(0);
  const contentHeightRef = useRef(0);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTail = useCallback(() => {
    if (revealTimerRef.current !== null) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    setTailPositioned(true);
  }, []);
  useEffect(
    () => () => {
      if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    },
    [],
  );
  const widthRef = useRef(inspectorWidth);
  const heightRef = useRef(inspectorHeight);
  const bodyWidthRef = useRef(bodyWidth);
  const bodyHeightRef = useRef(bodyHeight);
  const placementRef = useRef(placement);
  const startSizeRef = useRef(0);
  widthRef.current = inspectorWidth;
  heightRef.current = inspectorHeight;
  bodyWidthRef.current = bodyWidth;
  bodyHeightRef.current = bodyHeight;
  placementRef.current = placement;

  useEffect(() => {
    const max =
      bodyWidth > 0 ? Math.max(MIN_INSPECTOR_WIDTH, bodyWidth - MIN_LEDGER_WIDTH) : MAX_INSPECTOR_WIDTH;
    setInspectorWidth((width) => Math.min(Math.max(width, MIN_INSPECTOR_WIDTH), max));
  }, [bodyWidth]);

  useEffect(() => {
    const max =
      bodyHeight > 0 ? Math.max(MIN_INSPECTOR_HEIGHT, bodyHeight - MIN_LEDGER_HEIGHT) : MAX_INSPECTOR_HEIGHT;
    setInspectorHeight((height) => Math.min(Math.max(height, MIN_INSPECTOR_HEIGHT), max));
  }, [bodyHeight]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onStartShouldSetPanResponderCapture: () => true,
        onMoveShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponderCapture: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          startSizeRef.current = placementRef.current === "side" ? widthRef.current : heightRef.current;
          setResizing(true);
        },
        onPanResponderMove: (_event, gesture) => {
          if (placementRef.current === "side") {
            const max =
              bodyWidthRef.current > 0
                ? Math.max(MIN_INSPECTOR_WIDTH, bodyWidthRef.current - MIN_LEDGER_WIDTH)
                : MAX_INSPECTOR_WIDTH;
            setInspectorWidth(
              Math.min(Math.max(startSizeRef.current - gesture.dx, MIN_INSPECTOR_WIDTH), max),
            );
          } else {
            const max =
              bodyHeightRef.current > 0
                ? Math.max(MIN_INSPECTOR_HEIGHT, bodyHeightRef.current - MIN_LEDGER_HEIGHT)
                : MAX_INSPECTOR_HEIGHT;
            setInspectorHeight(
              Math.min(Math.max(startSizeRef.current - gesture.dy, MIN_INSPECTOR_HEIGHT), max),
            );
          }
        },
        onPanResponderRelease: () => setResizing(false),
        onPanResponderTerminate: () => setResizing(false),
      }),
    [],
  );

  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);

  // The initial page is the session tail: park the ledger on the newest rows
  // before the first paint. A layout effect (not a plain effect) so the scroll
  // lands in the same frame the rows mount; the still-hidden list is revealed
  // only once it is actually sitting at the end.
  useLayoutEffect(() => {
    if (trajectory.loading) {
      didInitialScrollRef.current = false;
      initialRenderRowsRef.current = null;
      return;
    }
    if (!didInitialScrollRef.current && rows.length > 0) {
      didInitialScrollRef.current = true;
      setTailPositioned(false);
      followRef.current = true;
      listRef.current?.scrollToEnd({ animated: false });
      // A page that fits the viewport never scrolls (no event fires), and a
      // lost scroll event must not leave the ledger hidden: reveal regardless.
      if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
      revealTimerRef.current = setTimeout(revealTail, TAIL_REVEAL_FALLBACK_MS);
    }
  }, [trajectory.loading, rows.length, revealTail]);

  // --- Search ---------------------------------------------------------------

  const matchKeys = useMemo(() => new Set(search.matches.map((match) => match.key)), [search.matches]);

  // Just the count. The transient "Searching…" / "Search failed" strings read
  // as noise in the toolbar, so those states render nothing.
  const searchCountText = useMemo(() => {
    const query = searchQuery.trim();
    if (!query || search.loading || search.error) return "";
    return `${search.matches.length}${search.truncated ? "+" : ""}`;
  }, [searchQuery, search.loading, search.error, search.matches.length, search.truncated]);

  const selectedRow = useMemo(
    () => (selectedKey ? rows.find((row) => row.key === selectedKey && row.kind === "entry") ?? null : null),
    [rows, selectedKey],
  );
  const { entry: selectedEntry, loading: detailLoading } = useRecordDetail(agentId, selectedRow?.key ?? null);
  const entryCount = useMemo(
    () => rows.reduce((count, row) => (row.kind === "entry" ? count + 1 : count), 0),
    [rows],
  );
  const hasEntries = entryCount > 0;
  // While a query has matches, the ledger shows the results only. Otherwise
  // every row renders; collapsed tool steps fold into a summary row.
  // Filter whenever a query is active (unless the search failed): only matching
  // entries are shown, and non-matching timeline markers dim — including when
  // nothing matches at all.
  const filtering = searchQuery.trim().length > 0 && search.error === null;
  const displayRows = useMemo<LedgerRow[]>(
    () => buildDisplayRows(rows, { filtering, matchKeys, collapsedTurns, collapsedToolSteps }),
    [rows, filtering, matchKeys, collapsedTurns, collapsedToolSteps],
  );
  // Rows re-render when the selection changes.
  const listExtraData = useMemo(
    () => ({ selectedKey, collapsedToolSteps, collapsedTurns }),
    [selectedKey, collapsedToolSteps, collapsedTurns],
  );
  // Frozen at the first data render: VirtualizedList re-derives the retained
  // initial region from the prop on every update, so a live value would keep
  // widening it as older pages load and defeat virtualization.
  if (initialRenderRowsRef.current === null && displayRows.length > 0) {
    initialRenderRowsRef.current = Math.min(displayRows.length, INITIAL_RENDER_ROWS);
  }

  /** Selects a timeline marker, opening the inspector and revealing its row. */
  const focusRecord = useCallback(
    (key: string) => {
      const alreadySelected = selectedKey === key;
      setSelectedKey(alreadySelected ? null : key);
      if (alreadySelected) return;
      const index = displayRows.findIndex((row) => row.key === key);
      if (index < 0) return;
      // Let the selection render (and any fold expansion settle) first.
      setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 }), 0);
    },
    [selectedKey, displayRows],
  );

  // Turn labels collapse to `#N` on narrow ledgers.
  const narrow = compact || (ledgerWidth > 0 && ledgerWidth < NARROW_TURN_LABEL_WIDTH);

  const renderRow = useCallback(
    ({ item }: { item: LedgerRow }) => {
      if (item.kind === "fold") {
        const turn = item.turn;
        if (!turn) return null;
        return (
          <FoldRow
            turn={turn}
            leadTurn={item.leadTurn}
            narrow={narrow}
            styles={styles}
            onPress={() => expandTurn(turn.id)}
          />
        );
      }
      if (item.kind === "toolfold") {
        const fold = item.toolFold;
        if (!fold) return null;
        return (
          <ToolFoldRow
            count={fold.count}
            names={fold.names}
            leadTurn={item.leadTurn}
            narrow={narrow}
            styles={styles}
            onPress={() => expandToolStep(fold.key)}
          />
        );
      }
      if (item.kind === "step") {
        return <View style={styles.stepRule} />;
      }
      if (item.kind !== "entry") return null;
      return (
        <LedgerRowItem
          row={item}
          leadTurn={item.leadTurn}
          narrow={narrow}
          selected={selectedKey === item.key}
          iconColor={itemColor(item.danger ? "danger" : (item.color ?? "muted"), theme)}
          styles={styles}
          onPress={() => {
            setSelectedKey((current) => (current === item.key ? null : item.key));
          }}
        />
      );
    },
    [selectedKey, styles, theme, expandToolStep, expandTurn, narrow],
  );

  return (
    <View style={styles.root}>
      <TrajectoryToolbar
        accessory={headerAccessory}
        compact={compact}
        onRefresh={refresh}
        search={{
          query: searchQuery,
          onQueryChange: setSearchQuery,
          countText: searchCountText,
        }}
        turnToggleAction={
          turnIds.length > 0 ? (
            <FoldToggle
              label="Turns"
              collapsed={allTurnsCollapsed}
              onPress={toggleAllTurns}
              styles={styles}
              theme={theme}
            />
          ) : undefined
        }
        toolToggleAction={
          toolStepKeys.length > 0 ? (
            <FoldToggle
              label="Calls"
              collapsed={allToolStepsCollapsed}
              onPress={toggleAllToolSteps}
              styles={styles}
              theme={theme}
            />
          ) : undefined
        }
        trailingAction={
          !compact && selectedRow ? (
            <IconButton
              name={placement === "side" ? "PanelBottom" : "PanelRight"}
              label={placement === "side" ? "Show inspector at bottom" : "Show inspector to the side"}
              onPress={() => onSetPlacementOverride(placement === "side" ? "bottom" : "side")}
              theme={theme}
            />
          ) : undefined
        }
        styles={styles}
        theme={theme}
      />

      {hasEntries ? (
        <TrajectoryTimeline
          rows={rows}
          theme={theme}
          selectedKey={selectedKey}
          matchKeys={matchKeys}
          dimNonMatches={filtering}
          onSelectRow={focusRecord}
          onReachStart={trajectory.loadOlder}
        />
      ) : null}

      <View
        style={[
          styles.body,
          placement === "side" ? styles.bodySide : styles.bodyBottom,
          resizing ? styles.bodyResizing : null,
        ]}
        onLayout={(event) => {
          setBodyWidth(event.nativeEvent.layout.width);
          setBodyHeight(event.nativeEvent.layout.height);
        }}
      >
        <View
          style={styles.ledger}
          onLayout={(event) => setLedgerWidth(event.nativeEvent.layout.width)}
        >
          {renderLedger()}
        </View>
        {!compact && selectedRow ? (
          <>
            <View
              {...panResponder.panHandlers}
              style={placement === "side" ? styles.resizerSide : styles.resizerBottom}
            />
            <View
              style={[
                styles.inspector,
                placement === "side" ? styles.inspectorSide : styles.inspectorBottom,
                placement === "side" ? { width: inspectorWidth } : { height: inspectorHeight },
              ]}
            >
              {selectedRow ? (
                selectedEntry ? (
                  <>
                    <RecordDetailHeader
                      entry={selectedEntry}
                      theme={theme}
                      turnIndex={selectedRow.turnIndex ?? null}
                      step={selectedRow.step ?? null}
                      onClose={() => setSelectedKey(null)}
                    />
                    <ScrollView style={styles.inspectorScroll} contentContainerStyle={styles.inspectorContent}>
                      <RecordDetail
                        entry={selectedEntry}
                        provider={selectedRow.provider ?? ""}
                        theme={theme}
                        compact={false}
                      />
                    </ScrollView>
                  </>
                ) : (
                  <View style={styles.centered}>
                    {detailLoading ? (
                      <ActivityIndicator color={theme.colors.foregroundMuted} />
                    ) : (
                      <Text style={styles.muted}>Record content is no longer available.</Text>
                    )}
                  </View>
                )
              ) : null}
            </View>
          </>
        ) : null}
      </View>

      {compact ? (
        <Modal
          icon={
            selectedRow && selectedRow.icon ? (
              <Icon
                name={selectedRow.icon}
                size={16}
                color={itemColor(selectedRow.danger ? "danger" : (selectedRow.color ?? "muted"), theme)}
              />
            ) : undefined
          }
          title={
            selectedRow
              ? selectedRow.turnIndex !== undefined
                ? `Turn ${selectedRow.turnIndex}${
                    selectedRow.step !== null && selectedRow.step !== undefined
                      ? ` · Step ${selectedRow.step}`
                      : ""
                  }`
                : (selectedRow.label ?? "Record")
              : "Record"
          }
          open={selectedRow !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedKey(null);
          }}
        >
          {selectedRow ? (
            <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
              {selectedEntry ? (
                <RecordDetail
                  entry={selectedEntry}
                  provider={selectedRow.provider ?? ""}
                  theme={theme}
                  compact
                />
              ) : (
                <View style={styles.centered}>
                  {detailLoading ? (
                    <ActivityIndicator color={theme.colors.foregroundMuted} />
                  ) : (
                    <Text style={styles.muted}>Record content is no longer available.</Text>
                  )}
                </View>
              )}
            </Modal.Content>
          ) : null}
        </Modal>
      ) : null}
    </View>
  );

  function renderLedger() {
    if (trajectory.loading && rows.length === 0) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.foregroundMuted} />
        </View>
      );
    }
    if (rows.length === 0) {
      return (
        <View style={styles.centered}>
          <Text style={trajectory.error ? styles.error : styles.muted}>
            {trajectory.error ?? "No activity yet."}
          </Text>
        </View>
      );
    }
    // A live query with no matches leaves the ledger empty; the find-bar's
    // "No matches" (and the dimmed overview) is the whole story.
    if (filtering && !search.loading && displayRows.length === 0) {
      return (
        <View style={styles.centered}>
          <Text style={styles.muted}>No matching records.</Text>
        </View>
      );
    }
    const header = (
      <View>
        {trajectory.error ? (
          <View style={styles.banner}>
            <Text style={styles.bannerErrorText}>{trajectory.error}</Text>
          </View>
        ) : null}
        {trajectory.notice ? (
          <View style={styles.banner}>
            <Text style={styles.bannerNoticeText}>{trajectory.notice}</Text>
          </View>
        ) : null}
        {trajectory.loadingOlder ? (
          <View style={styles.footer}>
            <ActivityIndicator color={theme.colors.foregroundMuted} />
          </View>
        ) : null}
      </View>
    );
    return (
      <FlatList
        ref={listRef}
        data={displayRows}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        extraData={listExtraData}
        style={[styles.list, tailPositioned ? null : styles.hidden]}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={header}
        onRefresh={trajectory.refresh}
        refreshing={trajectory.loading && rows.length > 0}
        // The list opens at the tail; reaching the top loads the next older
        // page. Prepended rows land at offset 0, so the newly loaded older
        // rows are what the viewport shows — no scroll adjustment needed.
        onStartReached={() => {
          if (!followRef.current) trajectory.loadOlder();
        }}
        onStartReachedThreshold={0.4}
        initialNumToRender={initialRenderRowsRef.current ?? 10}
        // Markers can target a row far outside the rendered window; fall back
        // to an estimated offset, then retry once it has been measured.
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
          setTimeout(() => {
            listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
          }, 120);
        }}
        scrollEventThrottle={16}
        onScroll={(event) => {
          const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
          const atTail = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
          followRef.current = atTail;
          if (!tailPositioned && atTail) revealTail();
        }}
        onLayout={(event) => {
          listHeightRef.current = event.nativeEvent.layout.height;
          if (
            !tailPositioned &&
            contentHeightRef.current > 0 &&
            contentHeightRef.current <= listHeightRef.current
          ) {
            revealTail();
          }
        }}
        onContentSizeChange={(_width, height) => {
          contentHeightRef.current = height;
          if (followRef.current) listRef.current?.scrollToEnd({ animated: false });
          // The whole page fits the viewport: there is no tail to scroll to,
          // so reveal at once.
          if (!tailPositioned && listHeightRef.current > 0 && height <= listHeightRef.current) {
            revealTail();
          }
        }}
      />
    );
  }
}

/** Find-bar state handed to the toolbar. */
interface SearchControl {
  query: string;
  onQueryChange(query: string): void;
  /** "12", "12+", or ""; empty while the query is empty, loading, or failed. */
  countText: string;
}

/** Toolbar find-bar: query input with the match count and a clear button. */
function SearchBox({
  control,
  boxStyle,
  compact,
  styles,
  theme,
}: {
  control: SearchControl;
  /** Box frame: inline in the header row (wide) or a full-width row (compact). */
  boxStyle: ViewStyle;
  compact: boolean;
  styles: Styles;
  theme: PluginTheme;
}) {
  const active = control.query.trim().length > 0;
  return (
    <View style={boxStyle}>
      <Icon name="Search" size={12} color={theme.colors.foregroundMuted} />
      <TextInput
        style={styles.searchInput}
        value={control.query}
        onChangeText={control.onQueryChange}
        placeholder={compact ? "Search…" : "Search trajectory…"}
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onKeyPress={(event) => {
          if (event.nativeEvent.key === "Escape") control.onQueryChange("");
        }}
        accessibilityLabel="Search trajectory"
      />
      {active ? (
        <>
          {control.countText ? <Text style={styles.searchCount}>{control.countText}</Text> : null}
          <IconButton
            name="X"
            label="Clear search"
            onPress={() => control.onQueryChange("")}
            theme={theme}
            size={13}
            frameSize={20}
          />
        </>
      ) : null}
    </View>
  );
}

function TrajectoryToolbar({
  accessory,
  compact,
  meta,
  onRefresh,
  search,
  turnToggleAction,
  toolToggleAction,
  trailingAction,
  styles,
  theme,
}: {
  accessory?: ReactNode;
  compact: boolean;
  /** Optional status line; an empty spacer keeps the actions right-aligned. */
  meta?: string;
  onRefresh(): void;
  /** Find-bar over the session's records; omitted when there is no ledger. */
  search?: SearchControl;
  /** Collapse/expand-all turns control leading the find-bar row. */
  turnToggleAction?: ReactNode;
  /** Collapse/expand-all tool calls control, beside the turns toggle. */
  toolToggleAction?: ReactNode;
  trailingAction?: ReactNode;
  styles: Styles;
  theme: PluginTheme;
}) {
  return (
    <View style={styles.toolbar}>
      <View style={styles.toolbarHeader}>
        <View style={styles.toolbarRow}>
          {accessory}
          {meta ? (
            <Text style={styles.toolbarMeta} numberOfLines={1}>
              {meta}
            </Text>
          ) : (
            <View style={styles.toolbarSpacer} />
          )}
          {trailingAction}
          <IconButton name="RefreshCw" label="Refresh trajectory" onPress={onRefresh} theme={theme} />
        </View>
      </View>
      {search ? (
        <View style={[styles.toolbarRow, styles.toolbarFindRow]}>
          {turnToggleAction}
          {toolToggleAction}
          <View style={styles.toolbarSpacer} />
          <SearchBox
            control={search}
            boxStyle={compact ? styles.searchBoxCompact : styles.searchBox}
            compact={compact}
            styles={styles}
            theme={theme}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Collapse/expand-all chip: vertical double chevrons plus a label. */
function FoldToggle({
  label,
  collapsed,
  onPress,
  styles,
  theme,
}: {
  /** What the chip folds, e.g. "Turns" or "Calls". */
  label: string;
  /** Everything is folded; the button then expands it all. */
  collapsed: boolean;
  onPress(): void;
  styles: Styles;
  theme: PluginTheme;
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const noun = label.toLowerCase();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={collapsed ? `Expand all ${noun}` : `Collapse all ${noun}`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.turnsToggle, hovered || pressed ? styles.turnsToggleHovered : null]}
    >
      <Icon
        name={collapsed ? "ChevronsUpDown" : "ChevronsDownUp"}
        size={12}
        color={theme.colors.foreground}
      />
      <Text style={styles.turnsToggleLabel}>{label}</Text>
    </Pressable>
  );
}

/** The single agent selector: a chip-styled button that opens the picker. */
function AgentSelector({
  title,
  status,
  label,
  disabled,
  onPress,
  styles,
  theme,
}: {
  /** The selected agent's session title. */
  title: string | null;
  /** Selected agent's status, rendered as a colored dot. */
  status: string | null;
  /** Text shown when there is no agent to summarize (loading or empty). */
  label?: string;
  disabled: boolean;
  onPress(): void;
  styles: Styles;
  theme: PluginTheme;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title ? `Agent: ${title}` : label ?? "Agent"}
      disabled={disabled}
      onPress={onPress}
      style={[styles.agentSelector, disabled ? styles.agentSelectorDisabled : null]}
    >
      {status ? (
        <View style={[styles.agentStatusDot, { backgroundColor: agentStatusColor(status, theme) }]} />
      ) : null}
      <Text style={styles.agentSelectorLabel} numberOfLines={1}>
        {title ?? label ?? "No agents"}
      </Text>
      <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

/** Status dot color shared by the selector and the picker rows. */
function agentStatusColor(status: string, theme: PluginTheme): string {
  switch (status) {
    case "running":
      return theme.colors.accent;
    case "error":
      return theme.colors.statusDanger;
    case "initializing":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

function AgentPicker({
  agents,
  selectedAgentId,
  open,
  onOpenChange,
  onSelect,
  compact,
  styles,
  theme,
}: {
  agents: WorkspaceAgent[];
  selectedAgentId: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSelect(agentId: string): void;
  compact: boolean;
  styles: Styles;
  theme: PluginTheme;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<NativeTextInput>(null);

  // Reset the query on open and, away from compact, focus the search — on
  // compact focusing would pop the keyboard over the list.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlight(0);
    if (compact) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open, compact]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return agents;
    return agents.filter((agent) =>
      [agent.title, agent.provider, agent.model ?? "", agent.status]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [agents, query]);

  // Keep the keyboard cursor inside the (possibly shrunk) result set.
  useEffect(() => {
    setHighlight((current) => (current >= filtered.length ? 0 : current));
  }, [filtered.length]);

  const select = (agent: WorkspaceAgent | undefined) => {
    if (!agent) return;
    onSelect(agent.id);
    onOpenChange(false);
  };

  return (
    <Modal title="Select agent" open={open} onOpenChange={onOpenChange}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
        <View style={styles.agentSearchRow}>
          <Icon name="Search" size={12} color={theme.colors.foregroundMuted} />
          <ModalTextInput
            ref={inputRef}
            style={styles.agentSearchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search agents…"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search agents"
            onKeyPress={(event) => {
              const key = event.nativeEvent.key;
              if (key === "ArrowDown") {
                setHighlight((current) => Math.min(current + 1, Math.max(0, filtered.length - 1)));
              } else if (key === "ArrowUp") {
                setHighlight((current) => Math.max(current - 1, 0));
              } else if (key === "Enter") {
                select(filtered[highlight]);
              } else if (key === "Escape") {
                onOpenChange(false);
              }
            }}
          />
        </View>
        {filtered.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.muted}>No agents match.</Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(agent) => agent.id}
            style={styles.agentList}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item, index }) => (
              <AgentPickerRow
                agent={item}
                selected={item.id === selectedAgentId}
                highlighted={index === highlight}
                onSelect={() => select(item)}
                onHover={() => setHighlight(index)}
                styles={styles}
                theme={theme}
              />
            )}
          />
        )}
      </Modal.Content>
    </Modal>
  );
}

/** One agent row in the picker: title, provider · model · status, a status dot, and a check when selected. */
function AgentPickerRow({
  agent,
  selected,
  highlighted,
  onSelect,
  onHover,
  styles,
  theme,
}: {
  agent: WorkspaceAgent;
  selected: boolean;
  /** The keyboard cursor is on this row. */
  highlighted: boolean;
  onSelect(): void;
  onHover(): void;
  styles: Styles;
  theme: PluginTheme;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={agent.title}
      onPress={onSelect}
      onHoverIn={() => {
        setHovered(true);
        onHover();
      }}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.agentRow,
        selected ? styles.agentRowSelected : null,
        !selected && (hovered || highlighted) ? styles.agentRowHovered : null,
      ]}
    >
      <View style={[styles.agentStatusDot, { backgroundColor: agentStatusColor(agent.status, theme) }]} />
      <View style={styles.agentRowText}>
        <Text style={styles.agentRowTitle} numberOfLines={1}>
          {agent.title}
        </Text>
        <Text style={styles.agentRowMeta} numberOfLines={1}>
          {[agent.provider, agent.model, agent.status].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {selected ? <Icon name="Check" size={14} color={theme.colors.accent} /> : null}
    </Pressable>
  );
}

/** Left-margin turn label for a turn's first ledger row. Purely an
 * annotation: not pressable, no rail or dots. The session-level group (no
 * turn id) leaves the gutter blank. */
function TurnGutter({
  turn,
  narrow,
  styles,
}: {
  turn?: PreviewTurn;
  narrow: boolean;
  styles: Styles;
}) {
  const label = turn && turn.id ? (narrow ? `#${turn.index}` : `Turn ${turn.index}`) : null;
  return (
    <View style={[styles.turnGutter, narrow ? styles.turnGutterNarrow : null]}>
      {label ? (
        <View style={styles.turnGutterChip}>
          <Text style={styles.turnGutterLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** A folded turn's summary row: one line standing in for its hidden rows.
 * Tap re-expands the turn. The turn label, when this is the turn's first
 * shown row, rides in the gutter like any other row. */
function FoldRow({
  turn,
  leadTurn,
  narrow,
  styles,
  onPress,
}: {
  turn: PreviewTurn;
  leadTurn?: PreviewTurn;
  narrow: boolean;
  styles: Styles;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const steps = `${turn.steps} ${turn.steps === 1 ? "step" : "steps"}`;
  const tools = `${turn.tools} ${turn.tools === 1 ? "tool call" : "tool calls"}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Expand turn ${turn.index}: ${steps}, ${tools}`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.entryRow,
        leadTurn?.id ? styles.turnStart : null,
        hovered ? styles.entryRowHovered : null,
      ]}
    >
      <TurnGutter turn={leadTurn} narrow={narrow} styles={styles} />
      <View style={styles.entryIcon} />
      <View style={styles.entryBody}>
        <Text style={styles.foldText} numberOfLines={1}>
          {`⋯ ${steps} · ${tools}`}
        </Text>
      </View>
    </Pressable>
  );
}

/** Distinct tool names listed before the summary truncates. */
const TOOL_FOLD_NAME_LIMIT = 5;

/** A folded step's tool calls: the chrome and hover highlight of a record
 * row. Tap expands the step. */
function ToolFoldRow({
  count,
  names,
  leadTurn,
  narrow,
  styles,
  onPress,
}: {
  count: number;
  names: string[];
  leadTurn?: PreviewTurn;
  narrow: boolean;
  styles: Styles;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const calls = `${count} ${count === 1 ? "tool call" : "tool calls"}`;
  const shown = names.slice(0, TOOL_FOLD_NAME_LIMIT);
  const nameText = `${shown.join(", ")}${names.length > shown.length ? ", …" : ""}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Expand ${calls}: ${names.join(", ")}`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.entryRow, leadTurn?.id ? styles.turnStart : null, hovered ? styles.entryRowHovered : null]}
    >
      <TurnGutter turn={leadTurn} narrow={narrow} styles={styles} />
      <View style={styles.entryIcon} />
      <View style={styles.entryBody}>
        <Text style={styles.foldText} numberOfLines={1}>
          {`⋯ ${calls} · ${nameText}`}
        </Text>
      </View>
    </Pressable>
  );
}

/** One pre-computed ledger row (kind "entry"). */
function LedgerRowItem({
  row,
  leadTurn,
  narrow,
  selected,
  iconColor,
  styles,
  onPress,
}: {
  row: PreviewRow;
  leadTurn?: PreviewTurn;
  narrow: boolean;
  selected: boolean;
  iconColor: string;
  styles: Styles;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const preview = row.preview;
  const danger = row.danger ?? false;
  const dim = row.dim ?? false;
  // Status glyphs (…, ⊘, ✓) read in the row's text color; only failures —
  // the ✗ glyph or a failed call's error text — are red.
  const outputStyle = preview
    ? preview.tone === "danger" || danger
      ? styles.entryError
      : dim
        ? styles.entrySummary
        : undefined
    : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.label ?? "Record"}: ${row.summary ?? ""}`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.entryRow,
        leadTurn?.id ? styles.turnStart : null,
        selected ? styles.entryRowSelected : hovered ? styles.entryRowHovered : null,
      ]}
    >
      <TurnGutter turn={leadTurn} narrow={narrow} styles={styles} />
      <View style={styles.entryIcon}>
        {row.icon ? <Icon name={row.icon} size={15} color={iconColor} /> : null}
      </View>
      <View style={styles.entryBody}>
        {preview ? (
          <View style={styles.entryLineRow}>
            <View style={styles.entryInputGroup}>
              {row.showLabel && row.label ? <Text style={styles.entryLabel}>{row.label}</Text> : null}
              <Text style={[styles.entryInput, dim ? styles.entrySummary : undefined]} numberOfLines={1}>
                {preview.input}
              </Text>
            </View>
            <Text style={styles.entryArrow}>→</Text>
            <Text style={[styles.entryOutput, outputStyle]} numberOfLines={1}>
              {preview.output}
            </Text>
          </View>
        ) : (
          <Text style={styles.entryLine} numberOfLines={1}>
            {row.showLabel && row.label ? <Text>{`${row.label}${row.summary ? "  " : ""}`}</Text> : null}
            {row.summary ? (
              <Text style={danger ? styles.entryError : dim ? styles.entrySummary : undefined}>
                {row.summary}
              </Text>
            ) : null}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

