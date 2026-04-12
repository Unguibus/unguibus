#!/usr/bin/env bun
import { loadConfig } from "../config/config.ts";
import { resolvePaths } from "../config/paths.ts";

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
  health
  --version

OUTPUT:
  Human-readable by default. Pass --json for machine-readable output.

EXIT CODES:
  0 success; 1 operation failure; 2 usage error.
`;

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
