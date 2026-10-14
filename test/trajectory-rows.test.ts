import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDisplayRows, toolStepKey, type DisplayRowsOptions } from "../client/trajectory-rows";
import type { PreviewRow, PreviewTurn } from "../shared/trajectory-rpc";

let nextOrder = 0;

function row(partial: Partial<PreviewRow> & Pick<PreviewRow, "key" | "kind">): PreviewRow {
  return { order: nextOrder++, ...partial };
}

function turnRow(turn: PreviewTurn): PreviewRow {
  return row({ key: `turn:${turn.id}`, kind: "turn", turn });
}

function entryRow(key: string, color: PreviewRow["color"], extra: Partial<PreviewRow> = {}): PreviewRow {
  return row({ key, kind: "entry", color, ...extra });
}

function options(overrides: Partial<DisplayRowsOptions> = {}): DisplayRowsOptions {
  return {
    filtering: false,
    matchKeys: new Set(),
    collapsedTurns: new Set(),
    collapsedToolSteps: new Set(),
    ...overrides,
  };
}

const turn: PreviewTurn = { id: "t1", index: 1, steps: 2, tools: 1 };

describe("toolStepKey", () => {
  it("keys a tool entry by turn and step", () => {
    assert.equal(toolStepKey(entryRow("a", "tool", { turnIndex: 2, step: 3 })), "2:3");
  });

  it("returns null when the turn or step is missing", () => {
    assert.equal(toolStepKey(entryRow("a", "tool", { step: 1 })), null);
    assert.equal(toolStepKey(entryRow("a", "tool", { turnIndex: 1 })), null);
    assert.equal(toolStepKey(entryRow("a", "user", { turnIndex: 1, step: 1 })), null);
  });
});

describe("buildDisplayRows", () => {
  it("attaches each turn label to the first shown row", () => {
    const out = buildDisplayRows(
      [
        turnRow(turn),
        entryRow("u", "user", { turnIndex: 1, step: null }),
        entryRow("a", "assistant", { turnIndex: 1, step: 1 }),
      ],
      options(),
    );
    assert.deepEqual(out.map((r) => r.key), ["u", "a"]);
    assert.equal(out[0].leadTurn?.id, "t1");
    assert.equal(out[1].leadTurn, undefined);
  });

  it("shows only matching entries while filtering", () => {
    const out = buildDisplayRows(
      [
        turnRow(turn),
        entryRow("u", "user", { turnIndex: 1, step: null }),
        entryRow("a", "assistant", { turnIndex: 1, step: 1 }),
      ],
      options({ filtering: true, matchKeys: new Set(["a"]) }),
    );
    assert.deepEqual(out.map((r) => r.key), ["a"]);
    assert.equal(out[0].leadTurn?.id, "t1");
  });

  it("folds a collapsed turn to one summary row, keeping user rows", () => {
    const out = buildDisplayRows(
      [
        turnRow(turn),
        entryRow("u", "user", { turnIndex: 1, step: null }),
        entryRow("a", "assistant", { turnIndex: 1, step: 1 }),
        entryRow("t", "tool", { turnIndex: 1, step: 1 }),
      ],
      options({ collapsedTurns: new Set(["t1"]) }),
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].key, "u");
    assert.equal(out[1].kind, "fold");
    assert.match(out[1].key, /^fold:t1:/);
    assert.equal(out[1].turn?.id, "t1");
    assert.equal(out[0].leadTurn?.id, "t1");
  });

  it("gives a folded turn's summary row its label when nothing else shows", () => {
    const out = buildDisplayRows(
      [turnRow(turn), entryRow("a", "assistant", { turnIndex: 1, step: 1 })],
      options({ collapsedTurns: new Set(["t1"]) }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "fold");
    assert.equal(out[0].leadTurn?.id, "t1");
  });

  it("folds consecutive collapsed tool calls into one summary row", () => {
    const out = buildDisplayRows(
      [
        turnRow(turn),
        entryRow("u", "user", { turnIndex: 1, step: null }),
        row({ key: "step:1", kind: "step" }),
        entryRow("t1", "tool", { label: "read", turnIndex: 1, step: 1 }),
        entryRow("t2", "tool", { label: "read", turnIndex: 1, step: 1 }),
        entryRow("t3", "tool", { label: "write", turnIndex: 1, step: 1 }),
      ],
      options({ collapsedToolSteps: new Set(["1:1"]) }),
    );
    assert.deepEqual(out.map((r) => r.key), ["u", "step:1", "toolfold:1:1"]);
    assert.deepEqual(out[2].toolFold, { key: "1:1", count: 3, names: ["read", "write"] });
  });

  it("leaves rows untouched when nothing is collapsed or filtered", () => {
    const rows = [
      turnRow(turn),
      entryRow("u", "user", { turnIndex: 1, step: null }),
      row({ key: "step:1", kind: "step" }),
      entryRow("a", "assistant", { turnIndex: 1, step: 1 }),
    ];
    const out = buildDisplayRows(rows, options());
    assert.deepEqual(out.map((r) => r.key), ["u", "step:1", "a"]);
  });
});
