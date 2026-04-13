import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "UserPromptSubmit",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}

interface HookRegistration {
  matcher?: string;
  hooks?: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookRegistration[]>;
  [key: string]: unknown;
}

export interface InstallOpts {
  settingsPath: string;
  command: string;
  timeoutMs?: number;
  marker?: string;
}

export interface InstallResult {
  added: HookEventName[];
  alreadyPresent: HookEventName[];
}

export interface UninstallResult {
  removed: HookEventName[];
}

export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR;
  if (override && override.length > 0) return join(override, "settings.json");
  return join(homedir(), ".claude", "settings.json");
}

export function hookCommand(execPath: string, cliPath: string, hookName: string): string {
  return `${quote(execPath)} ${quote(cliPath)} hook ${hookName}`;
}

function quote(s: string): string {
  return s.includes(" ") ? `"${s}"` : s;
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as ClaudeSettings;
  } catch {
    throw new Error(`claude settings at ${path} is not valid JSON`);
  }
}

function writeSettings(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function matches(reg: HookRegistration, marker: string): boolean {
  return (reg.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(marker));
}

export function installHooks(opts: InstallOpts): InstallResult {
  const settings = readSettings(opts.settingsPath);
  const timeout = opts.timeoutMs ?? 500;
  const marker = opts.marker ?? opts.command;
  const hooks = settings.hooks ?? {};
  const added: HookEventName[] = [];
  const alreadyPresent: HookEventName[] = [];
  for (const event of HOOK_EVENTS) {
    const list = hooks[event] ?? [];
    if (list.some((reg) => matches(reg, marker))) {
      alreadyPresent.push(event);
      hooks[event] = list;
      continue;
    }
    const entry: HookRegistration = {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: `${opts.command} ${event}`,
          timeout,
        },
      ],
    };
    list.push(entry);
    hooks[event] = list;
    added.push(event);
  }
  settings.hooks = hooks;
  writeSettings(opts.settingsPath, settings);
  return { added, alreadyPresent };
}

export function uninstallHooks(opts: { settingsPath: string; marker: string }): UninstallResult {
  const settings = readSettings(opts.settingsPath);
  if (!settings.hooks) return { removed: [] };
  const removed: HookEventName[] = [];
  const next: Record<string, HookRegistration[]> = {};
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (HOOK_EVENTS.includes(event as HookEventName)) {
      const filtered = list.filter((reg) => !matches(reg, opts.marker));
      if (filtered.length !== list.length) removed.push(event as HookEventName);
      if (filtered.length > 0) next[event] = filtered;
    } else {
      next[event] = list;
    }
  }
  if (Object.keys(next).length === 0) {
    settings.hooks = undefined;
  } else {
    settings.hooks = next;
  }
  writeSettings(opts.settingsPath, settings);
  return { removed };
}
