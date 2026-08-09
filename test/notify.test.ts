import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { LotteResponse } from '../src/adapters/lotte/client.js';
import { parseSeatMap } from '../src/adapters/lotte/parse.js';
import { findCandidates } from '../src/core/runs.js';
import type { WatchSpec } from '../src/core/spec.js';
import {
  buildDeepLink,
  createTelegramNotifier,
  esc,
  formatDate,
  LOTTE_TICKETING_URL,
  renderAlert,
  renderHeld,
  renderSeatMapText,
  TelegramClient,
  unresolvedVars,
} from '../src/notify/index.js';
import type { Showtime } from '../src/types.js';
import type { Alert } from '../src/watch/loop.js';

const raw = JSON.parse(
  readFileSync(new URL('./fixtures/lotte-worldtower-9gwan-seq4.json', import.meta.url), 'utf8'),
) as LotteResponse;

const MAP = parseSeatMap(raw, {
  theaterId: '1016',
  screenId: '101609',
  playDate: '20260809',
  playSequence: '4',
});

const SHOWTIME: Showtime = {
  chain: 'lotte',
  theaterId: '1016',
  theaterName: '월드타워',
  movieId: '24128',
  movieName: '오디세이',
  screenId: '101609',
  screenName: '9관',
  playDate: '20260809',
  playSequence: '4',
  startTime: '19:10',
  divisionCode: '*',
  totalSeats: 360,
  remainingSeats: 6,
};

const SPEC: WatchSpec = {
  id: 'w1',
  theaters: [{ chain: 'lotte', theaterId: '1016' }],
  movies: [],
  dates: ['20260809'],
  windows: [],
  block: null,
  party: { mode: 'adjacent', size: 2 },
  action: 'notify',
  pollFloorSec: 30,
  expiresAt: '2026-08-10T00:00:00Z',
};

const CANDIDATE = findCandidates(MAP, null, { mode: 'adjacent', size: 2 })[0]!;

const alert = (over: Partial<Alert> = {}): Alert => ({
  spec: SPEC,
  showtime: SHOWTIME,
  candidate: CANDIDATE,
  seatMap: MAP,
  ...over,
});

/** ok:true 를 돌려주는 가짜 Bot API */
function fakeApi(overrides: { ok?: boolean; description?: string; messageId?: number } = {}) {
  const calls: Array<{ method: string; body: any }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    return {
      ok: true,
      json: async () => ({
        ok: overrides.ok ?? true,
        description: overrides.description,
        result: { message_id: overrides.messageId ?? 555 },
      }),
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe('esc', () => {
  it('HTML parse_mode 가 해석하는 글자만 막는다', () => {
    expect(esc('<b>A & B</b>')).toBe('&lt;b&gt;A &amp; B&lt;/b&gt;');
  });

  it('영화 제목의 꺾쇠가 마크업으로 새지 않는다', () => {
    expect(esc('F1 <더 무비>')).toBe('F1 &lt;더 무비&gt;');
  });
});

describe('formatDate', () => {
  it('요일을 붙인다', () => {
    expect(formatDate('20260809')).toBe('8월 9일(일)');
    expect(formatDate('20260810')).toBe('8월 10일(월)');
  });
});

describe('renderSeatMapText', () => {
  const text = renderSeatMapText(MAP, { highlight: CANDIDATE.seats });
  const lines = text.split('\n');

  it('스크린 방향을 맨 위에 표시한다', () => {
    expect(lines[0]).toContain('SCREEN');
  });

  it('행마다 한 줄씩, 행 이름을 앞에 붙인다', () => {
    const rows = lines.slice(2);
    expect(rows).toHaveLength(15); // A~O
    expect(rows[0]!.startsWith('A ')).toBe(true);
    expect(rows[14]!.startsWith('O ')).toBe(true);
  });

  it('후보 좌석만 O 로 강조한다', () => {
    const j = lines.slice(2).find((l) => l.startsWith('J '))!;
    expect([...j].filter((c) => c === 'O')).toHaveLength(2);
    const h = lines.slice(2).find((l) => l.startsWith('H '))!;
    expect(h).not.toContain('O'); // H04/H05 는 통로 건너라 후보가 아니다
  });

  it('빈자리는 점으로, 통로에는 빈 칸을 넣는다', () => {
    const h = lines.slice(2).find((l) => l.startsWith('H '))!;
    expect(h).toContain('.'); // H04 / H05 는 비어 있다
    // 구획이 4개이므로 통로 공백이 3개 들어간다
    expect(h.slice(2).split(' ').filter((s) => s.length).length).toBe(4);
  });

  it('모바일에서 읽히도록 폭을 좁게 유지한다', () => {
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(40);
  });
});

describe('renderAlert', () => {
  const text = renderAlert({
    showtime: SHOWTIME,
    seats: CANDIDATE.seats,
    seatMap: MAP,
    mode: 'adjacent',
    action: 'hold',
  });

  it('알림 하나로 판단할 수 있게 필요한 정보를 다 담는다', () => {
    expect(text).toContain('오디세이');
    expect(text).toContain('월드타워');
    expect(text).toContain('9관');
    expect(text).toContain('8월 9일(일) 19:10');
    expect(text).toContain('J10, J11');
    expect(text).toContain('2연석');
    expect(text).toContain('잔여 6석');
  });

  it('좌석 배치도를 고정폭 블록으로 넣는다', () => {
    expect(text).toContain('<pre>');
    expect(text).toContain('SCREEN');
  });

  it('동작 모드를 알려준다', () => {
    expect(text).toContain('좌석 확보를 시도합니다');
  });
});

describe('renderHeld', () => {
  const body = {
    showtime: SHOWTIME,
    seats: CANDIDATE.seats,
    seatMap: MAP,
    mode: 'adjacent' as const,
    action: 'hold' as const,
  };

  it('남은 시간을 분:초로 보여준다', () => {
    expect(renderHeld(body, 462)).toContain('결제까지 7:42');
    expect(renderHeld(body, 65)).toContain('결제까지 1:05');
  });

  it('1분 안쪽이면 색을 바꾼다', () => {
    expect(renderHeld(body, 120)).toContain('🟢');
    expect(renderHeld(body, 45)).toContain('🔴');
  });
});

describe('buildDeepLink', () => {
  it('템플릿이 없으면 예매 첫 화면으로 보낸다', () => {
    // 잘못된 링크를 보내느니 첫 화면이 낫다
    expect(buildDeepLink(SHOWTIME)).toBe(LOTTE_TICKETING_URL);
  });

  it('회차 값을 템플릿에 채운다', () => {
    const t = 'https://x/seat?c={theaterId}&s={screenId}&d={playDateDash}&q={playSequence}';
    expect(buildDeepLink(SHOWTIME, t)).toBe(
      'https://x/seat?c=1016&s=101609&d=2026-08-09&q=4',
    );
  });

  it('모르는 자리표시자는 손대지 않고 잡아낸다', () => {
    expect(buildDeepLink(SHOWTIME, 'https://x/{nope}')).toBe('https://x/{nope}');
    expect(unresolvedVars('https://x/{nope}/{screenId}')).toEqual(['nope']);
    expect(unresolvedVars('https://x/{screenId}')).toEqual([]);
  });
});

describe('TelegramClient', () => {
  it('HTML parse_mode 로 보낸다', async () => {
    const api = fakeApi();
    const c = new TelegramClient({ token: 'T', chatId: 42, fetchImpl: api.impl });

    const res = await c.sendMessage('hi');

    expect(res).toEqual({ ok: true, messageId: 555 });
    expect(api.calls[0]!.method).toBe('sendMessage');
    expect(api.calls[0]!.body).toMatchObject({ chat_id: 42, parse_mode: 'HTML' });
  });

  it('실패를 던지지 않고 돌려준다', async () => {
    const api = fakeApi({ ok: false, description: 'chat not found' });
    const c = new TelegramClient({ token: 'T', chatId: 42, fetchImpl: api.impl });

    expect(await c.sendMessage('hi')).toEqual({ ok: false, error: 'chat not found' });
  });

  it('네트워크가 끊겨도 던지지 않는다', async () => {
    const boom = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const c = new TelegramClient({ token: 'T', chatId: 42, fetchImpl: boom });

    expect(await c.sendMessage('hi')).toEqual({ ok: false, error: 'ECONNRESET' });
  });

  it('메시지를 고쳐 쓴다', async () => {
    const api = fakeApi();
    const c = new TelegramClient({ token: 'T', chatId: 42, fetchImpl: api.impl });

    await c.editMessage(555, 'updated');

    expect(api.calls[0]!.method).toBe('editMessageText');
    expect(api.calls[0]!.body).toMatchObject({ message_id: 555 });
  });
});

describe('createTelegramNotifier', () => {
  it('딥링크 버튼을 붙인다', async () => {
    const api = fakeApi();
    const n = createTelegramNotifier({ token: 'T', chatId: 1, fetchImpl: api.impl });

    await n.notify(alert());

    const kb = api.calls[0]!.body.reply_markup.inline_keyboard;
    expect(kb[0][0].url).toBe(LOTTE_TICKETING_URL);
  });

  it('hold 모드에서만 승인 버튼을 붙인다', async () => {
    const api = fakeApi();
    const n = createTelegramNotifier({ token: 'T', chatId: 1, fetchImpl: api.impl });

    await n.notify(alert());
    await n.notify(alert({ spec: { ...SPEC, action: 'hold' } }));

    expect(api.calls[0]!.body.reply_markup.inline_keyboard).toHaveLength(1);
    expect(api.calls[1]!.body.reply_markup.inline_keyboard).toHaveLength(2);
  });

  it('callback_data 를 텔레그램 상한(64바이트) 안으로 자른다', async () => {
    const api = fakeApi();
    const n = createTelegramNotifier({ token: 'T', chatId: 1, fetchImpl: api.impl });

    await n.notify(alert({ spec: { ...SPEC, action: 'hold' } }));

    const row = api.calls[0]!.body.reply_markup.inline_keyboard[1];
    for (const b of row) expect(b.callback_data.length).toBeLessThanOrEqual(64);
  });

  /** 새 메시지를 계속 보내면 도배가 된다. 하나를 갱신한다. */
  it('홀드 남은 시간은 첫 알림 메시지를 고쳐 쓴다', async () => {
    const api = fakeApi({ messageId: 777 });
    const n = createTelegramNotifier({ token: 'T', chatId: 1, fetchImpl: api.impl });

    const a = alert({ spec: { ...SPEC, action: 'hold' } });
    await n.notify(a);
    await n.updateHold(a, 300);
    await n.updateHold(a, 240);

    expect(api.calls.map((c) => c.method)).toEqual([
      'sendMessage',
      'editMessageText',
      'editMessageText',
    ]);
    expect(api.calls[1]!.body.message_id).toBe(777);
  });

  it('만료를 알린 뒤에는 메시지 추적을 놓는다', async () => {
    const api = fakeApi({ messageId: 777 });
    const n = createTelegramNotifier({ token: 'T', chatId: 1, fetchImpl: api.impl });

    const a = alert({ spec: { ...SPEC, action: 'hold' } });
    await n.notify(a);
    await n.holdExpired(a);
    await n.updateHold(a, 100); // 추적이 끊겼으니 새 메시지

    expect(api.calls.map((c) => c.method)).toEqual([
      'sendMessage',
      'editMessageText',
      'sendMessage',
    ]);
  });

  /** 봇 토큰이 만료돼도 폴링은 계속 돌아야 다음 취소표를 놓치지 않는다. */
  it('발송 실패가 감시를 죽이지 않는다', async () => {
    const api = fakeApi({ ok: false, description: 'bot was blocked' });
    const errors: string[] = [];
    const n = createTelegramNotifier({
      token: 'T',
      chatId: 1,
      fetchImpl: api.impl,
      onSendError: (e) => errors.push(e),
    });

    await expect(n.notify(alert())).resolves.toBeUndefined();
    expect(errors).toEqual(['bot was blocked']);
  });
});
