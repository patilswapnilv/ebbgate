import { randomBytes } from "node:crypto";

/** Generate a URL-safe secret of at least 16 chars (config schema minimum). */
export function generateSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function envKeyForNodeToken(nodeId: string): string {
  return `EG_NODE_${nodeId.toUpperCase().replace(/-/g, "_")}_TOKEN`;
}
