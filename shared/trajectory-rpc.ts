import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ITEM_COLORS } from "./trajectory-preview";

/**
 * Wire contract between the daemon-side trajectory store and the panel.
 *
 * The store pre-computes ledger rows (PreviewRow): everything the ledger needs
 * to render a row, and nothing more. Full record content is served separately,
 * on demand, so paging stays small even though timeline entries carry complete
 * tool outputs.
 */

const previewToolCallSchema = z.object({
  input: z.string(),
  output: z.string(),
  tone: z.enum(["muted", "success", "danger"]).nullable(),
});

export const previewTurnSchema = z.object({
  id: z.string().nullable(),
  /** Absolute turn number across the whole session (server-assigned). */
  index: z.number(),
  steps: z.number(),
  tools: z.number(),
});

export type PreviewTurn = z.infer<typeof previewTurnSchema>;

export const previewRowSchema = z.object({
  key: z.string(),
  kind: z.enum(["turn", "step", "entry", "fold", "toolfold"]),
  /** Monotonic position in the store's row list; stable while the row exists. */
  order: z.number(),
  // Entry rows:
  icon: z.string().optional(),
  color: z.enum(ITEM_COLORS).optional(),
  label: z.string().optional(),
  showLabel: z.boolean().optional(),
  summary: z.string().optional(),
  preview: previewToolCallSchema.optional(),
  /** Failed tool calls read in the danger color. */
  danger: z.boolean().optional(),
  dim: z.boolean().optional(),
  timestamp: z.string().optional(),
  turnIndex: z.number().optional(),
  /** Step the entry belongs to; null before the turn's first step. */
  step: z.number().nullable().optional(),
  /** Provider resolved for this record's turn. */
  provider: z.string().nullable().optional(),
  // Turn rows (the fold summary line under a folded turn carries the turn
  // too; it is built client-side, never served):
  turn: previewTurnSchema.optional(),
  // Tool-call fold summary line (kind "toolfold"); built client-side, never
  // served. `key` is the folded step's identity, used to expand it on tap.
  toolFold: z
    .object({
      key: z.string(),
      count: z.number(),
      names: z.array(z.string()),
    })
    .optional(),
});

export type PreviewRow = z.infer<typeof previewRowSchema>;

export const trajectoryPageOutputSchema = z.object({
  rows: z.array(previewRowSchema),
  /** An older page exists above the first returned row. */
  hasEarlier: z.boolean(),
  /** Store revision; bumps on any change the panel might care about. */
  revision: z.number(),
  /** The daemon reported a gap in the loaded history. */
  gap: z.boolean(),
  status: z.string().nullable(),
});

export type TrajectoryPageResult = z.infer<typeof trajectoryPageOutputSchema>;

/**
 * Serves a page of pre-computed ledger rows. No cursor: the tail page. With
 * `beforeOrder`: the page of rows immediately older than that row order.
 */
export const getTrajectoryPageRpc = defineRpc({
  // Method names are plugin-scoped and must match ^[a-z][a-z0-9._-]*$.
  name: "get-trajectory-page",
  input: z.object({
    agentId: z.string().min(1),
    limit: z.number().int().positive().max(1000).optional(),
    beforeOrder: z.number().int().nonnegative().optional(),
  }),
  output: trajectoryPageOutputSchema,
});

/** One daemon timeline entry. `item` is a passthrough; the client narrows it
 * via the mirror in shared/timeline-types.ts. */
const timelineEntryEnvelopeSchema = z.object({
  provider: z.string(),
  item: z.unknown(),
  turnId: z.string().optional(),
  timestamp: z.string(),
  seqStart: z.number(),
});

/** Serves one full timeline entry for the record inspector. */
export const getRecordDetailRpc = defineRpc({
  name: "get-record-detail",
  input: z.object({ agentId: z.string().min(1), key: z.string().min(1) }),
  output: z.object({ entry: timelineEntryEnvelopeSchema.nullable() }),
});

const searchMatchSchema = z.object({
  /** Row key; the panel filters the ledger to the matching rows. */
  key: z.string(),
});

export const trajectorySearchSchema = z.object({
  /** Store revision; the panel re-runs an active query when it changes. */
  revision: z.number(),
  /** Matching entry rows in row order; capped at the store's match limit. */
  matches: z.array(searchMatchSchema),
  /** The match cap was hit; more matches exist. */
  truncated: z.boolean(),
});

export type TrajectorySearchMatch = z.infer<typeof searchMatchSchema>;
export type TrajectorySearchResult = z.infer<typeof trajectorySearchSchema>;

/**
 * Serves full-text search over the session's entry rows. The query is
 * whitespace-separated terms; every term must appear (case-insensitive) in
 * the row's searchable text — the pre-computed preview fields plus the full
 * record content while the entry is retained daemon-side.
 */
export const searchTrajectoryRpc = defineRpc({
  name: "search-trajectory",
  input: z.object({
    agentId: z.string().min(1),
    query: z.string().min(1).max(200),
  }),
  output: trajectorySearchSchema,
});
