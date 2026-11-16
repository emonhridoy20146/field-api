import { ctx } from '../../core/context/index.js';

export interface PushMessage {
  type: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * Port to the push provider (FCM in production). No provider credentials live in this repo; the
 * default sender only logs, and tests install a recording sender.
 */
export interface PushSender {
  /** Returns the tokens the provider reported as permanently invalid. */
  send(tokens: string[], message: PushMessage): Promise<{ invalidTokens: string[] }>;
}

/** Logs type and token count only — never tokens or message text (may contain customer names). */
export class LogPushSender implements PushSender {
  async send(tokens: string[], message: PushMessage) {
    ctx().logger.info({ type: message.type, tokens: tokens.length }, 'push (log sender)');
    return { invalidTokens: [] };
  }
}

export class MemoryPushSender implements PushSender {
  sent: { tokens: string[]; message: PushMessage }[] = [];
  invalid = new Set<string>();
  async send(tokens: string[], message: PushMessage) {
    this.sent.push({ tokens, message });
    return { invalidTokens: tokens.filter((t) => this.invalid.has(t)) };
  }
}

let sender: PushSender = new LogPushSender();
export const pushSender = () => sender;
export const setPushSender = (s: PushSender) => {
  sender = s;
};
