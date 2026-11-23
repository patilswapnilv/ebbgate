import { envKeyForNodeToken } from "./secrets.js";

export function renderEnvExample(nodes: Array<{ id: string }>): string {
  const nodeTokens = nodes
    .map((n) => `${envKeyForNodeToken(n.id)}=change-me-to-a-long-random-token`)
    .join("\n");

  return `# Copy to .env and replace placeholders. Never commit real secrets.

PAPERCLIP_API_KEY=sk_pap_change_me
EG_PAPERCLIP_SECRET=change-me-shared-secret-16chars

${nodeTokens}

# Optional notifications
# TG_BOT_TOKEN=
# TG_CHAT_ID=
# EG_NOTIFY_WEBHOOK=https://example.com/hook
`;
}
