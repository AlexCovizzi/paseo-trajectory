import type { PreviewRow, PreviewTurn } from "../shared/trajectory-rpc";

/** A ledger row plus the turn whose margin label it leads (first shown row). */
export interface LedgerRow extends PreviewRow {
  leadTurn?: PreviewTurn;
}

export interface DisplayRowsOptions {
  /** A search is active: only matching entries are shown. */
  filtering: boolean;
  matchKeys: ReadonlySet<string>;
  collapsedTurns: ReadonlySet<string>;
  collapsedToolSteps: ReadonlySet<string>;
}

/** Step a row's tool calls fold under, or null when it is not a tool row. */
export function toolStepKey(row: PreviewRow): string | null {
  if (
    row.kind !== "entry" ||
    row.color !== "tool" ||
    row.turnIndex === undefined ||
    row.step === null ||
    row.step === undefined
  ) {
    return null;
  }
  return `${row.turnIndex}:${row.step}`;
}

/** Projects store rows into ledger rows: attaches turn labels, folds collapsed
 * turns and tool steps, and filters to search matches. */
export function buildDisplayRows(
  rows: readonly PreviewRow[],
  options: DisplayRowsOptions,
): LedgerRow[] {
  const { filtering, matchKeys, collapsedTurns, collapsedToolSteps } = options;
  const out: LedgerRow[] = [];
  // A turn row is not a ledger row: it becomes the margin label led by the
  // next shown entry row's gutter.
  let leadTurn: PreviewTurn | null = null;
  let currentTurn: string | null = null;
  // A folded turn queues one summary row standing in for its hidden rows.
  let folded: { turn: PreviewTurn; order: number; hidden: number } | null = null;
  // Consecutive collapsed tool calls in one step collapse into a single
  // summary row; any other row (or a step change) flushes the buffer.
  let tools: { key: string; order: number; names: string[]; count: number } | null = null;
  const push = (row: PreviewRow) => {
    out.push(leadTurn ? { ...row, leadTurn } : row);
    leadTurn = null;
  };
  const pushFoldRow = () => {
    const pending = folded;
    folded = null;
    if (!pending || pending.hidden === 0) return;
    out.push({
      key: `fold:${pending.turn.id ?? "none"}:${pending.order}`,
      kind: "fold",
      order: pending.order,
      leadTurn: leadTurn ?? undefined,
      turn: pending.turn,
    });
    leadTurn = null;
  };
  const pushToolFold = () => {
    const pending = tools;
    tools = null;
    if (!pending) return;
    out.push({
      key: `toolfold:${pending.key}`,
      kind: "toolfold",
      order: pending.order,
      leadTurn: leadTurn ?? undefined,
      toolFold: { key: pending.key, count: pending.count, names: pending.names },
    });
    leadTurn = null;
  };
  for (const row of rows) {
    if (row.kind === "turn") {
      pushToolFold();
      pushFoldRow();
      leadTurn = row.turn ?? null;
      currentTurn = row.turn?.id ?? null;
      if (!filtering && currentTurn !== null && collapsedTurns.has(currentTurn) && row.turn) {
        folded = { turn: row.turn, order: row.order, hidden: 0 };
      }
      continue;
    }
    if (filtering) {
      pushToolFold();
      if (row.kind === "entry" && matchKeys.has(row.key)) push(row);
    } else {
      const foldedAway =
        currentTurn !== null && collapsedTurns.has(currentTurn) && row.color !== "user";
      if (foldedAway) {
        pushToolFold();
        if (folded) folded.hidden += 1;
        continue;
      }
      const stepKey = toolStepKey(row);
      if (stepKey !== null && collapsedToolSteps.has(stepKey)) {
        const name = row.label ?? "tool call";
        if (tools && tools.key === stepKey) {
          tools.count += 1;
          if (!tools.names.includes(name)) tools.names.push(name);
        } else {
          pushToolFold();
          tools = { key: stepKey, order: row.order, names: [name], count: 1 };
        }
        continue;
      }
      pushToolFold();
      push(row);
    }
  }
  pushToolFold();
  pushFoldRow();
  return out;
}
