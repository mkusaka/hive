// Placement (docs/architecture.md §9.2 step 1, §10.1, §10.2): which device may take a queued Job right now. Pure
// functions over a snapshot of the Workspace's devices; the executor routes load the snapshot and call them for the
// job list, `job.claim`, `waiting_device` and `GET /v1/jobs/:id`. There is no offers table: the deterministic rank
// rule below is the offer.
import type { PlacementPolicy } from "@hive/contracts";

/** Online = heartbeat within 3 × the 15 s heartbeat (docs/roadmap.md §1). */
export const onlineMs = 45_000;

export type PlacementDevice = {
  id: string;
  lastHeartbeatAt: string | null;
  capabilities: string[];
  /** Names of the environments registered on the device. */
  environments: string[];
  /** `capacity_background`. */
  capacity: number;
  /** Active root Runs on the device (starting / running / waiting_approval / stopping). */
  active: number;
};

export type PlacementReason =
  | "not_allowed"
  | "capability_missing"
  | "environment_missing"
  | "offline"
  | "at_capacity"
  | "higher_ranked_online"
  | "fallback_disabled";

/** Safety and capability constraints: why `device` can never run a Job with `policy` (empty = it can). */
export const constraintReasons = (policy: PlacementPolicy, device: PlacementDevice) => {
  const reasons: PlacementReason[] = [];
  const allowed = policy.allowedDeviceIds as string[];
  if (
    (allowed.length > 0 && !allowed.includes(device.id)) ||
    (policy.mode === "pinned" && policy.preferredDeviceIds[0] !== device.id)
  ) {
    reasons.push("not_allowed");
  }
  if (policy.environmentId !== undefined && !device.environments.includes(policy.environmentId)) {
    reasons.push("environment_missing");
  }
  if (!policy.requiredCapabilities.every((c) => device.capabilities.includes(c))) {
    reasons.push("capability_missing");
  }
  return reasons;
};

export const online = (device: PlacementDevice, now: number) =>
  device.lastHeartbeatAt !== null && now - Date.parse(device.lastHeartbeatAt) <= onlineMs;

/** Everything keeping `device` from a Job now (constraints, offline, full); `waitingReason` lists these. */
export const deviceReasons = (policy: PlacementPolicy, device: PlacementDevice, now: number) => [
  ...constraintReasons(policy, device),
  ...(online(device, now) ? [] : (["offline"] as const)),
  ...(device.active >= device.capacity ? (["at_capacity"] as const) : []),
];

/** Lower is preferred. `preferredDeviceIds` in order, every other device after them, all equal; `any` ranks none. */
const rankOf = (policy: PlacementPolicy, deviceId: string) => {
  if (policy.mode === "any") return 0;
  const i = (policy.preferredDeviceIds as string[]).indexOf(deviceId);
  return i < 0 ? policy.preferredDeviceIds.length : i;
};

/**
 * The offer rule: why `self` may not take the Job now, or null. `self` must meet the constraints and have a free slot.
 * Every higher-ranked device that meets the constraints must be passable: offline needs `fallbackOnUnavailable`,
 * online and full needs `overflowToFallback`, online with a free slot always keeps the Job. `self` is claiming or
 * listing, so it counts as online whatever its last heartbeat says.
 */
export const refusal = (
  policy: PlacementPolicy,
  devices: PlacementDevice[],
  self: PlacementDevice,
  now: number,
): PlacementReason | null => {
  const [constraint] = constraintReasons(policy, self);
  if (constraint) return constraint;
  if (self.active >= self.capacity) return "at_capacity";
  const mine = rankOf(policy, self.id);
  for (const d of devices) {
    if (d.id === self.id || rankOf(policy, d.id) >= mine) continue;
    if (constraintReasons(policy, d).length > 0) continue;
    if (!online(d, now)) {
      if (!policy.fallbackOnUnavailable) return "fallback_disabled";
    } else if (d.active < d.capacity || !policy.overflowToFallback) {
      return "higher_ranked_online";
    }
  }
  return null;
};

/** A Job with constraints and no online device meeting them waits (`waiting_device`); a free-for-all Job never does. */
export const shouldWait = (policy: PlacementPolicy, devices: PlacementDevice[], now: number) =>
  (policy.allowedDeviceIds.length > 0 ||
    policy.mode === "pinned" ||
    policy.environmentId !== undefined ||
    policy.requiredCapabilities.length > 0) &&
  !devices.some((d) => online(d, now) && constraintReasons(policy, d).length === 0);
