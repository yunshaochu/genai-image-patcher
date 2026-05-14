/**
 * Global 429 cool-down gate.
 *
 * When ANY API call gets a 429 (or equivalent rate-limit signal), the gate
 * trips and every subsequent / in-flight API call must await `wait()` before
 * sending its request. This prevents the thundering-herd anti-pattern where
 * a single 429 immediately triggers N parallel retries that get the IP
 * banned.
 *
 * Strategy:
 * - Honour `Retry-After` first (capped at MAX_RETRY_AFTER_MS for safety)
 * - Else exponential backoff: BASE × MULT^k, capped at MAX
 * - ±JITTER applied so parallel callers don't re-synchronise
 * - Parallel 429s only EXTEND the gate, never shorten it
 * - If the gate has been open (i.e. ungated) for RESET_AFTER_MS, the next
 *   trip resets the escalation — the previous burst is treated as over
 */

const BASE_MS = 2_000;
const MAX_MS = 60_000;
const MULT = 2;
const JITTER = 0.25;
const RESET_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 300_000; // 5 min, cap pathological server values

class RateLimitGate {
  private gateUntil = 0;
  private currentBackoff = 0;
  private lastTripAt = 0;

  /**
   * Block until the gate opens. Polls in <=1s chunks so AbortSignal can
   * interrupt promptly.
   */
  async wait(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const remaining = this.gateUntil - Date.now();
      if (remaining <= 0) return;

      const chunk = Math.min(remaining, 1000);
      await new Promise<void>((resolve, reject) => {
        const tid = setTimeout(resolve, chunk);
        const onAbort = () => {
          clearTimeout(tid);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal) {
          if (signal.aborted) {
            clearTimeout(tid);
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          // Resolve path: remove the listener so we don't leak it.
          const origResolve = resolve;
          resolve = () => {
            signal.removeEventListener('abort', onAbort);
            origResolve();
          };
        }
      });
    }
  }

  /**
   * Mark a 429 hit. Returns the resulting wait time (ms) so callers can log
   * it. `retryAfterMs` is the server-provided Retry-After value if present.
   */
  trip(retryAfterMs?: number | null): number {
    const now = Date.now();

    // Idle window since the gate last closed → start a fresh cascade
    const idleAfterClose = this.gateUntil <= now ? now - this.gateUntil : 0;
    if (this.currentBackoff === 0 || idleAfterClose > RESET_AFTER_MS) {
      this.currentBackoff = BASE_MS;
    } else {
      this.currentBackoff = Math.min(MAX_MS, this.currentBackoff * MULT);
    }

    let waitMs: number;
    if (retryAfterMs != null && retryAfterMs > 0) {
      waitMs = Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    } else {
      const jitter = 1 + (Math.random() * 2 - 1) * JITTER;
      waitMs = this.currentBackoff * jitter;
    }

    const proposedUntil = now + waitMs;
    // Parallel 429s: only extend the gate, never shorten — otherwise the
    // shortest backoff wins and undermines the larger ones.
    if (proposedUntil > this.gateUntil) {
      this.gateUntil = proposedUntil;
    }
    this.lastTripAt = now;

    return Math.max(0, this.gateUntil - now);
  }

  get remainingMs(): number {
    return Math.max(0, this.gateUntil - Date.now());
  }

  /** Test-only escape hatch. */
  reset(): void {
    this.gateUntil = 0;
    this.currentBackoff = 0;
    this.lastTripAt = 0;
  }
}

export const globalRateLimitGate = new RateLimitGate();

/**
 * Parse a Retry-After header. Returns milliseconds, or null when the value
 * is missing / unparseable.
 *
 * RFC 7231 allows two formats:
 * - delta-seconds: "120"
 * - HTTP-date: "Wed, 21 Oct 2015 07:28:00 GMT"
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Pure-number → seconds. Use parseFloat so we tolerate "5.0" etc., but
  // reject anything with leftover non-numeric chars (e.g. "5min").
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(parseFloat(trimmed) * 1000);
  }

  const date = Date.parse(trimmed);
  if (!isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

/**
 * Detect 429 / rate-limit errors from heterogeneous sources:
 * - Fetch errors with `status` attached (OpenAI path)
 * - SDK errors with `status` or `code` (Gemini SDK)
 * - Bare string messages containing "429", "RESOURCE_EXHAUSTED", etc.
 */
export function isRateLimitError(err: any): boolean {
  if (!err) return false;
  const status = err.status ?? err.code ?? err?.error?.status;
  if (status === 429 || status === '429') return true;
  if (typeof status === 'string' && /RESOURCE_EXHAUSTED/i.test(status)) return true;
  const msg = err.message ?? String(err);
  return /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(msg);
}
