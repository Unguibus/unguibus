import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_EVENTS, hookCommand, installHooks, uninstallHooks } from "./hooks.ts";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unguibus-install-"));
  settingsPath = join(dir, "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("installHooks", () => {
  test("writes all hook events on a fresh settings file", () => {
    const command = "/usr/bin/unguibus";
    const res = installHooks({ settingsPath, command });
    expect(res.added.length).toBe(HOOK_EVENTS.length);
    expect(res.alreadyPresent.length).toBe(0);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const event of HOOK_EVENTS) {
      expect(written.hooks[event]).toBeDefined();
      expect(written.hooks[event][0].hooks[0].command).toBe(`${command} ${event}`);
      expect(written.hooks[event][0].hooks[0].timeout).toBe(500);
    }
  });

  test("re-running install is idempotent (no duplicate entries)", () => {
    const command = "/usr/bin/unguibus";
    installHooks({ settingsPath, command });
    const res2 = installHooks({ settingsPath, command });
    expect(res2.added.length).toBe(0);
    expect(res2.alreadyPresent.length).toBe(HOOK_EVENTS.length);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const event of HOOK_EVENTS) {
      expect(written.hooks[event].length).toBe(1);
    }
  });

  test("preserves user-defined entries alongside unguibus entries", () => {
    const userHook = {
      matcher: "*",
      hooks: [{ type: "command", command: "/home/user/bin/my-pre-tool", timeout: 1000 }],
    };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [userHook] } }, null, 2));
    installHooks({ settingsPath, command: "/usr/bin/unguibus" });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.hooks.PreToolUse.length).toBe(2);
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe("/home/user/bin/my-pre-tool");
  });

  test("preserves unrelated top-level settings keys", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "dark", permissions: { allow: ["Read"] } }, null, 2),
    );
    installHooks({ settingsPath, command: "/usr/bin/unguibus" });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.permissions.allow).toEqual(["Read"]);
  });

  test("uses custom marker when provided (for command rename tolerance)", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: "/old/unguibus PreToolUse", timeout: 500 }],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const res = installHooks({
      settingsPath,
      command: "/new/unguibus",
      marker: "unguibus",
    });
    expect(res.alreadyPresent).toContain("PreToolUse");
  });
});

describe("uninstallHooks", () => {
  test("removes only unguibus entries, leaves user entries intact", () => {
    const userHook = {
      matcher: "*",
      hooks: [{ type: "command", command: "/home/user/bin/my-pre-tool", timeout: 1000 }],
    };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [userHook] } }, null, 2));
    installHooks({ settingsPath, command: "/usr/bin/unguibus" });
    const res = uninstallHooks({ settingsPath, marker: "/usr/bin/unguibus" });
    expect(res.removed.length).toBeGreaterThan(0);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.hooks.PreToolUse.length).toBe(1);
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe("/home/user/bin/my-pre-tool");
  });

  test("removes empty hooks key entirely when nothing remains", () => {
    installHooks({ settingsPath, command: "/usr/bin/unguibus" });
    uninstallHooks({ settingsPath, marker: "/usr/bin/unguibus" });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.hooks).toBeUndefined();
  });

  test("no-op on a settings file without unguibus entries", () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));
    const res = uninstallHooks({ settingsPath, marker: "/usr/bin/unguibus" });
    expect(res.removed.length).toBe(0);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.theme).toBe("dark");
  });
});

describe("hookCommand", () => {
  test("quotes paths containing spaces", () => {
    const cmd = hookCommand("/usr/bin/bun", "/Users/me/My Stuff/cli.ts", "PreToolUse");
    expect(cmd).toBe('/usr/bin/bun "/Users/me/My Stuff/cli.ts" hook PreToolUse');
  });
});
