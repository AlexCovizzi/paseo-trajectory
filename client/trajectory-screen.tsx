import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useWorkspaces } from "./trajectory-data";
import { TrajectoryPanel } from "./trajectory-panel";

/**
 * Full-screen trajectory surface. Workspace panels only render in the desktop
 * pane/tab and explorer shells, which the native compact layout does not have,
 * so this screen is how the same ledger is reached there (opened from the
 * command palette). It reuses {@link TrajectoryPanel} verbatim.
 */
export function TrajectoryScreen({ theme, layout, params }: PluginScreenProps) {
  // params.workspaceId is reactive: the host can reopen this screen for
  // another workspace without remounting it, so read the param on every
  // render and only fall back to the in-screen picker when it is absent.
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState<string | null>(null);
  const workspaceId = params.workspaceId ?? pickedWorkspaceId;

  if (!workspaceId) {
    return <WorkspacePicker theme={theme} onSelect={setPickedWorkspaceId} />;
  }
  return <TrajectoryPanel theme={theme} layout={layout} workspaceId={workspaceId} />;
}

function WorkspacePicker({ theme, onSelect }: { theme: PluginTheme; onSelect(workspaceId: string): void }) {
  const { workspaces, loading, error } = useWorkspaces();
  const styles = useMemo(() => createPickerStyles(theme), [theme]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }
  if (workspaces.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>No workspaces yet.</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Trajectory</Text>
      </View>
      {workspaces.map((workspace) => (
        <WorkspacePickerRow
          key={workspace.id}
          title={workspace.title}
          onSelect={() => onSelect(workspace.id)}
          styles={styles}
        />
      ))}
    </View>
  );
}

function WorkspacePickerRow({
  title,
  onSelect,
  styles,
}: {
  title: string;
  onSelect(): void;
  styles: ReturnType<typeof createPickerStyles>;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onSelect}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.row, hovered ? styles.rowHovered : null]}
    >
      <Text style={styles.rowTitle} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

function createPickerStyles(theme: PluginTheme) {
  return {
    root: { flex: 1, backgroundColor: theme.colors.surface0 } satisfies ViewStyle,
    header: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    } satisfies ViewStyle,
    headerTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" } satisfies TextStyle,
    row: {
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    } satisfies ViewStyle,
    rowHovered: { backgroundColor: theme.colors.surface1 } satisfies ViewStyle,
    rowTitle: { color: theme.colors.foreground, fontSize: 14 } satisfies TextStyle,
    centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 } satisfies ViewStyle,
    muted: { color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" } satisfies TextStyle,
    error: { color: theme.colors.statusDanger, fontSize: 13, textAlign: "center" } satisfies TextStyle,
  };
}
