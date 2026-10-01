import { config } from "../config.js";
import { ConsoleNotifier, type Notifier, type NotificationPayload } from "./Notifier.js";

export class SlackNotifier implements Notifier {
  constructor(private readonly webhookUrl: string) {}

  async notify(p: NotificationPayload): Promise<void> {
    const text =
      `:rocket: *Fresh match (${(p.score * 100).toFixed(0)}%)*: ` +
      `<${p.deepLink}|${p.title}> @ ${p.company}\n> ${p.reason}`;
    await sendSlackMessage(text, this.webhookUrl);
  }
}

/** Send arbitrary Slack text (morning digest, etc.). Returns true if sent. */
export async function sendSlackMessage(
  text: string,
  webhookUrl = config.notify.slackWebhookUrl
): Promise<boolean> {
  if (!webhookUrl) {
    console.log(`[slack:digest]\n${text}`);
    return false;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.warn(`[slack] webhook HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.warn("[slack] send failed:", (err as Error).message);
    return false;
  }
}

let _notifier: Notifier | null = null;
export function getNotifier(): Notifier {
  if (_notifier) return _notifier;
  _notifier = config.notify.slackWebhookUrl
    ? new SlackNotifier(config.notify.slackWebhookUrl)
    : new ConsoleNotifier();
  return _notifier;
}

export function setNotifier(n: Notifier): void {
  _notifier = n;
}

export type { NotificationPayload };
