import { timingSafeEqual } from "node:crypto";

/** Compare bearer tokens in constant time. Accepts `Bearer <token>` or raw token. */
export function extractBearer(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export function bearerMatches(header: string | undefined | null, expected: string): boolean {
  const got = extractBearer(header);
  if (got === null) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
