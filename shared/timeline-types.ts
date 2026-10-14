/**
 * Structural mirror of the daemon's timeline types (@getpaseo/protocol
 * 0.11.2, pinned by @getpaseo/plugin 0.11.2).
 *
 * The plugin host forbids importing the client- or server-only entry modules
 * from shared bundle code, and the plugin never imports @getpaseo/client or
 * @getpaseo/protocol directly (the host injects those for the documented entry
 * points), so the shapes the shared preview logic touches are declared here.
 * They cover exactly what shared/ and its consumers use; the server store's
 * real entries are assignable to them, which keeps the mirror honest at
 * typecheck time. If the SDK is upgraded, update this mirror.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AgentTaskItem {
  text: string;
  completed: boolean;
  id?: string;
  status?: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

/** Normalized detail payload of a tool call. */
export type ToolDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: Array<{ title: string; url: string }>;
      annotations?: string[];
      numFiles?: number;
      numMatches?: number;
      durationMs?: number;
      durationSeconds?: number;
      truncated?: boolean;
      mode?: "content" | "files_with_matches" | "count";
    }
  | {
      type: "fetch";
      url: string;
      prompt?: string;
      result?: string;
      code?: number;
      codeText?: string;
      bytes?: number;
      durationMs?: number;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
      log: string;
      commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
      }>;
      truncated?: boolean;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      log: string;
      actions?: Array<{ index: number; toolName: string; summary?: string }>;
    }
  | { type: "plain_text"; label?: string; text?: string; icon?: string }
  | { type: "plan"; text: string }
  | { type: "unknown"; input: unknown; output: unknown };

export type ToolCallTimelineItem = {
  type: "tool_call";
  callId: string;
  name: string;
  detail: ToolDetail;
  metadata?: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "canceled";
  error: unknown;
};

/** One timeline record. */
export type TimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: AgentTaskItem[] }
  | { type: "error"; message: string }
  | { type: "notification"; level: "info" | "warning" | "error"; message: string }
  | { type: "compaction"; status: "loading" | "completed"; trigger?: "auto" | "manual"; preTokens?: number }
  | { type: "plugin"; id: string; pluginId: string; kind: string; version: number; data: JsonValue };

/** One entry in the agent timeline: an item with its session placement. */
export interface TimelineEntry {
  provider: string;
  item: TimelineItem;
  turnId?: string;
  timestamp: string;
  seqStart: number;
}

/** A timeline page cursor. */
export interface TimelineCursor {
  epoch: string;
  seq: number;
}
