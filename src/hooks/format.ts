import type { StoredEvent } from "../service/types.ts";

const BAR = "─".repeat(40);

export function formatEvents(events: StoredEvent[], now: Date): string {
  const count = events.length;
  const parts: string[] = [];
  parts.push(BAR);
  parts.push(`${count} new event${count === 1 ? "" : "s"}`);
  parts.push(BAR);
  if (count === 0) return `${parts.join("\n")}\n`;
  parts.push("");
  for (const ev of events) {
    parts.push(`from: ${ev.source}`);
    parts.push(`type: ${ev.type}`);
    parts.push(`when: ${formatWhen(new Date(ev.time), now)}`);
    parts.push("");
    parts.push(...renderYaml(ev.data, 1));
    parts.push("");
    parts.push(BAR);
  }
  return `${parts.join("\n")}\n`;
}

export function formatWhen(time: Date, now: Date): string {
  return `${formatRelative(time, now)} (${formatAbsolute(time)})`;
}

function formatRelative(time: Date, now: Date): string {
  const diffMs = now.getTime() - time.getTime();
  const abs = Math.abs(diffMs);
  if (abs < 60_000) return "just now";
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatAbsolute(d: Date): string {
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${date}, ${time}`;
}

function renderYaml(value: unknown, depth: number): string[] {
  const pad = "  ".repeat(depth);
  if (value === null || value === undefined) return [`${pad}null`];
  if (typeof value === "string") return [`${pad}${value}`];
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return [`${pad}${String(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const out: string[] = [];
    for (const item of value) {
      if (item === null || typeof item !== "object") {
        out.push(`${pad}- ${scalarStr(item)}`);
      } else {
        const nested = renderYaml(item, depth + 1);
        const firstPad = "  ".repeat(depth + 1);
        const first = nested[0] ?? "";
        out.push(`${pad}- ${first.slice(firstPad.length)}`);
        for (let i = 1; i < nested.length; i++) {
          const line = nested[i];
          if (line !== undefined) out.push(line);
        }
      }
    }
    return out;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [`${pad}{}`];
  const out: string[] = [];
  for (const [k, v] of entries) {
    if (v === null || typeof v !== "object") {
      out.push(`${pad}${k}: ${scalarStr(v)}`);
      continue;
    }
    if (Array.isArray(v) && v.length === 0) {
      out.push(`${pad}${k}: []`);
      continue;
    }
    if (!Array.isArray(v) && Object.keys(v as object).length === 0) {
      out.push(`${pad}${k}: {}`);
      continue;
    }
    out.push(`${pad}${k}:`);
    out.push(...renderYaml(v, depth + 1));
  }
  return out;
}

function scalarStr(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  return String(v);
}
