// Tiny fixed-window rate limiter. The hosted demo runs on free tiers (Gemini quota,
// PayPal sandbox, 512 MB of RAM), so public endpoints that cost something are capped.

const windows = new Map<string, { count: number; resetAt: number }>();

export function allow(bucket: string, key: string, max: number, windowMs: number): boolean {
  const id = `${bucket}:${key}`;
  const now = Date.now();
  const w = windows.get(id);
  if (!w || now >= w.resetAt) {
    if (windows.size > 20_000) for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
    windows.set(id, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (w.count >= max) return false;
  w.count++;
  return true;
}

export function resetRateLimits() {
  windows.clear();
}
