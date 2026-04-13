export const TYPE_OR_PATTERN_RE = /^[a-zA-Z0-9-]+(\.([a-zA-Z0-9-]+|\*))*$/;

export const CONNECTOR_NAME_RE = /^[a-zA-Z0-9-]+$/;

export const EVENT_ID_RE = /^[\x20-\x7E]{1,256}$/;

export function isValidType(type: string): boolean {
  return typeof type === "string" && TYPE_OR_PATTERN_RE.test(type);
}

export function isValidPattern(pattern: string): boolean {
  return typeof pattern === "string" && TYPE_OR_PATTERN_RE.test(pattern);
}

export function isReservedType(type: string): boolean {
  return type.startsWith("service.unguibus.");
}

export function isValidConnectorName(name: string): boolean {
  return typeof name === "string" && CONNECTOR_NAME_RE.test(name);
}

export function isValidEventId(id: string): boolean {
  return typeof id === "string" && EVENT_ID_RE.test(id);
}

export function matchesPattern(pattern: string, type: string): boolean {
  const p = pattern.split(".");
  const t = type.split(".");
  if (p.length !== t.length) return false;
  for (let i = 0; i < p.length; i++) {
    const segP = p[i];
    const segT = t[i];
    if (segP === "*") continue;
    if (segP !== segT) return false;
  }
  return true;
}
