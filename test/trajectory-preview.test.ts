import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  countSteps,
  entryKey,
  groupEntries,
  itemColor,
  itemMeta,
  itemSummary,
  mixColor,
  recordSearchText,
  toolArguments,
  toolCallPreview,
  toolErrorText,
  toolResult,
} from "../shared/trajectory-preview";
import type { TimelineEntry, TimelineItem } from "../shared/timeline-types";

function entry(seqStart: number, item: TimelineItem, turnId?: string): TimelineEntry {
  return {
    provider: "test",
    item,
    turnId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, seqStart)).toISOString(),
    seqStart,
  };
}

const theme = {
  colors: {
    surface0: "#000000",
    statusDanger: "#ff0000",
    statusWarning: "#ffaa00",
    foregroundMuted: "#888888",
  },
} as unknown as PluginTheme;

describe("groupEntries", () => {
  it("groups consecutive entries by turn id", () => {
    const groups = groupEntries([
      entry(1, { type: "user_message", text: "hi" }, "t1"),
      entry(2, { type: "assistant_message", text: "yo" }, "t1"),
      entry(3, { type: "user_message", text: "more" }, "t2"),
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].turnId, "t1");
    assert.equal(groups[0].entries.length, 2);
    assert.equal(groups[1].turnId, "t2");
  });

  it("merges consecutive same-turn entries and collects turn-less ones into one bucket", () => {
    const groups = groupEntries([
      entry(1, { type: "error", message: "a" }),
      entry(2, { type: "error", message: "b" }),
      entry(3, { type: "user_message", text: "hi" }, "t1"),
      entry(4, { type: "error", message: "c" }),
    ]);
    assert.deepEqual(
      groups.map((group) => [group.turnId, group.entries.length]),
      [
        [null, 2],
        ["t1", 1],
        [null, 1],
      ],
    );
  });
});

describe("countSteps", () => {
  it("counts assistant/reasoning runs, each owning the tool calls after it", () => {
    const entries = [
      entry(1, { type: "user_message", text: "go" }),
      entry(2, { type: "assistant_message", text: "one" }),
      entry(3, { type: "tool_call", callId: "c1", name: "t", detail: { type: "unknown", input: null, output: null }, status: "completed", error: null }),
      entry(4, { type: "reasoning", text: "two" }),
      entry(5, { type: "assistant_message", text: "two" }),
      entry(6, { type: "tool_call", callId: "c2", name: "t", detail: { type: "unknown", input: null, output: null }, status: "completed", error: null }),
      entry(7, { type: "assistant_message", text: "three" }),
    ];
    assert.equal(countSteps(entries), 3);
  });

  it("does not count consecutive reasoning/assistant entries as separate steps", () => {
    const entries = [
      entry(1, { type: "reasoning", text: "a" }),
      entry(2, { type: "assistant_message", text: "b" }),
    ];
    assert.equal(countSteps(entries), 1);
  });
});

describe("itemSummary", () => {
  it("summarizes messages by their first line", () => {
    assert.equal(itemSummary({ type: "user_message", text: "hello\nworld" }), "hello");
  });

  it("counts tasks", () => {
    assert.equal(
      itemSummary({
        type: "todo",
        items: [
          { text: "a", completed: true },
          { text: "b", completed: false },
          { text: "c", completed: false, status: "completed" },
        ],
      }),
      "2/3 tasks",
    );
  });

  it("summarizes compaction status", () => {
    assert.equal(itemSummary({ type: "compaction", status: "loading" }), "Compacting context");
    assert.equal(itemSummary({ type: "compaction", status: "completed" }), "Context compacted");
  });

  it("previews tool calls as input → output", () => {
    assert.equal(
      itemSummary({
        type: "tool_call",
        callId: "c",
        name: "shell",
        detail: { type: "shell", command: "npm test", output: "ok" },
        status: "completed",
        error: null,
      }),
      "npm test → ok",
    );
  });
});

describe("toolCallPreview", () => {
  it("shows the first line of a completed result", () => {
    const preview = toolCallPreview({
      type: "tool_call",
      callId: "c",
      name: "read",
      detail: { type: "read", filePath: "/a/b.ts", content: "line1\nline2" },
      status: "completed",
      error: null,
    });
    assert.equal(preview.input, "/a/b.ts");
    assert.equal(preview.output, "line1");
    assert.equal(preview.tone, null);
  });

  it("shows a failed call's error text", () => {
    const preview = toolCallPreview({
      type: "tool_call",
      callId: "c",
      name: "shell",
      detail: { type: "shell", command: "npm test" },
      status: "failed",
      error: { message: "boom" },
    });
    assert.equal(preview.output, "boom");
    assert.equal(preview.tone, null);
  });

  it("falls back to a status glyph when there is no output", () => {
    const running = toolCallPreview({
      type: "tool_call",
      callId: "c",
      name: "shell",
      detail: { type: "shell", command: "npm test" },
      status: "running",
      error: null,
    });
    assert.deepEqual(running, { input: "npm test", output: "…", tone: "muted" });

    const canceled = toolCallPreview({
      type: "tool_call",
      callId: "c",
      name: "shell",
      detail: { type: "shell", command: "npm test" },
      status: "canceled",
      error: null,
    });
    assert.deepEqual(canceled, { input: "npm test", output: "⊘", tone: "muted" });
  });

  it("surfaces the first recognizable argument of an unknown tool", () => {
    const preview = toolCallPreview({
      type: "tool_call",
      callId: "c",
      name: "mystery",
      detail: { type: "unknown", input: { command: "git status" }, output: null },
      status: "running",
      error: null,
    });
    assert.equal(preview.input, "git status");
  });
});

describe("tool helpers", () => {
  it("serializes tool arguments per detail shape", () => {
    const args = toolArguments({
      type: "edit",
      filePath: "/a.ts",
      oldString: "old",
      newString: "new",
    });
    assert.deepEqual(JSON.parse(args), { filePath: "/a.ts", oldString: "old", newString: "new" });
  });

  it("returns the raw result text per detail shape", () => {
    assert.equal(toolResult({ type: "shell", command: "ls", output: "a\nb" }), "a\nb");
    assert.equal(toolResult({ type: "write", filePath: "/a", content: "body" }), "body");
  });

  it("unwraps error message wrappers and pretty-prints JSON strings", () => {
    assert.equal(toolErrorText(null), null);
    assert.equal(toolErrorText("boom"), "boom");
    assert.equal(toolErrorText(new Error("bad")), "bad");
    const wrapped = toolErrorText({ message: "bad", code: 42 });
    assert.match(wrapped ?? "", /^bad\n/);
    assert.match(wrapped ?? "", /"code": 42/);
  });
});

describe("recordSearchText", () => {
  it("includes a tool call's name, arguments, and result", () => {
    const text = recordSearchText(
      entry(1, {
        type: "tool_call",
        callId: "c",
        name: "read",
        detail: { type: "read", filePath: "/a.ts", content: "the content" },
        status: "completed",
        error: null,
      }),
    );
    assert.match(text, /read/);
    assert.match(text, /\/a\.ts/);
    assert.match(text, /the content/);
  });

  it("includes todo item text", () => {
    const text = recordSearchText(
      entry(1, { type: "todo", items: [{ text: "ship it", completed: false }] }),
    );
    assert.match(text, /ship it/);
  });
});

describe("entryKey", () => {
  it("combines the seq start with the item type", () => {
    assert.equal(entryKey(entry(5, { type: "user_message", text: "hi" })), "5:user_message");
  });
});

describe("colors", () => {
  it("resolves status colors from the theme and kind colors from the palette", () => {
    assert.equal(itemColor("danger", theme), "#ff0000");
    assert.equal(itemColor("warning", theme), "#ffaa00");
    assert.equal(itemColor("muted", theme), "#888888");
    assert.equal(itemColor("user", theme), "#60a5fa");
  });

  it("switches kind palettes on surface luminance", () => {
    const light = { ...theme, colors: { ...theme.colors, surface0: "#ffffff" } } as unknown as PluginTheme;
    assert.equal(itemColor("user", light), "#2563eb");
  });

  it("mixes colors channel-wise", () => {
    assert.equal(mixColor("#000000", "#ffffff", 0.5), "#808080");
    assert.equal(mixColor("#000000", "#ffffff", 2), "#ffffff");
  });
});

describe("itemMeta", () => {
  it("labels tool calls with their name and repeats it in the ledger", () => {
    const meta = itemMeta({ type: "tool_call", callId: "c", name: "read", detail: { type: "unknown", input: null, output: null }, status: "completed", error: null });
    assert.equal(meta.label, "read");
    assert.equal(meta.showLabel, true);
    assert.equal(meta.color, "tool");
  });

  it("colors notifications by level", () => {
    assert.equal(itemMeta({ type: "notification", level: "error", message: "x" }).color, "danger");
    assert.equal(itemMeta({ type: "notification", level: "info", message: "x" }).color, "muted");
  });
});
