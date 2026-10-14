import type { PluginTheme } from "@getpaseo/plugin";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * a marker sits in (and its color) identifies the category. See OVERVIEW.md.
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
      followRef.current =
        contentOffset.x + layoutMeasurement.width >= contentSize.width - FOLLOW_THRESHOLD;
      updateEdges(contentOffset.x, layoutMeasurement.width, contentSize.width);
      const nearStart = contentSize.width > layoutMeasurement.width + 1 && contentOffset.x <= LOAD_OLDER_THRESHOLD;
      if (nearStart && !atStartRef.current) onReachStart?.();
      atStartRef.current = nearStart;
    },
    [onReachStart, updateEdges],
  );

  const handleContentSizeChange = useCallback(() => {
    if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  // Older rows prepend on the left; shift the offset by the width of the added
  // slots so the viewport stays on the same events instead of jumping.
  useEffect(() => {
    const first = events[0]?.row.key ?? null;
    const previousFirst = firstKeyRef.current;
    const previousCount = eventCountRef.current;
    if (previousFirst !== null && first !== null && first !== previousFirst && eventCount > previousCount) {
      const added = eventCount - previousCount;
      const target = Math.max(0, scrollXRef.current + added * pitch);
      scrollXRef.current = target;
      setTimeout(() => scrollRef.current?.scrollTo({ x: target, animated: false }), 0);
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
        {width > 0 && eventCount > 0 ? (
          <ScrollView
            ref={scrollRef}
            horizontal
            style={styles.track}
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={handleScroll}
            onContentSizeChange={handleContentSizeChange}
            nestedScrollEnabled
          >
            <View style={{ width: contentWidth, height: bandHeight }}>
              {events.map((event) => {
                const laneIndex = LANE_INDEX[event.lane];
                const top =
                  BAND_PAD + laneIndex * ROW_HEIGHT + (ROW_HEIGHT - MARKER_HEIGHT) / 2;
                const left = TRACK_PAD + event.slot * pitch + (pitch - markerWidth) / 2;
                const base = markerColor(event.row, theme);
                const selected = selectedKey === event.row.key;
                const isHovered = hovered?.row.key === event.row.key;
                const dimmed = dimNonMatches && !matchKeys.has(event.row.key);
                return (
                  <Fragment key={event.row.key}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${event.row.label ?? "Record"}: ${event.row.summary ?? ""}`}
                      onPress={() => onSelectRow(event.row.key)}
                      onHoverIn={(mouseEvent) => {
                        const { offsetX, offsetY } = mouseEvent.nativeEvent;
                        setHovered({
                          row: event.row,
                          x: left + (Number.isFinite(offsetX) ? offsetX : markerWidth / 2),
                          y: top + (Number.isFinite(offsetY) ? offsetY : 0),
                        });
                      }}
                      onHoverOut={() =>
                        setHovered((current) => (current?.row.key === event.row.key ? null : current))
                      }
                      style={[
                        styles.marker,
                        {
                          left,
                          top,
                          width: markerWidth,
                          height: MARKER_HEIGHT,
                          backgroundColor: isHovered
                            ? mixColor(base, theme.colors.foreground, 0.25)
                            : base,
                          opacity: dimmed ? 0.1 : 1,
                        },
                      ]}
                    />
                    {selected || isHovered ? (
                      <View
                        pointerEvents="none"
                        style={[
                          styles.markerRing,
                          {
                            left: left - RING_WIDTH,
                            top: top - RING_WIDTH,
                            width: markerWidth + RING_WIDTH * 2,
                            height: MARKER_HEIGHT + RING_WIDTH * 2,
                            borderWidth: RING_WIDTH,
                            borderColor: selected
                              ? theme.colors.accent
                              : mixColor(theme.colors.accent, theme.colors.surface1, 0.5),
                          },
                        ]}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </View>
          </ScrollView>
        ) : null}
          {edges.left ? (
            <EdgeFade side="left" color={theme.colors.surface1} height={bandHeight} />
          ) : null}
          {edges.right ? (
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
