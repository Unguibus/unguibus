import type { Service } from "../service/service.ts";
import { verifySessionPid as defaultVerify } from "./pid.ts";

export function reconcileSessionPidsOnStartup(
  service: Service,
  verify: (pid: number) => boolean = defaultVerify,
): number {
  let cleared = 0;
  for (const session of service.listLivePidSessions()) {
    if (!verify(session.pid)) {
      service.cleanupKilledSession(session.sessionId);
      cleared += 1;
    }
  }
  return cleared;
}
