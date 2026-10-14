/**
 * Keeps shared/timeline-types.ts in step with the SDK: each assertion below
 * fails to compile if the real timeline type no longer fits the mirror.
 *
 * Not imported by an entry point, so the host never bundles it.
 */

import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { TimelineCursor, TimelineEntry, TimelineItem, ToolDetail } from "../shared/timeline-types";

type Paseo = PluginHookContext["paseo"];
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
type SdkTimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
type SdkEntry = SdkTimelinePage["entries"][number];
type SdkCursor = NonNullable<SdkTimelinePage["startCursor"]>;
type SdkItem = SdkEntry["item"];
type SdkToolDetail = Extract<SdkItem, { type: "tool_call" }>["detail"];

type AssertAssignable<Target, Source extends Target> = Source;

export type TimelineItemConformance = AssertAssignable<TimelineItem, SdkItem>;
export type ToolDetailConformance = AssertAssignable<ToolDetail, SdkToolDetail>;
export type TimelineEntryConformance = AssertAssignable<TimelineEntry, SdkEntry>;
export type TimelineCursorConformance = AssertAssignable<TimelineCursor, SdkCursor>;
