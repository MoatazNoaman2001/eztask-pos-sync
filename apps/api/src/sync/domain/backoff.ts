const BASE_MS = 1_000;
const CAP_MS = 60_000;
const JITTER = 0.2;

/**
 * Delay before retrying after `attempts` temporary failures: 1 s, 2 s, 4 s … capped at 60 s, ±20%.
 * Jitter spreads retries out, so checks that failed together don't all hit the POS together.
 * There is deliberately no max attempts: temporary errors retry forever (CLAUDE.md rule 8).
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempts - 1));
  const jitter = 1 + (random() * 2 - 1) * JITTER;
  return Math.round(exponential * jitter);
}
