export interface NotificationPayload {
  title: string;
  company: string;
  score: number;
  reason: string;
  deepLink: string; // dashboard apply view, not the raw site
}

export interface Notifier {
  notify(p: NotificationPayload): Promise<void>;
}

export class ConsoleNotifier implements Notifier {
  async notify(p: NotificationPayload): Promise<void> {
    console.log(
      `[notify] ${(p.score * 100).toFixed(0)}%  ${p.title} @ ${p.company} — ${p.reason}\n         ${p.deepLink}`
    );
  }
}
