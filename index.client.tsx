import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { TrajectoryPanel } from "./client/trajectory-panel";
import { TrajectoryScreen } from "./client/trajectory-screen";

export const TRAJECTORY_PANEL_ID = "trajectory";
export const TRAJECTORY_SCREEN_ID = "trajectory-screen";
const OPEN_TRAJECTORY_ID = "open-trajectory";

export default function contribute(client: PluginClientContext) {
  const disposers = [
    // Workspace-scoped so it appears in the pane new-tab menu and keeps one tab
    // per workspace; the panel owns the agent selector. Desktop only: the native
    // compact shell has no pane/tab or explorer surface to place it in.
    client.addWorkspacePanel({
      id: TRAJECTORY_PANEL_ID,
      title: "Trajectory",
      icon: "Activity",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: TrajectoryPanel,
    }),
    // The compact (Android/iOS) shell renders route-based screens, so expose the
    // same ledger as a full-screen surface. It reuses TrajectoryPanel.
    client.addScreen({
      id: TRAJECTORY_SCREEN_ID,
      title: "Trajectory",
      Component: TrajectoryScreen,
    }),
    // Opens the screen for the active workspace from the command palette, which
    // is reachable on both desktop and mobile.
    client.addCommandCenterItem({
      id: OPEN_TRAJECTORY_ID,
      title: "Open Trajectory",
      icon: "Activity",
      keywords: ["trajectory", "timeline", "ledger", "activity"],
      context: "workspace",
      onSelect(context) {
        context.openScreen({
          screenId: TRAJECTORY_SCREEN_ID,
          params: { workspaceId: context.workspace.id },
        });
      },
    }),
  ];

  // Header buttons are workspace-scoped, so register one per workspace and keep
  // the set in step with the daemon's workspace stream. The button opens the
  // screen rather than the pane panel so it also works on compact layouts.
  const headerButtons = new Map<string, PluginButtonRegistration>();
  let disposed = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  const addHeaderButton = (workspaceId: string) => {
    if (headerButtons.has(workspaceId)) return;
    headerButtons.set(
      workspaceId,
      client.addHeaderButton({
        id: OPEN_TRAJECTORY_ID,
        workspaceId,
        button: {
          title: "Open Trajectory",
          icon: "Activity",
          behavior: {
            kind: "action",
            onPress: () => client.openScreen({ screenId: TRAJECTORY_SCREEN_ID, params: { workspaceId } }),
          },
        },
      }),
    );
  };

  const removeHeaderButton = (workspaceId: string) => {
    const registration = headerButtons.get(workspaceId);
    if (!registration) return;
    headerButtons.delete(workspaceId);
    registration.remove();
  };

  const syncHeaderButtons = (workspaceIds: readonly string[]) => {
    const live = new Set(workspaceIds);
    for (const workspaceId of live) addHeaderButton(workspaceId);
    for (const workspaceId of [...headerButtons.keys()]) {
      if (!live.has(workspaceId)) removeHeaderButton(workspaceId);
    }
  };

  const reconcile = async () => {
    if (disposed) return;
    try {
      const result = await client.paseo.workspaces.list();
      if (disposed) return;
      syncHeaderButtons(
        result.entries.filter((workspace) => !workspace.archivingAt).map((workspace) => workspace.id),
      );
    } catch {
      // Non-fatal: the command palette entry still opens the screen.
    }
  };

  const scheduleReconcile = () => {
    if (disposed || reconcileTimer !== null) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      void reconcile();
    }, 250);
  };

  let unsubscribeWorkspaces: (() => void) | null = null;
  let workspaceSubscription: { release(): Promise<void> } | null = null;
  void (async () => {
    try {
      // Starting the stream both seeds the header buttons and keeps new
      // workspaces from being missed without a plugin reload.
      const stream = await client.paseo.workspaces.list({ subscribe: {} });
      if (disposed) {
        void stream.subscription.release();
        return;
      }
      workspaceSubscription = stream.subscription;
      syncHeaderButtons(stream.entries.filter((workspace) => !workspace.archivingAt).map((workspace) => workspace.id));
    } catch {
      // Fall back to a one-shot list if streaming is unavailable.
      void reconcile();
    }
    if (disposed) return;
    try {
      unsubscribeWorkspaces = client.paseo.workspaces.subscribe(() => scheduleReconcile());
    } catch {
      // Transient updates are best-effort.
    }
  })();

  return () => {
    disposed = true;
    if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    unsubscribeWorkspaces?.();
    if (workspaceSubscription) void workspaceSubscription.release();
    for (const registration of headerButtons.values()) registration.remove();
    headerButtons.clear();
    for (const dispose of disposers) void dispose();
  };
}
