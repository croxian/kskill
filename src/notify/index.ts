import type { Alert } from '../watch/loop.js';
import { fingerprint } from '../core/diff.js';
import { buildDeepLink } from './deeplink.js';
import { renderAlert, renderExpired, renderHeld, type AlertBody } from './render.js';
import { TelegramClient, type InlineButton, type SendResult } from './telegram.js';

export { TelegramClient, esc } from './telegram.js';
export * from './render.js';
export * from './deeplink.js';

export interface NotifierConfig {
  token: string;
  chatId: string | number;
  /** 회차 딥링크 템플릿. 없으면 예매 첫 화면으로 보낸다. */
  deepLinkTemplate?: string;
  fetchImpl?: typeof fetch;
  /** 발송 실패를 밖으로 알린다. 실패해도 감시는 계속 돈다. */
  onSendError?(err: string, alert: Alert): void;
}

/**
 * 감시 루프의 notify 콜백을 만든다.
 *
 * 루프는 텔레그램을 모르고, 이 모듈은 롯데를 모른다.
 * 알림 실패는 절대 감시를 중단시키지 않는다 — 봇 토큰이 만료돼도
 * 폴링은 계속 돌아야 다음 취소표를 놓치지 않는다.
 */
export function createTelegramNotifier(cfg: NotifierConfig) {
  const client = new TelegramClient({
    token: cfg.token,
    chatId: cfg.chatId,
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  });

  /** 알림 지문 → 메시지 ID. 홀드 진행 상황을 같은 메시지에 덮어쓴다. */
  const messageIds = new Map<string, number>();

  async function notify(alert: Alert): Promise<void> {
    const body = toBody(alert);
    const res = await client.sendMessage(
      renderAlert(body),
      buttons(alert, cfg.deepLinkTemplate),
    );

    if (!res.ok) {
      cfg.onSendError?.(res.error ?? 'unknown', alert);
      return;
    }
    if (res.messageId !== undefined) {
      messageIds.set(alertKey(alert), res.messageId);
    }
  }

  /** 좌석을 확보한 뒤 남은 시간을 갱신한다. 새 메시지를 보내면 도배가 된다. */
  async function updateHold(alert: Alert, secondsLeft: number): Promise<SendResult> {
    const id = messageIds.get(alertKey(alert));
    const text = renderHeld(toBody(alert), secondsLeft);
    return id === undefined ? client.sendMessage(text) : client.editMessage(id, text);
  }

  async function holdExpired(alert: Alert): Promise<SendResult> {
    const key = alertKey(alert);
    const id = messageIds.get(key);
    const text = renderExpired(toBody(alert));
    messageIds.delete(key);
    return id === undefined ? client.sendMessage(text) : client.editMessage(id, text);
  }

  /** 알림이 아닌 운영 경고. 로그인 만료처럼 사람이 손대야 하는 것들. */
  async function warn(text: string): Promise<SendResult> {
    return client.sendMessage(text);
  }

  return { notify, updateHold, holdExpired, warn, client };
}

/** 좌석맵이 없으면 좌석 대신 회차로 메시지를 추적한다. */
function alertKey(alert: Alert): string {
  return alert.candidate
    ? fingerprint(alert.candidate.seats, alert.showtime)
    : `${alert.showtime.playDate}:${alert.showtime.screenId}:${alert.showtime.playSequence}`;
}

function toBody(alert: Alert): AlertBody {
  const unfiltered = alert.candidate ? undefined : unappliedConditions(alert);
  return {
    showtime: alert.showtime,
    seats: alert.candidate?.seats ?? [],
    seatMap: alert.seatMap,
    mode: alert.spec.party.mode,
    action: alert.spec.action,
    ...(unfiltered ? { unfiltered } : {}),
    ...(alert.increase !== undefined ? { increase: alert.increase } : {}),
  };
}

/**
 * 후보 좌석 없이 나가는 알림에서, 설정에 있었지만 걸리지 않은 조건.
 *
 * 설정에 아무 조건도 없었다면 알릴 것도 없다 — 잔여수 알림이 곧 원한 것이다.
 */
function unappliedConditions(alert: Alert): AlertBody['unfiltered'] {
  const block = alert.spec.block !== null;
  const party = alert.spec.party.mode === 'adjacent' && alert.spec.party.size > 1;
  if (block && party) return 'both';
  if (block) return 'block';
  if (party) return 'party';
  return undefined;
}

function buttons(alert: Alert, template?: string): InlineButton[][] {
  // 딥링크 템플릿은 롯데용이다. CGV 에 갖다 쓰면 엉뚱한 주소가 된다.
  const url = buildDeepLink(alert.showtime, alert.showtime.chain === 'lotte' ? template : undefined);
  const label = alert.showtime.chain === 'cgv' ? '🎬 CGV 예매 열기' : '🎬 롯데시네마 예매 열기';
  const rows: InlineButton[][] = [[{ text: label, url }]];

  if (alert.spec.action === 'hold' && alert.candidate) {
    const fp = fingerprint(alert.candidate.seats, alert.showtime);
    rows.push([
      { text: '✅ 지금 확보', callback_data: `hold:${fp}`.slice(0, 64) },
      { text: '✖️ 건너뛰기', callback_data: `skip:${fp}`.slice(0, 64) },
    ]);
  }
  return rows;
}
