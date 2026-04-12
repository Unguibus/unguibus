#!/usr/bin/env bun
import { loadConfig } from "../config/config.ts";
import { resolvePaths } from "../config/paths.ts";
import {
  HOOK_EVENTS,
  defaultSettingsPath,
  installHooks,
  uninstallHooks,
} from "../install/hooks.ts";

const HELP = `unguibus — localhost event log for Claude Code integrations

USAGE:
  unguibus <command> [args...]

COMMANDS:
  publish <source> <type> [--data <json>] [--time <iso8601>] [--id <string>]
  query [--type <pattern>] [--source <src>] [--since <t>] [--until <t>]
        [--limit <n>] [--offset <n>] [--order asc|desc] [--json]
  pending <sessionId> [--json]
  subscribe <sessionId> <pattern>
  unsubscribe <sessionId> <pattern>
  subscriptions <sessionId> [--json]
  tag <sessionId> <tag>
  untag <sessionId> <tag>
  tags <sessionId> [--json]
  hook <HookName>                       # hook dispatcher (stdin = Claude hook JSON)
  install [--settings <path>]           # register hooks in ~/.claude/settings.json
  uninstall [--settings <path>]         # remove unguibus hooks from settings
  health
  --version

OUTPUT:
  Human-readable by default. Pass --json for machine-readable output.

EXIT CODES:
  0 success; 1 operation failure; 2 usage error.
`;

const UNGUIBUS_MARKER = "unguibus";

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function usageError(msg: string): never {
  process.stderr.write(`unguibus: ${msg}\n\n${HELP}`);
  process.exit(2);
}

function fatal(msg: string): never {
  process.stderr.write(`unguibus: ${msg}\n`);
  process.exit(1);
}

function resolveBaseUrl(): string {
  const paths = resolvePaths();
  const cfg = loadConfig(paths.configFile);
  return `http://127.0.0.1:${cfg.server.port}`;
}

function quoteIfNeeded(s: string): string {
  return s.includes(" ") ? `"${s}"` : s;
}

const DELIVERY_HOOKS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification"]);

async function hookDispatch(hookName: string): Promise<void> {
  const stdinText = await Bun.stdin.text();
  let body: Record<string, unknown> = {};
  if (stdinText.trim().length > 0) {
    try {
      body = JSON.parse(stdinText) as Record<string, unknown>;
    } catch {
      return;
    }
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  if (!sessionId) return;
  if (hookName === "SessionStart") {
    body.ppid = process.ppid;
  }
  const base = resolveBaseUrl();
  const url = `${base}/hooks/${encodeURIComponent(hookName)}/${encodeURIComponent(sessionId)}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(500),
  };
  if (hookName === "PostToolUse") {
    fetch(url, init).catch(() => {});
    return;
  }
  try {
    const res = await fetch(url, init);
    if (res.status === 200 && DELIVERY_HOOKS.has(hookName)) {
      const data = (await res.json()) as { additionalContext?: string };
      if (typeof data.additionalContext === "string" && data.additionalContext.length > 0) {
        const output = {
          hookSpecificOutput: {
            hookEventName: hookName,
            additionalContext: data.additionalContext,
          },
        };
        process.stdout.write(`${JSON.stringify(output)}\n`);
      }
    }
  } catch {
    // fail silently per design — claude's turn must continue unblocked
  }
}

async function request(
  method: string,
  base: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fatal(`could not reach unguibus at ${base} (${msg}). is the server running?`);
  }
  if (res.status === 204) return { status: 204, json: null };
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (res.status >= 400) {
    const err = (json as { error?: string; message?: string } | null) ?? null;
    fatal(`${res.status} ${err?.error ?? "error"}: ${err?.message ?? text}`);
  }
  return { status: res.status, json };
}

function printHuman(value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function print(json: boolean, value: unknown): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else {
    printHuman(value);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    const pkg = await import("../../package.json", { with: { type: "json" } });
    process.stdout.write(`${(pkg.default as { version: string }).version}\n`);
    return;
  }

  const cmd = argv[0] as string;
  const { positional, flags } = parseArgs(argv.slice(1));
  const json = flags.json === true;

  if (cmd === "hook") {
    if (positional.length < 1) usageError("hook requires <HookName>");
    await hookDispatch(positional[0] as string);
    return;
  }

  if (cmd === "install") {
    const settingsPath =
      typeof flags.settings === "string" ? flags.settings : defaultSettingsPath();
    const command = `${quoteIfNeeded(process.execPath)} ${quoteIfNeeded(Bun.main)}`;
    const result = installHooks({
      settingsPath,
      command: `${command} hook`,
      marker: UNGUIBUS_MARKER,
    });
    if (json) {
      print(true, { settingsPath, ...result });
    } else {
      process.stdout.write(`settings: ${settingsPath}\n`);
      if (result.added.length > 0) {
        process.stdout.write(`added: ${result.added.join(", ")}\n`);
      }
      if (result.alreadyPresent.length > 0) {
        process.stdout.write(`already present: ${result.alreadyPresent.join(", ")}\n`);
      }
      process.stdout.write(
        `hooks registered for ${HOOK_EVENTS.length} events. start the server with: unguibus serve\n`,
      );
    }
    return;
  }

  if (cmd === "uninstall") {
    const settingsPath =
      typeof flags.settings === "string" ? flags.settings : defaultSettingsPath();
    const result = uninstallHooks({ settingsPath, marker: UNGUIBUS_MARKER });
    if (json) {
      print(true, { settingsPath, ...result });
    } else {
      process.stdout.write(`settings: ${settingsPath}\n`);
      if (result.removed.length > 0) {
        process.stdout.write(`removed: ${result.removed.join(", ")}\n`);
      } else {
        process.stdout.write("no unguibus hooks found to remove\n");
      }
    }
    return;
  }

  const base = resolveBaseUrl();

  switch (cmd) {
    case "health": {
      const { json: body } = await request("GET", base, "/");
      print(json, body);
      return;
    }
    case "publish": {
      if (positional.length < 2) usageError("publish requires <source> <type>");
      const payload: Record<string, unknown> = {
        source: positional[0],
        type: positional[1],
      };
      if (typeof flags.data === "string") {
        try {
          payload.data = JSON.parse(flags.data);
        } catch {
          usageError("--data must be valid JSON");
        }
      }
      if (typeof flags.time === "string") payload.time = flags.time;
      if (typeof flags.id === "string") payload.id = flags.id;
      const { json: body } = await request("POST", base, "/events", payload);
      print(json, body);
      return;
    }
    case "query": {
      const params = new URLSearchParams();
      for (const k of ["type", "source", "since", "until", "limit", "offset", "order"]) {
        const v = flags[k];
        if (typeof v === "string") params.set(k, v);
      }
      const qs = params.toString();
      const { json: body } = await request("GET", base, `/events${qs ? `?${qs}` : ""}`);
      print(json, body);
      return;
    }
    case "pending": {
      if (positional.length < 1) usageError("pending requires <sessionId>");
      const sid = encodeURIComponent(positional[0] as string);
      const { json: body } = await request("GET", base, `/events/pending/${sid}`);
      print(json, body);
      return;
    }
    case "subscribe": {
      if (positional.length < 2) usageError("subscribe requires <sessionId> <pattern>");
      const sid = encodeURIComponent(positional[0] as string);
      await request("POST", base, `/sessions/${sid}/subscriptions`, {
        pattern: positional[1],
      });
      if (!json) process.stdout.write("ok\n");
      else print(true, { ok: true });
      return;
    }
    case "unsubscribe": {
      if (positional.length < 2) usageError("unsubscribe requires <sessionId> <pattern>");
      const sid = encodeURIComponent(positional[0] as string);
      const qs = new URLSearchParams({ pattern: positional[1] as string }).toString();
      await request("DELETE", base, `/sessions/${sid}/subscriptions?${qs}`);
      if (!json) process.stdout.write("ok\n");
      else print(true, { ok: true });
      return;
    }
    case "subscriptions": {
      if (positional.length < 1) usageError("subscriptions requires <sessionId>");
      const sid = encodeURIComponent(positional[0] as string);
      const { json: body } = await request("GET", base, `/sessions/${sid}/subscriptions`);
      print(json, body);
      return;
    }
    case "tag": {
      if (positional.length < 2) usageError("tag requires <sessionId> <tag>");
      const sid = encodeURIComponent(positional[0] as string);
      await request("POST", base, `/sessions/${sid}/tags`, { tag: positional[1] });
      if (!json) process.stdout.write("ok\n");
      else print(true, { ok: true });
      return;
    }
    case "untag": {
      if (positional.length < 2) usageError("untag requires <sessionId> <tag>");
      const sid = encodeURIComponent(positional[0] as string);
      const qs = new URLSearchParams({ tag: positional[1] as string }).toString();
      await request("DELETE", base, `/sessions/${sid}/tags?${qs}`);
      if (!json) process.stdout.write("ok\n");
      else print(true, { ok: true });
      return;
    }
    case "tags": {
      if (positional.length < 1) usageError("tags requires <sessionId>");
      const sid = encodeURIComponent(positional[0] as string);
      const { json: body } = await request("GET", base, `/sessions/${sid}/tags`);
      print(json, body);
      return;
    }
    default:
      usageError(`unknown command: ${cmd}`);
  }
}

await main();
