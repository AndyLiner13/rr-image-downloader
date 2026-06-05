/**
 * Shared helpers that tie the download concurrency limit to the configured
 * request delay. The request delay (ms between request *starts*) and the
 * concurrency limit (how many downloads may be in flight at once) are kept as
 * separate settings, but the concurrency limit is given a *dynamic* upper bound
 * derived from the delay so the two can never be configured into a nonsensical
 * combination (e.g. 30 concurrent downloads behind a 1000ms serial delay).
 *
 * The bound is the inverse of the delay: a smaller delay dispatches requests
 * faster, so more of them can usefully be in flight at once. The result is
 * always clamped to the absolute [MIN, MAX] range.
 */

export const ABSOLUTE_MIN_CONCURRENCY = 1;
export const ABSOLUTE_MAX_CONCURRENCY = 30;

/**
 * Compute the maximum allowed concurrency for a given request delay.
 *
 * Formula: clamp(round(1000 / max(delayMs, 1)), 1, 30).
 *  - delay 0ms   -> 30 (effectively unlimited dispatch -> allow the cap)
 *  - delay 100ms -> 10
 *  - delay 200ms -> 5
 *  - delay 1000ms -> 1
 */
export function computeMaxConcurrencyForDelay(delayMs: number): number {
  const safeDelay = Number.isFinite(delayMs)
    ? Math.max(0, Math.floor(delayMs))
    : 0;
  const raw = Math.round(1000 / Math.max(safeDelay, 1));
  return Math.min(
    ABSOLUTE_MAX_CONCURRENCY,
    Math.max(ABSOLUTE_MIN_CONCURRENCY, raw)
  );
}

/**
 * Clamp a requested concurrency value to the dynamic range allowed by the
 * supplied request delay.
 */
export function clampConcurrencyForDelay(
  requested: number,
  delayMs: number
): number {
  const max = computeMaxConcurrencyForDelay(delayMs);
  const safeRequested = Number.isFinite(requested)
    ? Math.floor(requested)
    : ABSOLUTE_MIN_CONCURRENCY;
  return Math.min(max, Math.max(ABSOLUTE_MIN_CONCURRENCY, safeRequested));
}
