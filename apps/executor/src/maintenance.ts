import { z } from "zod";
import type { RunContext } from "@hive/contracts";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => new TextEncoder().encode(value).length <= max,
      `must be at most ${max} bytes`,
    );
const revision = z.number().int().min(1);

const pinnedFact = z.strictObject({
  kind: z.enum(["unresolved_request", "decision", "prohibition", "in_progress_task", "reference"]),
  text: text(4096),
  sourceMessageIds: z.array(z.string().min(1)),
});
const summaryOutput = z.strictObject({
  text: text(8 * 1024),
  pinnedFacts: z.array(pinnedFact),
});

const memoryReference = z.strictObject({ id: z.string().min(1), revision });
const consolidationOutput = z.strictObject({
  writes: z.array(
    z.strictObject({
      content: text(16 * 1024),
      mergedFrom: z.array(memoryReference),
      sourceConversationIds: z.array(z.string().min(1)),
      proposedScope: z.literal("workspace").optional(),
      supersedes: memoryReference.optional(),
    }),
  ),
  deletes: z.array(memoryReference),
});

// Claude's schema validator uses draft-7. Byte limits and provenance are also checked locally.
export const maintenanceOutputSchemas: Record<
  Exclude<RunContext["jobKind"], "normal">,
  Record<string, unknown>
> = {
  summarize: z.toJSONSchema(summaryOutput, { target: "draft-7" }),
  consolidate: z.toJSONSchema(consolidationOutput, { target: "draft-7" }),
};

export type SummaryOutput = z.infer<typeof summaryOutput>;
export type ConsolidationPlan = z.infer<typeof consolidationOutput>;

const parse = <T>(value: unknown, schema: z.ZodType<T>): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`invalid structured output: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

export const parseSummaryOutput = (value: unknown, context: RunContext): SummaryOutput => {
  const summarization = context.summarization;
  if (!summarization) throw new Error("missing summarization context");
  const output = parse(value, summaryOutput);
  const messageIds = new Set([
    ...summarization.messages.map((message) => message.id),
    ...(summarization.previousSummary?.pinnedFacts.flatMap((fact) => fact.sourceMessageIds) ?? []),
  ]);
  for (const fact of output.pinnedFacts) {
    for (const messageId of fact.sourceMessageIds) {
      if (!messageIds.has(messageId)) {
        throw new Error(`message ${messageId} is not a summarization source`);
      }
    }
  }
  return output;
};

/**
 * A consolidation plan may use only the exact memory revisions and conversation provenance the Worker put in this
 * context. Validate the complete plan before the runner issues any write or delete command.
 */
export const parseConsolidationPlan = (value: unknown, context: RunContext): ConsolidationPlan => {
  const consolidation = context.consolidation;
  if (!consolidation) throw new Error("missing consolidation context");
  const plan = parse(value, consolidationOutput);
  const memories = new Map(consolidation.memories.map((memory) => [memory.id, memory]));
  const conversations = new Set([
    ...consolidation.summaries.map((summary) => summary.conversationId),
    ...consolidation.memories.flatMap((memory) => memory.sourceConversationIds),
  ]);
  const checked = new Set<string>();
  const checkReference = (reference: z.infer<typeof memoryReference>) => {
    const memory = memories.get(reference.id);
    if (!memory || memory.revision !== reference.revision) {
      throw new Error(`memory ${reference.id} is not an unchanged consolidation input`);
    }
    return memory;
  };
  for (const write of plan.writes) {
    if (consolidation.scopeKind !== "bot" && write.proposedScope) {
      throw new Error("only Bot consolidation may propose workspace promotion");
    }
    if (!write.mergedFrom.length && !write.sourceConversationIds.length) {
      throw new Error("a consolidation write needs a memory or conversation source");
    }
    const merged = new Set<string>();
    const inheritedConversations = new Set<string>();
    for (const reference of write.mergedFrom) {
      const memory = checkReference(reference);
      if (merged.has(reference.id))
        throw new Error(`memory ${reference.id} is merged more than once`);
      merged.add(reference.id);
      for (const conversationId of memory.sourceConversationIds) {
        inheritedConversations.add(conversationId);
      }
    }
    for (const conversationId of write.sourceConversationIds) {
      if (!conversations.has(conversationId)) {
        throw new Error(`conversation ${conversationId} is not a consolidation source`);
      }
    }
    if (new Set(write.sourceConversationIds).size !== write.sourceConversationIds.length) {
      throw new Error("sourceConversationIds contains a duplicate");
    }
    for (const conversationId of inheritedConversations) {
      if (!write.sourceConversationIds.includes(conversationId)) {
        throw new Error(`memory source conversation ${conversationId} was not preserved`);
      }
    }
    if (write.supersedes) {
      checkReference(write.supersedes);
      if (checked.has(write.supersedes.id))
        throw new Error(`memory ${write.supersedes.id} is changed twice`);
      checked.add(write.supersedes.id);
    }
  }
  for (const reference of plan.deletes) {
    checkReference(reference);
    if (checked.has(reference.id)) throw new Error(`memory ${reference.id} is changed twice`);
    checked.add(reference.id);
  }
  return plan;
};
