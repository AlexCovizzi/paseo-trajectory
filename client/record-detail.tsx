import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Text, View, type TextStyle, type ViewStyle } from "react-native";
import { IconButton } from "./icon-button";
import {
  itemColor,
  itemMeta,
  toolArguments,
  toolErrorText,
  toolResult,
} from "../shared/trajectory-preview";
import type { TimelineEntry } from "../shared/timeline-types";
import { formatTimestamp } from "./trajectory-data";

function createStyles(theme: PluginTheme, compact: boolean) {
  return {
    root: { minHeight: 0, minWidth: 0 } satisfies ViewStyle,
    content: { padding: compact ? 16 : 20, gap: 16 } satisfies ViewStyle,
    header: {
      gap: 4,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    } satisfies ViewStyle,
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    } satisfies ViewStyle,
    titleGroup: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 } satisfies ViewStyle,
    titleMeta: { color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1 } satisfies TextStyle,
    section: { gap: 6 } satisfies ViewStyle,
    sectionTitle: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      letterSpacing: 0.6,
      textTransform: "uppercase",
    } satisfies TextStyle,
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: 12,
      // No horizontal inset so stats sit flush with the content, but keep
      // the vertical breathing room between rows.
      paddingVertical: 7,
    } satisfies ViewStyle,
    rowLabel: { color: theme.colors.foregroundMuted, fontSize: 12 } satisfies TextStyle,
    rowValue: {
      color: theme.colors.foreground,
      fontSize: 12,
      flexShrink: 1,
      textAlign: "right",
    } satisfies TextStyle,
    code: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
      padding: 12,
    } satisfies ViewStyle,
    codeText: { color: theme.colors.foreground, fontSize: 12, lineHeight: 18 } satisfies TextStyle,
    body: { color: theme.colors.foreground, fontSize: 13, lineHeight: 20 } satisfies TextStyle,
    muted: { color: theme.colors.foregroundMuted, fontSize: 12 } satisfies TextStyle,
    danger: { color: theme.colors.statusDanger, fontSize: 13, lineHeight: 20 } satisfies TextStyle,
    todoRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" } satisfies ViewStyle,
    todoText: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 } satisfies TextStyle,
    todoDone: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      textDecorationLine: "line-through",
      flexShrink: 1,
    } satisfies TextStyle,
  };
}

type Styles = ReturnType<typeof createStyles>;

/** Fixed inspector header: kind icon, turn/step, and close. */
export function RecordDetailHeader({
  entry,
  theme,
  turnIndex,
  step,
  onClose,
}: {
  entry: TimelineEntry;
  theme: PluginTheme;
  turnIndex: number | null;
  step: number | null;
  onClose?: () => void;
}) {
  const meta = itemMeta(entry.item);
  const styles = useMemo(() => createStyles(theme, false), [theme]);
  return (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <View style={styles.titleGroup}>
          <Icon name={meta.icon} size={16} color={itemColor(meta.color, theme)} />
          <Text style={styles.titleMeta} numberOfLines={1}>
            {turnIndex !== null
              ? `Turn ${turnIndex}${step !== null ? ` · Step ${step}` : ""}`
              : meta.title}
          </Text>
        </View>
        {onClose ? <IconButton name="X" label="Close inspector" onPress={onClose} theme={theme} /> : null}
      </View>
    </View>
  );
}

/** Inspector body: details plus the recorded content. */
export function RecordDetail({
  entry,
  provider,
  theme,
  compact,
}: {
  entry: TimelineEntry;
  provider: string;
  theme: PluginTheme;
  compact: boolean;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);

  return (
    <View style={styles.root}>
      <View style={styles.content}>
        <View style={styles.section}>
          <KeyValueBox
            rows={[
              { label: "Provider", value: provider },
              { label: "Time", value: formatTimestamp(entry.timestamp) },
            ]}
            styles={styles}
          />
        </View>
        <RecordBody entry={entry} styles={styles} />
      </View>
    </View>
  );
}

function KeyValueBox({
  rows,
  styles,
}: {
  rows: { label: string; value: string }[];
  styles: Styles;
}) {
  // Stats sit directly on the inspector background: no box chrome.
  return (
    <View>
      {rows.map((row) => (
        <View key={row.label} style={styles.row}>
          <Text style={styles.rowLabel}>{row.label}</Text>
          <Text style={styles.rowValue} numberOfLines={1}>
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function RecordBody({ entry, styles }: { entry: TimelineEntry; styles: Styles }) {
  const detail = entry.item;
  switch (detail.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {detail.type === "reasoning" ? "Thinking" : detail.type === "user_message" ? "Message" : "Output"}
          </Text>
          <Text selectable style={styles.body}>
            {detail.text || "(empty)"}
          </Text>
        </View>
      );
    case "tool_call": {
      const args = toolArguments(detail.detail);
      const result = toolResult(detail.detail);
      const statusText = detail.status.charAt(0).toUpperCase() + detail.status.slice(1);
      const error = detail.status === "failed" ? toolErrorText(detail.error) : null;
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Tool</Text>
          <KeyValueBox
            rows={[
              { label: "Name", value: detail.name },
              { label: "Status", value: statusText },
            ]}
            styles={styles}
          />
          {args ? (
            <>
              <Text style={styles.sectionTitle}>Arguments</Text>
              <View style={styles.code}>
                <Text selectable style={styles.codeText}>
                  {args}
                </Text>
              </View>
            </>
          ) : null}
          {error ? (
            <>
              <Text style={styles.sectionTitle}>Error</Text>
              <View style={styles.code}>
                <Text selectable style={styles.codeText}>
                  {error}
                </Text>
              </View>
            </>
          ) : result ? (
            <>
              <Text style={styles.sectionTitle}>Result</Text>
              <View style={styles.code}>
                <Text selectable style={styles.codeText}>
                  {result}
                </Text>
              </View>
            </>
          ) : null}
        </View>
      );
    }
    case "todo":
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Tasks</Text>
          {detail.items.map((task, index) => {
            const done = task.completed || task.status === "completed";
            return (
              <View key={task.id ?? `${index}:${task.text}`} style={styles.todoRow}>
                <Text style={styles.muted}>{done ? "✓" : "○"}</Text>
                <Text style={done ? styles.todoDone : styles.todoText}>{task.text}</Text>
              </View>
            );
          })}
        </View>
      );
    case "error":
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Error</Text>
          <Text selectable style={styles.danger}>
            {detail.message}
          </Text>
        </View>
      );
    case "notification":
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notice</Text>
          <Text selectable style={styles.body}>
            {detail.message}
          </Text>
        </View>
      );
    case "compaction":
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Compaction</Text>
          <KeyValueBox
            rows={[
              { label: "Status", value: detail.status },
              { label: "Trigger", value: detail.trigger ?? "—" },
              {
                label: "Pre tokens",
                value: detail.preTokens !== undefined ? String(detail.preTokens) : "—",
              },
            ]}
            styles={styles}
          />
        </View>
      );
    case "plugin":
      return (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Plugin data</Text>
          <View style={styles.code}>
            <Text selectable style={styles.codeText}>
              {safeJson(detail.data)}
            </Text>
          </View>
        </View>
      );
    default:
      return null;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
