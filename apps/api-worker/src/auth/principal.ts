export type Principal =
  | { kind: "user"; userId: string; workspaceIds: string[] }
  | { kind: "device"; deviceId: string; ownerUserId: string; workspaceIds: string[] };
