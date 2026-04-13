const UNIT_MS: Record<string, number> = {
  ns: 1 / 1_000_000,
  us: 1 / 1_000,
  µs: 1 / 1_000,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const TOKEN_RE = /([0-9]*\.?[0-9]+)(ns|us|µs|ms|s|m|h|d|w)/g;

export function parseDurationMs(input: string): number {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error(`invalid duration: ${JSON.stringify(input)}`);
  }
  let rest = input;
  let total = 0;
  let matched = false;
  TOKEN_RE.lastIndex = 0;
  for (const m of input.matchAll(TOKEN_RE)) {
    matched = true;
    const [full, num, unit] = m as unknown as [string, string, string];
    const factor = UNIT_MS[unit];
    if (factor === undefined) {
      throw new Error(`unknown duration unit in ${JSON.stringify(input)}: ${unit}`);
    }
    total += Number.parseFloat(num) * factor;
    rest = rest.replace(full, "");
  }
  if (!matched || rest.trim().length > 0) {
    throw new Error(`invalid duration: ${JSON.stringify(input)}`);
  }
  return total;
}
