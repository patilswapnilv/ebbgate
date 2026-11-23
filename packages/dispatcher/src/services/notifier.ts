import type { EbbgateConfig } from "@ebbgate/core";
import type { Logger } from "../logger.js";

export type NotifyEvent =
  | "node_offline"
  | "node_online"
  | "task_deferred"
  | "queue_drained"
  | "run_interrupted"
  | "deferred_expired"
  | "deferred_dead";

export interface Notifier {
  notify(event: NotifyEvent, node: string | null, message: string): Promise<void>;
}

const COALESCE_MS = 60_000;

/**
 * Telegram + generic webhook notifier. Coalesces bursts: at most one message
 * per event type per node per 60 seconds.
 */
export function createNotifier(
  config: Pick<EbbgateConfig, "notify">,
  logger: Logger,
  fetchFn: typeof fetch = fetch,
): Notifier {
  const lastSent = new Map<string, number>();

  return {
    async notify(event, node, message): Promise<void> {
      const key = `${event}:${node ?? "-"}`;
      const now = Date.now();
      const prev = lastSent.get(key) ?? 0;
      if (now - prev < COALESCE_MS) {
        logger.debug({ event, node }, "notifier coalesced");
        return;
      }
      lastSent.set(key, now);

      const text = `[ebbgate] ${event}${node ? ` node=${node}` : ""}: ${message}`;
      const notify = config.notify;
      if (!notify) return;

      const tasks: Promise<void>[] = [];

      if (notify.telegram) {
        const { botToken, chatId } = notify.telegram;
        tasks.push(
          fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text }),
          })
            .then((res) => {
              if (!res.ok) logger.warn({ status: res.status }, "telegram notify failed");
            })
            .catch((err: unknown) => {
              logger.warn({ err: String(err) }, "telegram notify error");
            }),
        );
      }

      if (notify.webhook) {
        tasks.push(
          fetchFn(notify.webhook.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event, node, message: text }),
          })
            .then((res) => {
              if (!res.ok) logger.warn({ status: res.status }, "webhook notify failed");
            })
            .catch((err: unknown) => {
              logger.warn({ err: String(err) }, "webhook notify error");
            }),
        );
      }

      await Promise.all(tasks);
    },
  };
}
