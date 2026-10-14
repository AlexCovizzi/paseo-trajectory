import type { PluginTheme } from "@getpaseo/plugin";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { itemColor, mixColor } from "../shared/trajectory-preview";
import type { PreviewRow } from "../shared/trajectory-rpc";

/**
 * Compact trajectory overview that sits above the ledger: one unlabeled track
 * row per event category, with one small rounded square per event placed in
 * chronological order. Marker color matches the row's icon color, so the row
 * a marker sits in (and its color) identifies the category.
 *
 * The lane labels collapse away on narrow panes; the track always fills the
 * available width and scrolls horizontally once the events outgrow it.
 */

interface LaneConfig {
  id: "info" | "user" | "model" | "tool";
  label: string;
}

/** Lanes, top to bottom: context/info first, then user, model, tools. */
const LANES: LaneConfig[] = [
  { id: "info", label: "Info" },
  { id: "user", label: "User" },
  { id: "model", label: "Model" },
  { id: "tool", label: "Tools" },
];
type LaneId = LaneConfig["id"];

const LANE_INDEX: Record<LaneId, number> = { info: 0, user: 1, model: 2, tool: 3 };

const ROW_HEIGHT = 16;
const BAND_PAD = 6;
const LABEL_WIDTH = 42;
const MARKER_HEIGHT = 10;
/** Hover/selection ring, drawn just outside the marker so the fill stays whole. */
const RING_WIDTH = 1.5;
const MIN_MARKER_WIDTH = 8;
const MAX_MARKER_WIDTH = 34;
/** Gap between adjacent marker edges; markers grow to fill the rest of a slot. */
const MARKER_GAP = 2;
const TRACK_PAD = 6;
const MIN_PITCH = 10;
const MAX_PITCH = 36;
const TOOLTIP_WIDTH = 280;
/** Gap between the pointer and the top of the hover popup. */
const TOOLTIP_OFFSET = 12;
const FADE_WIDTH = 48;
const FADE_STEPS = 16;
/** Tail distance within which the track counts as pinned to the newest event. */
const FOLLOW_THRESHOLD = 16;
/** Left-edge distance that pages an older stretch of history in. */
const LOAD_OLDER_THRESHOLD = 80;
/** Safety reveal for the hidden-until-positioned track. */
const POSITION_REVEAL_FALLBACK_MS = 400;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Lane for one event. A failed tool call keeps the tool lane (its marker just
 * turns red); everything that is not a user/model/tool event (notices, errors,
 * compaction, tasks, plugins, unknowns) lands in the info lane.
 */
function laneOf(row: PreviewRow): LaneId {
  switch (row.color) {
    case "user":
      return "user";
    case "reasoning":
    case "assistant":
      return "model";
    case "tool":
      return "tool";
    default:
      return "info";
  }
}

/** Marker fill: the row's icon color, with thinking a dimmed purple. A failed
 * tool call is pushed to a stronger red so it stands apart from the orange
 * tool lane instead of blending with it. */
function markerColor(row: PreviewRow, theme: PluginTheme): string {
  if (row.danger) return mixColor(theme.colors.statusDanger, "#ff2d2d", 0.6);
  const base = itemColor(row.color ?? "muted", theme);
  return row.color === "reasoning" ? mixColor(base, theme.colors.surface0, 0.5) : base;
}

interface GraphEvent {
  row: PreviewRow;
  slot: number;
  lane: LaneId;
}

export interface TrajectoryTimelineProps {
  rows: PreviewRow[];
  theme: PluginTheme;
  selectedKey: string | null;
  /** Row keys matching an active search; non-matches dim while `dimNonMatches`. */
  matchKeys: ReadonlySet<string>;
  dimNonMatches: boolean;
  onSelectRow(key: string): void;
  /** Called when the viewport reaches the oldest loaded event. */
  onReachStart?(): void;
}

export function TrajectoryTimeline({
  rows,
  theme,
  selectedKey,
  matchKeys,
  dimNonMatches,
  onSelectRow,
  onReachStart,
}: TrajectoryTimelineProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<{ row: PreviewRow; x: number; y: number } | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const scrollRef = useRef<ScrollView>(null);
  const scrollXRef = useRef(0);
  // Starts pinned to the newest event; flips false once the user scrolls back.
  const followRef = useRef(true);
  /** True while the viewport sits in the load-older zone; fires on entering it. */
  const atStartRef = useRef(false);
  const firstKeyRef = useRef<string | null>(null);
  const eventCountRef = useRef(0);
  const edgesRef = useRef({ left: false, right: false });
  // The track mounts hidden and is revealed once it sits on the newest
  // event, so opening never paints the band at its oldest end first.
  const [positioned, setPositioned] = useState(false);
  const positionedRef = useRef(false);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reveal = useCallback(() => {
    positionedRef.current = true;
    if (revealTimerRef.current !== null) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    setPositioned(true);
  }, []);
  useEffect(
    () => () => {
      if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    },
    [],
  );

  const events = useMemo<GraphEvent[]>(() => {
    const next: GraphEvent[] = [];
    for (const row of rows) {
      if (row.kind === "entry") next.push({ row, slot: next.length, lane: laneOf(row) });
    }
    return next;
  }, [rows]);
  const eventCount = events.length;

  const labelWidth = LABEL_WIDTH;
  const bandHeight = BAND_PAD * 2 + LANES.length * ROW_HEIGHT;
  const trackWidth = Math.max(width - labelWidth, 0);
  const usableWidth = Math.max(trackWidth - TRACK_PAD * 2, 0);
  const pitch = eventCount > 0 ? clamp(usableWidth / eventCount, MIN_PITCH, MAX_PITCH) : MIN_PITCH;
  const markerWidth = clamp(pitch - MARKER_GAP, MIN_MARKER_WIDTH, MAX_MARKER_WIDTH);
  const contentWidth = TRACK_PAD * 2 + eventCount * pitch;
  const trackMounted = width > 0 && eventCount > 0;

  // Park the track on the newest event before the first paint: the content
  // width is exact (markers are absolutely placed), so the tail offset is
  // known without waiting for layout.
  useLayoutEffect(() => {
    if (!trackMounted || positionedRef.current) return;
    if (contentWidth <= trackWidth) {
      reveal();
      return;
    }
    scrollRef.current?.scrollTo({ x: contentWidth - trackWidth, animated: false });
    if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    // Reveal regardless after one last snap attempt: a track that fits
    // never scrolls (no event fires).
    revealTimerRef.current = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
      reveal();
    }, POSITION_REVEAL_FALLBACK_MS);
  }, [trackMounted, contentWidth, trackWidth, reveal]);

  /** Flips the edge fades on only when a side actually becomes scrollable. */
  const updateEdges = useCallback((x: number, viewport: number, content: number) => {
    const next = { left: x > 1, right: x + viewport < content - 1 };
    if (next.left !== edgesRef.current.left || next.right !== edgesRef.current.right) {
      edgesRef.current = next;
      setEdges(next);
    }
  }, []);

  useEffect(() => {
    updateEdges(scrollXRef.current, trackWidth, contentWidth);
  }, [trackWidth, contentWidth, updateEdges]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      scrollXRef.current = contentOffset.x;
      const atTail = contentOffset.x + layoutMeasurement.width >= contentSize.width - FOLLOW_THRESHOLD;
      // Pinned until the initial tail snap is confirmed (see reveal).
      followRef.current = positionedRef.current ? atTail : true;
      updateEdges(contentOffset.x, layoutMeasurement.width, contentSize.width);
      if (!positionedRef.current && atTail) reveal();
      const nearStart = contentSize.width > layoutMeasurement.width + 1 && contentOffset.x <= LOAD_OLDER_THRESHOLD;
      if (nearStart && !atStartRef.current) onReachStart?.();
      atStartRef.current = nearStart;
    },
    [onReachStart, updateEdges, reveal],
  );

  const handleContentSizeChange = useCallback(() => {
    if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  // Stable hover plumbing: the memoized markers below re-render only when
  // their own hover/selection state moves, not on every pointer move.
  const handleMarkerHover = useCallback((row: PreviewRow, x: number, y: number) => {
    setHovered({ row, x, y });
  }, []);
  const handleMarkerHoverEnd = useCallback((key: string) => {
    setHovered((current) => (current?.row.key === key ? null : current));
  }, []);

  // Older rows prepend on the left; shift the offset by the width of the added
  // slots so the viewport stays on the same events instead of jumping. Applied
  // in a layout effect (before paint) so the wider content never flashes at
  // the old position first.
  useLayoutEffect(() => {
    const first = events[0]?.row.key ?? null;
    const previousFirst = firstKeyRef.current;
    const previousCount = eventCountRef.current;
    if (previousFirst !== null && first !== null && first !== previousFirst && eventCount > previousCount) {
      const added = eventCount - previousCount;
      const target = Math.max(0, scrollXRef.current + added * pitch);
      scrollXRef.current = target;
      scrollRef.current?.scrollTo({ x: target, animated: false });
    }
    firstKeyRef.current = first;
    eventCountRef.current = eventCount;
  }, [events, eventCount, pitch]);

  const tooltipWidth = Math.min(TOOLTIP_WIDTH, Math.max(width - 8, 80));
  const tooltipLeft = hovered
    ? clamp(hovered.x - scrollXRef.current - tooltipWidth / 2, 4, Math.max(4, width - tooltipWidth - 4))
    : 4;
  const tooltipTop = hovered ? hovered.y + TOOLTIP_OFFSET : 0;

  return (
    <View style={styles.root} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <View style={styles.band}>
        <View style={[styles.labels, { width: labelWidth }]}>
          {LANES.map((lane) => (
            <View key={lane.id} style={styles.labelRow}>
              <Text style={styles.labelText} numberOfLines={1}>
                {lane.label}
              </Text>
            </View>
          ))}
        </View>
        <View style={styles.trackWrap}>
        {trackMounted ? (
          <ScrollView
            ref={scrollRef}
            horizontal
            style={[styles.track, positioned ? null : styles.hidden]}
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={handleScroll}
            onContentSizeChange={handleContentSizeChange}
            nestedScrollEnabled
          >
            <View style={{ width: contentWidth, height: bandHeight }}>
              {events.map((event) => {
                const laneIndex = LANE_INDEX[event.lane];
                const top = BAND_PAD + laneIndex * ROW_HEIGHT + (ROW_HEIGHT - MARKER_HEIGHT) / 2;
                const left = TRACK_PAD + event.slot * pitch + (pitch - markerWidth) / 2;
                return (
                  <TimelineMarker
                    key={event.row.key}
                    row={event.row}
                    left={left}
                    top={top}
                    width={markerWidth}
                    height={MARKER_HEIGHT}
                    selected={selectedKey === event.row.key}
                    hovered={hovered?.row.key === event.row.key}
                    dimmed={dimNonMatches && !matchKeys.has(event.row.key)}
                    theme={theme}
                    styles={styles}
                    onSelectRow={onSelectRow}
                    onHover={handleMarkerHover}
                    onHoverEnd={handleMarkerHoverEnd}
                  />
                );
              })}
            </View>
          </ScrollView>
        ) : null}
          {edges.left && positioned ? (
            <EdgeFade side="left" color={theme.colors.surface1} height={bandHeight} />
          ) : null}
          {edges.right && positioned ? (
            <EdgeFade side="right" color={theme.colors.surface1} height={bandHeight} />
          ) : null}
        </View>
      </View>
      {hovered ? (
        <View
          pointerEvents="none"
          style={[styles.tooltip, { left: tooltipLeft, top: tooltipTop, width: tooltipWidth }]}
        >
          <Text style={styles.tooltipLabel} numberOfLines={1}>
            {hovered.row.label ?? "Record"}
          </Text>
          {hovered.row.summary ? (
            <Text style={styles.tooltipSummary} numberOfLines={2}>
              {hovered.row.summary}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** One event marker: the fill plus its selection/hover ring. Memoized on the
 * row's identity and slot geometry, so polls and selection changes re-render
 * only the affected markers. */
const TimelineMarker = memo(function TimelineMarker({
  row,
  left,
  top,
  width,
  height,
  selected,
  hovered,
  dimmed,
  theme,
  styles,
  onSelectRow,
  onHover,
  onHoverEnd,
}: {
  row: PreviewRow;
  left: number;
  top: number;
  width: number;
  height: number;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
  theme: PluginTheme;
  styles: ReturnType<typeof createStyles>;
  onSelectRow(key: string): void;
  onHover(row: PreviewRow, x: number, y: number): void;
  onHoverEnd(key: string): void;
}) {
  const base = markerColor(row, theme);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.label ?? "Record"}: ${row.summary ?? ""}`}
        onPress={() => onSelectRow(row.key)}
        onHoverIn={(mouseEvent) => {
          const { offsetX, offsetY } = mouseEvent.nativeEvent;
          onHover(
            row,
            left + (Number.isFinite(offsetX) ? offsetX : width / 2),
            top + (Number.isFinite(offsetY) ? offsetY : 0),
          );
        }}
        onHoverOut={() => onHoverEnd(row.key)}
        style={[
          styles.marker,
          {
            left,
            top,
            width,
            height,
            backgroundColor: hovered ? mixColor(base, theme.colors.foreground, 0.25) : base,
            opacity: dimmed ? 0.1 : 1,
          },
        ]}
      />
      {selected || hovered ? (
        <View
          pointerEvents="none"
          style={[
            styles.markerRing,
            {
              left: left - RING_WIDTH,
              top: top - RING_WIDTH,
              width: width + RING_WIDTH * 2,
              height: height + RING_WIDTH * 2,
              borderWidth: RING_WIDTH,
              borderColor: selected
                ? theme.colors.accent
                : mixColor(theme.colors.accent, theme.colors.surface1, 0.5),
            },
          ]}
        />
      ) : null}
    </>
  );
});

/** Layered strips fake a gradient fade toward the band surface at a scrollable edge. */
function EdgeFade({ side, color, height }: { side: "left" | "right"; color: string; height: number }) {
  const step = FADE_WIDTH / FADE_STEPS;
  return (
    <>
      {Array.from({ length: FADE_STEPS }, (_, index) => (
        <View
          key={index}
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            height,
            width: step,
            backgroundColor: color,
            opacity: Math.pow(1 - index / FADE_STEPS, 0.65),
            ...(side === "left" ? { left: index * step } : { right: index * step }),
          }}
        />
      ))}
    </>
  );
}

function createStyles(theme: PluginTheme) {
  const bandSurface = theme.colors.surface1;
  return {
    root: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: bandSurface,
      // Keeps the hover popup above the ledger it now overlaps below the band.
      zIndex: 10,
    } satisfies ViewStyle,
    band: { flexDirection: "row", alignItems: "stretch" } satisfies ViewStyle,
    labels: {
      paddingVertical: BAND_PAD,
      paddingLeft: 8,
      paddingRight: 2,
      justifyContent: "flex-start",
    } satisfies ViewStyle,
    labelRow: { height: ROW_HEIGHT, justifyContent: "center" } satisfies ViewStyle,
    labelText: { color: theme.colors.foregroundMuted, fontSize: 10 } satisfies TextStyle,
    trackWrap: {
      flex: 1,
      position: "relative",
      height: BAND_PAD * 2 + LANES.length * ROW_HEIGHT,
    } satisfies ViewStyle,
    track: { flex: 1 } satisfies ViewStyle,
    // Track pre-positioning: never paint the band at its oldest end first.
    hidden: { opacity: 0 } satisfies ViewStyle,
    marker: { position: "absolute", borderRadius: 1 } satisfies ViewStyle,
    markerRing: { position: "absolute", borderRadius: 2 } satisfies ViewStyle,
    tooltip: {
      position: "absolute",
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      gap: 1,
    } satisfies ViewStyle,
    tooltipLabel: { color: theme.colors.foreground, fontSize: 11, fontWeight: "600" } satisfies TextStyle,
    tooltipSummary: { color: theme.colors.foregroundMuted, fontSize: 11 } satisfies TextStyle,
  };
}
