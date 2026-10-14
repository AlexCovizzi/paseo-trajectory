import type { PluginTheme } from "@getpaseo/plugin";
import type { TimelineEntry, TimelineItem, ToolDetail } from "./timeline-types";

/**
 * Pure timeline-item → presentation mapping, shared by the daemon-side store
 * (which pre-computes ledger rows) and the client (which renders record
 * content). Nothing here touches React, the network, or the filesystem.
 */

/** Stable identity within one loaded window. Type disambiguates shared seq starts; the seq start survives streaming growth. */
export function entryKey(entry: TimelineEntry): string {
  return `${entry.seqStart}:${entry.item.type}`;
}

export interface TurnGroup {
  key: string;
  turnId: string | null;
  entries: TimelineEntry[];
}

/**
 * Groups consecutive entries into turns, preserving daemon order. Entries
 * without a turn id are not a turn: they collect into a turn-less bucket (no
 * turn id) so notices and session-level records never consume a turn number.
 * The store assigns absolute turn numbers by group key.
 */
export function groupEntries(entries: TimelineEntry[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  for (const entry of entries) {
    const turnId = entry.turnId ?? null;
    if (!current || current.turnId !== turnId) {
      current = {
        key: `${turnId ?? "none"}:${entry.seqStart}`,
        turnId,
        entries: [],
      };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

/** Steps in one turn: assistant/reasoning runs, each owning the tool calls after it. */
export function countSteps(entries: TimelineEntry[]): number {
  let steps = 0;
  let open = false;
  for (const entry of entries) {
    const type = entry.item.type;
    if (type === "assistant_message" || type === "reasoning") {
      if (!open) {
        steps += 1;
        open = true;
      }
    } else if (type === "tool_call") {
      open = false;
    }
  }
  return steps;
}

/** Semantic color slot for a record; resolved against the active theme. */
export const ITEM_COLORS = [
  "user",
  "assistant",
  "reasoning",
  "context",
  "tool",
  "todo",
  "plugin",
  "danger",
  "warning",
  "muted",
] as const;

export type ItemColor = (typeof ITEM_COLORS)[number];

export interface ItemMeta {
  icon: string;
  /** Short category shown as the inspector title. */
  title: string;
  label: string;
  color: ItemColor;
  /** Only the tool name is worth repeating as a prefix in the compact ledger. */
  showLabel: boolean;
}

export function itemMeta(item: TimelineItem): ItemMeta {
  switch (item.type) {
    case "user_message":
      return { icon: "User", title: "USER", label: "User", color: "user", showLabel: false };
    case "assistant_message":
      return { icon: "Sparkles", title: "ASSISTANT", label: "Assistant", color: "assistant", showLabel: false };
    case "reasoning":
      return { icon: "Brain", title: "THINKING", label: "Thinking", color: "reasoning", showLabel: false };
    case "tool_call":
      return {
        icon: "Wrench",
        title: "TOOL",
        label: item.name || "Tool call",
        color: "tool",
        showLabel: true,
      };
    case "todo":
      return { icon: "ListTodo", title: "TASKS", label: "Tasks", color: "todo", showLabel: false };
    case "error":
      return { icon: "AlertTriangle", title: "ERROR", label: "Error", color: "danger", showLabel: false };
    case "notification":
      return {
        icon: item.level === "error" ? "AlertTriangle" : item.level === "warning" ? "AlertCircle" : "Info",
        title: "SYSTEM",
        label: "Notice",
        color: item.level === "error" ? "danger" : item.level === "warning" ? "warning" : "muted",
        showLabel: false,
      };
    case "compaction":
      return { icon: "Layers", title: "CONTEXT", label: "Compaction", color: "context", showLabel: false };
    case "plugin":
      return { icon: "Plug", title: "PLUGIN", label: item.kind || "Plugin", color: "plugin", showLabel: false };
    default:
      return { icon: "Circle", title: "EVENT", label: "Event", color: "muted", showLabel: false };
  }
}

/** Fixed accents the plugin theme does not expose, tuned for dark and light surfaces. */
const DARK_KIND_COLORS: Record<"user" | "assistant" | "reasoning" | "context" | "tool" | "todo" | "plugin", string> = {
  user: "#60a5fa",
  assistant: "#c084fc",
  reasoning: "#c084fc",
  context: "#4ade80",
  tool: "#fb923c",
  todo: "#facc15",
  plugin: "#f472b6",
};
const LIGHT_KIND_COLORS: typeof DARK_KIND_COLORS = {
  user: "#2563eb",
  assistant: "#9333ea",
  reasoning: "#9333ea",
  context: "#16a34a",
  tool: "#ea580c",
  todo: "#ca8a04",
  plugin: "#db2777",
};

export function itemColor(color: ItemColor, theme: PluginTheme): string {
  switch (color) {
    case "danger":
      return theme.colors.statusDanger;
    case "warning":
      return theme.colors.statusWarning;
    case "muted":
      return theme.colors.foregroundMuted;
    default:
      return (isDarkSurface(theme.colors.surface0) ? DARK_KIND_COLORS : LIGHT_KIND_COLORS)[color];
  }
}

function isDarkSurface(hex: string): boolean {
  const { r, g, b } = parseHex(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  let value = hex.trim().replace(/^#/, "");
  if (value.length === 3) value = value.split("").map((char) => char + char).join("");
  const int = Number.parseInt(value.slice(0, 6), 16);
  if (!Number.isFinite(int)) return { r: 0, g: 0, b: 0 };
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/** Blends `a` toward `b` by `amount` (0..1); used to soften text without the muted token. */
export function mixColor(a: string, b: string, amount: number): string {
  const from = parseHex(a);
  const to = parseHex(b);
  const channel = (x: number, y: number) =>
    Math.round(x + (y - x) * Math.min(Math.max(amount, 0), 1))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(from.r, to.r)}${channel(from.g, to.g)}${channel(from.b, to.b)}`;
}

export function itemSummary(item: TimelineItem): string {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return firstLine(item.text);
    case "tool_call": {
      const { input, output } = toolCallPreview(item);
      return output ? `${input} → ${output}` : input;
    }
    case "todo": {
      const done = item.items.filter((task) => task.completed || task.status === "completed").length;
      return `${done}/${item.items.length} tasks`;
    }
    case "error":
    case "notification":
      return firstLine(item.message);
    case "compaction":
      return item.status === "loading" ? "Compacting context" : "Context compacted";
    case "plugin":
      return item.kind;
    default:
      return "";
  }
}

export function toolArguments(detail: ToolDetail): string {
  switch (detail.type) {
    case "shell":
      return safeJson({ command: detail.command, cwd: detail.cwd });
    case "read":
      return safeJson({ filePath: detail.filePath, offset: detail.offset, limit: detail.limit });
    case "edit":
      return safeJson({ filePath: detail.filePath, oldString: detail.oldString, newString: detail.newString });
    case "write":
      return safeJson({ filePath: detail.filePath, content: detail.content });
    case "search":
      return safeJson({ query: detail.query, toolName: detail.toolName, mode: detail.mode });
    case "fetch":
      return safeJson({ url: detail.url, prompt: detail.prompt });
    case "worktree_setup":
      return safeJson({ worktreePath: detail.worktreePath, branchName: detail.branchName });
    case "sub_agent":
      return safeJson({
        subAgentType: detail.subAgentType,
        description: detail.description,
        childSessionId: detail.childSessionId,
      });
    case "plan":
      return detail.text;
    case "plain_text":
      return detail.text ?? detail.label ?? "";
    case "unknown":
      return safeJson(detail.input);
    default:
      return "";
  }
}

export function toolResult(detail: ToolDetail): string {
  switch (detail.type) {
    case "shell":
      return detail.output ?? "";
    case "read":
      return detail.content ?? "";
    case "edit":
      return detail.unifiedDiff ?? "";
    case "write":
      return detail.content ?? "";
    case "search":
      return detail.content ?? detail.filePaths?.join("\n") ?? "";
    case "fetch":
      return detail.result ?? detail.codeText ?? "";
    case "worktree_setup":
      return detail.log ?? "";
    case "sub_agent":
      return detail.log ?? "";
    case "plan":
      return detail.text;
    case "plain_text":
      return detail.text ?? "";
    case "unknown":
      return safeJson(detail.output);
    default:
      return "";
  }
}

function toolSummary(detail: ToolDetail): string {
  switch (detail.type) {
    case "shell":
      return detail.command;
    case "read":
    case "edit":
    case "write":
      return detail.filePath;
    case "search": {
      const suffix = detail.numFiles !== undefined ? ` (${detail.numFiles} files)` : "";
      return `${detail.query}${suffix}`;
    }
    case "fetch":
      return detail.url;
    case "worktree_setup":
      return detail.worktreePath;
    case "sub_agent":
      return detail.description ?? detail.subAgentType ?? "sub-agent";
    case "plan":
      return firstLine(detail.text);
    case "plain_text":
      return firstLine(detail.text ?? detail.label ?? "text");
    case "unknown":
      return unknownToolSummary(detail.input);
    default:
      return "tool call";
  }
}

/**
 * Best-effort summary for a tool call the provider did not normalize to a known
 * detail shape: surface the first recognizable argument (command, query, path,
 * …), otherwise the raw input as compact JSON.
 */
const UNKNOWN_SUMMARY_KEYS = [
  "command",
  "cmd",
  "query",
  "pattern",
  "regex",
  "filePath",
  "file_path",
  "path",
  "filename",
  "file",
  "url",
  "prompt",
  "description",
  "task",
  "text",
] as const;

function unknownToolSummary(input: unknown): string {
  if (typeof input === "string") return firstLine(input);
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of UNKNOWN_SUMMARY_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return firstLine(value);
    }
  }
  try {
    const json = JSON.stringify(input);
    return json ? firstLine(json) : "tool call";
  } catch {
    return "tool call";
  }
}

/**
 * Human-readable text for a failed tool call's error: unwraps a `message`
 * wrapper, pretty-prints stringified JSON, and otherwise falls back to JSON.
 */
export function toolErrorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return prettyJsonString(error);
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      const rest = { ...record };
      delete rest.message;
      return Object.keys(rest).length > 0 ? `${record.message}\n${safeJson(rest)}` : record.message;
    }
  }
  return safeJson(error);
}

/** Single-line error preview for the ledger row. */
function toolErrorSummary(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) return firstLine(error.message);
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return firstLine(JSON.stringify(JSON.parse(trimmed)));
      } catch {
        return firstLine(error);
      }
    }
    return firstLine(error);
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return firstLine(record.message);
    }
  }
  try {
    const json = JSON.stringify(error);
    return json ? firstLine(json) : null;
  } catch {
    return null;
  }
}

function prettyJsonString(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return safeJson(JSON.parse(trimmed));
  } catch {
    return text;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 240 ? `${line.slice(0, 240)}...` : line;
}

/** First non-empty line of a block of text, for compact previews. */
function firstContentLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  return line.length > 240 ? `${line.slice(0, 240)}...` : line;
}

/** Per-side cap for a tool call preview, so input never crowds out output. */
const PREVIEW_PART_LIMIT = 80;

function clampLine(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** One-line preview for a value that may be JSON: compact JSON, else first text line. */
function previewValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed)) ?? trimmed;
      } catch {
        // Not JSON; fall through to the first line.
      }
    }
    return firstContentLine(value);
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Structured one-line preview for a tool call: input and result, each capped. */
export type ToolOutputTone = "muted" | "success" | "danger";

export interface ToolCallPreview {
  input: string;
  output: string;
  /** Color hint when the output is a status placeholder rather than real output. */
  tone: ToolOutputTone | null;
}

export function toolCallPreview(item: Extract<TimelineItem, { type: "tool_call" }>): ToolCallPreview {
  const input = clampLine(toolSummary(item.detail), PREVIEW_PART_LIMIT) || "tool call";
  const output =
    item.status === "failed"
      ? toolErrorSummary(item.error)
      : item.status === "completed"
        ? toolResultSummary(item.detail)
        : null;
  if (output) return { input, output: clampLine(output, PREVIEW_PART_LIMIT), tone: null };
  return { input, ...toolOutputPlaceholder(item.status) };
}

/** Status glyph shown in the output slot when a tool call produced no text. */
function toolOutputPlaceholder(status: string): { output: string; tone: ToolOutputTone } {
  switch (status) {
    case "running":
      return { output: "…", tone: "muted" };
    case "canceled":
      return { output: "⊘", tone: "muted" };
    case "failed":
      return { output: "✗", tone: "danger" };
    default:
      return { output: "✓", tone: "success" };
  }
}

/** First meaningful line of a completed tool call's result, for the preview. */
function toolResultSummary(detail: ToolDetail): string | null {
  const value = detail.type === "unknown" ? detail.output : toolResult(detail);
  const line = previewValue(value);
  return line.length > 0 ? line : null;
}

/**
 * Full searchable text for one record: everything a ledger search should
 * match — message and reasoning text, a tool call's name with its arguments,
 * result, and error, todo items, and so on. Used daemon-side to build search
 * blobs; the client never receives this text.
 */
export function recordSearchText(entry: TimelineEntry): string {
  const item = entry.item;
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "tool_call": {
      const parts = [item.name, toolArguments(item.detail)];
      const result = toolResult(item.detail);
      if (result.length > 0) parts.push(result);
      const error = toolErrorText(item.error);
      if (error) parts.push(error);
      return parts.join("\n");
    }
    case "todo":
      return item.items.map((task) => task.text).join("\n");
    case "error":
    case "notification":
      return item.message;
    case "compaction":
      return item.status;
    case "plugin":
      return [item.kind, safeJson(item.data)].join("\n");
    default:
      return "";
  }
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}
