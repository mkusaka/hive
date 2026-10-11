export type Principal =
  | { kind: "user"; userId: string; workspaceIds: string[] }
  | { kind: "device"; deviceId: string; ownerUserId: string; workspaceIds: string[] }
  | {
      /** A Run's capability (docs/architecture.md §18.2): acts as the Run's Bot. */
      kind: "run";
      runId: string;
      jobId: string;
      botId: string;
      botActorId: string;
      workspaceId: string;
      workspaceIds: string[];
      executionGeneration: number;
      /** The trigger Inbox item's Conversation and hop (§8.2); a Job without one has hop 0. */
      conversationId: string | null;
      /** That Conversation's Channel (a `botpair:` Channel for a bot-to-bot conversation). */
      channelId: string | null;
      hop: number;
      /** The Job's correlation id, or the Job id when it has none (it started a chain). */
      correlationId: string;
      taskId: string | null;
      taskProjectId: string | null;
      /** The task.delegate this Run's Job works under (§8.1); a delegated Task write needs an active `write` one. */
      delegation: { id: string; mode: "read" | "write"; state: string } | null;
      scopes: string[];
    };
