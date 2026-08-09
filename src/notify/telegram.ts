/**
 * 텔레그램 Bot API 클라이언트.
 *
 * 전송을 주입받아 실제 발송 없이 테스트한다.
 * 알림 실패가 감시 루프를 죽이면 안 되므로, 던지는 대신 결과를 돌려준다.
 */

export interface TelegramConfig {
  token: string;
  chatId: string | number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface InlineButton {
  text: string;
  /** 외부 링크 */
  url?: string;
  /** 봇이 받을 콜백 (승인/건너뛰기 버튼) */
  callback_data?: string;
}

export interface SendResult {
  ok: boolean;
  /** 성공 시 메시지 ID. 홀드 타이머를 갱신할 때 이 메시지를 수정한다. */
  messageId?: number;
  error?: string;
}

interface ApiResponse {
  ok: boolean;
  description?: string;
  result?: { message_id?: number };
}

export class TelegramClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: TelegramConfig) {
    this.base = `https://api.telegram.org/bot${cfg.token}`;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
  }

  sendMessage(text: string, keyboard?: InlineButton[][]): Promise<SendResult> {
    return this.call('sendMessage', {
      chat_id: this.cfg.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /**
   * 이미 보낸 메시지를 고쳐 쓴다.
   * 홀드 남은 시간을 새 메시지로 계속 보내면 도배가 되므로 하나를 갱신한다.
   */
  editMessage(messageId: number, text: string, keyboard?: InlineButton[][]): Promise<SendResult> {
    return this.call('editMessageText', {
      chat_id: this.cfg.chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  private async call(method: string, body: unknown): Promise<SendResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const json = (await res.json()) as ApiResponse;
      if (!json.ok) return { ok: false, error: json.description ?? `HTTP ${res.status}` };
      return { ok: true, messageId: json.result?.message_id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** HTML parse_mode 가 해석하는 세 글자만 막으면 된다. MarkdownV2 보다 escape 가 훨씬 단순하다. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
