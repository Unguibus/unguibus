import { isValidType } from "../config/grammar.ts";
import type { Service } from "../service/service.ts";
import { ServiceError } from "../service/types.ts";
import { formatEvents } from "./format.ts";

const DELIVERY_HOOKS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification"]);

export type HookResult = { status: 200; additionalContext: string } | { status: 204 };

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

export function handleHook(
  service: Service,
  hookName: string,
  sessionId: string,
  body: Record<string, unknown>,
  nowFn: () => Date = () => new Date(),
): HookResult {
  if (!sessionId) {
    throw new ServiceError("invalid_session", "sessionId is required");
  }
  const kebabName = kebab(hookName);
  const eventType = `agent.claude.${kebabName}.${sessionId}`;
  if (!isValidType(eventType)) {
    throw new ServiceError(
      "invalid_hook_name",
      `hook name ${JSON.stringify(hookName)} or sessionId produces invalid event type ${JSON.stringify(eventType)}`,
    );
  }

  service.updateLastHookTime(sessionId);

  if (hookName === "SessionStart") {
    const ppid = typeof body.ppid === "number" ? body.ppid : null;
    if (ppid !== null) service.setSessionPid(sessionId, ppid);
  } else if (hookName === "SessionEnd") {
    service.clearSessionPid(sessionId);
  } else if (hookName === "Stop") {
    service.promotePendingWatermark(sessionId);
  }

  service.publishEvent({
    source: `urn:unguibus:hook:${sessionId}`,
    type: eventType,
    data: body,
  });

  if (DELIVERY_HOOKS.has(hookName)) {
    const events = service.claimPendingEvents(sessionId);
    const additionalContext = formatEvents(events, nowFn());
    return { status: 200, additionalContext };
  }
  return { status: 204 };
}
