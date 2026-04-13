import { describe, expect, test } from "bun:test";
import { parseConfigText } from "../config/config.ts";
import { openDb } from "../db/schema.ts";
import { Service } from "../service/service.ts";
import { reconcileSessionPidsOnStartup } from "./reconcile.ts";

function makeSvc() {
  const db = openDb(":memory:");
  return new Service(db, parseConfigText(""));
}

describe("reconcileSessionPidsOnStartup", () => {
  test("clears sessions whose pids fail verification", () => {
    const svc = makeSvc();
    svc.setSessionPid("alive", 100);
    svc.setSessionPid("dead", 200);
    const cleared = reconcileSessionPidsOnStartup(svc, (pid) => pid === 100);
    expect(cleared).toBe(1);
    const live = svc.listLivePidSessions();
    expect(live.length).toBe(1);
    expect(live[0]?.sessionId).toBe("alive");
  });

  test("returns 0 when no pid-bearing sessions exist", () => {
    const svc = makeSvc();
    const cleared = reconcileSessionPidsOnStartup(svc, () => true);
    expect(cleared).toBe(0);
  });
});
