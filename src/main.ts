import { readFileSync } from 'node:fs';

import { createLotteAdapter } from './adapters/lotte/adapter.js';
import { crossCheck } from './adapters/lotte/parse.js';
import { STOP } from './core/poll.js';
import { normalizeSpec, type WatchSpec } from './core/spec.js';
import { LotteSeatHolder } from './hold/lotte.js';
import { LOTTE_FLOW, selectorsAreStubs } from './hold/selectors.js';
import { credentialsFromEnv } from './hold/login.js';
import { HoldManager } from './hold/session.js';
import { createTelegramNotifier } from './notify/index.js';
import type { Alert } from './watch/loop.js';
import { Watcher } from './watch/loop.js';

/**
 * 감시기 실행.
 *
 *   npm run watch -- watch.json
 *
 * 환경변수 (.env.example 참고):
 *   TG_TOKEN          텔레그램 봇 토큰
 *   TG_CHAT_ID        받을 채팅 ID
 *   LOTTE_ID          롯데시네마 아이디 (선택 — 세션 만료 시 자동 재로그인)
 *   LOTTE_PW          롯데시네마 비밀번호 (선택)
 *   SESSION_CHECK_MIN 세션 점검 주기(분). 기본 30
 *   HOLD_SECONDS      스스로 정한 홀드 상한(초). 기본 300
 */
async function main() {
  const specPath = process.argv[2] ?? 'watch.json';
  const spec = normalizeSpec(JSON.parse(readFileSync(specPath, 'utf8')) as WatchSpec);

  const token = need('TG_TOKEN');
  const chatId = need('TG_CHAT_ID');

  // 셀렉터가 아직 실측 전이면 hold 모드는 조용히 실패한다. 시작 전에 막는다.
  if (spec.action === 'hold' && selectorsAreStubs(LOTTE_FLOW)) {
    console.error('좌석 확보 셀렉터가 아직 실측되지 않았습니다.');
    console.error('  npm run record  로 예매 흐름을 녹화해 src/hold/selectors.ts 를 채우세요.');
    console.error('  그 전까지는 watch.json 의 action 을 "notify" 로 두세요.');
    process.exit(1);
  }

  const lotte = createLotteAdapter(spec.theaters);
  const tg = createTelegramNotifier({
    token,
    chatId,
    ...(process.env.LOTTE_DEEPLINK ? { deepLinkTemplate: process.env.LOTTE_DEEPLINK } : {}),
    onSendError: (err) => log(`알림 발송 실패: ${err}`),
  });

  const watcher = new Watcher(spec, {
    listShowtimes: lotte.listShowtimes,
    fetchSeatMap: lotte.fetchSeatMap,
    notify: tg.notify,
    now: () => Date.now(),
    onError: (stage, err, ctx) => log(`${stage} 실패 [${ctx}] ${msg(err)}`),
  });

  // 동시 홀드는 1건뿐이므로 진행 중인 알림 하나만 들고 있으면 된다.
  let held: Alert | null = null;

  const creds = credentialsFromEnv();
  const holder = new LotteSeatHolder({
    ...(creds ? { credentials: creds } : {}),
    onLogin: (outcome) => {
      // 로그인이 실제로 일어난 것은 조용히 넘길 사건이 아니다.
      if (outcome === 'recovered') log('세션이 만료되어 자동으로 다시 로그인했습니다');
    },
  });

  const holdManager =
    spec.action === 'hold'
      ? new HoldManager(
          {
            // 롯데에는 회차 딥링크가 없어 예매 첫 화면부터 UI 를 밟는다.
            holder,
            now: () => Date.now(),
            sleep,
            onCountdown: async (_r, left) => {
              if (held) await tg.updateHold(held, left);
              if (left % 60 === 0 || left <= 30) log(`  결제까지 ${left}초`);
            },
            onReleased: async (_r, reason) => {
              log(`  홀드 종료 (${reason}) — 좌석을 놓았습니다`);
              if (held && reason !== 'cancelled') await tg.holdExpired(held);
            },
            onError: (_r, err) => log(`  좌석 확보 실패: ${msg(err)}`),
          },
          { holdSeconds: Number(process.env.HOLD_SECONDS ?? 300) },
        )
      : null;

  log(`감시 시작 · 지점 ${spec.theaters.length} · 날짜 ${spec.dates.join(', ')}`);
  log(`조건 ${spec.party.mode === 'single' ? '단석' : `${spec.party.size}연석`} · 동작 ${spec.action}`);
  log(`만료 ${spec.expiresAt}`);
  if (holdManager) log(creds ? '자동 로그인 사용 가능' : '자동 로그인 없음 — 세션이 풀리면 알립니다');

  /**
   * 세션 점검.
   *
   * 알림이 뜬 순간에 세션이 죽어 있으면 로그인하는 몇 초 사이에 자리가 날아간다.
   * 그래서 미리, 주기적으로 본다. 자격증명이 없으면 알리기만 한다 —
   * 잠든 사이 세션이 풀려 그날 감시가 통째로 무용지물이 되는 걸 막는다.
   */
  const sessionEveryMs = Number(process.env.SESSION_CHECK_MIN ?? 30) * 60_000;
  let sessionCheckedAt = 0;

  async function ensureSession(): Promise<void> {
    if (!holdManager) return;
    if (Date.now() - sessionCheckedAt < sessionEveryMs) return;
    sessionCheckedAt = Date.now();
    try {
      if ((await holder.checkSession()) === 'needs-human') {
        log('⚠ 로그인이 풀렸습니다. 좌석 확보를 할 수 없습니다.');
        await tg.warn(
          '⚠️ <b>로그인이 풀렸습니다</b>\n\n좌석 확보를 할 수 없습니다.\n' +
            'PC 에서 <code>npm run login</code> 으로 다시 로그인하거나,\n' +
            '.env 에 <code>LOTTE_ID</code> / <code>LOTTE_PW</code> 를 넣어 두세요.',
        );
      }
    } catch (err) {
      log(`세션 점검 실패: ${msg(err)}`);
    }
  }

  for (;;) {
    await ensureSession();
    const res = await watcher.runOnce();

    if (res.offline) {
      log(`조회가 전부 실패했습니다. ${Math.round(res.nextWakeMs / 1000)}초 뒤 재시도합니다.`);
    } else {
      const parts = [`회차 ${res.polled}`, `변화 ${res.targets}`, `알림 ${res.alerts.length}`];
      if (res.suppressed) parts.push(`보류 ${res.suppressed}`);
      log(res.alerts.length ? `${parts.join(' · ')}  ← 발송` : parts.join(' · '));
    }

    for (const a of res.alerts) {
      const seats = a.candidate.seats.map((s) => `${s.row}${s.col}`).join(', ');
      log(`  ${a.showtime.movieName} ${a.showtime.startTime} ${a.showtime.screenName} → ${seats}`);

      // 두 엔드포인트가 서로 다른 계산으로 같은 사실을 말한다.
      // 어긋나면 계약이 바뀐 것이니 조용히 넘기지 않는다.
      const check = crossCheck(a.seatMap, [a.showtime]);
      if (!check.ok) {
        log(`  ⚠ 잔여석 불일치 — 좌석맵 ${check.fromSeatMap} vs 카운트 ${check.fromCounts}`);
      }

      // 확보하는 동안은 감시를 멈춘다. 동시에 여러 자리를 잡아두지 않는다.
      if (holdManager) {
        held = a;
        log('  좌석 확보 시도 — 결제 화면 직전에서 멈춥니다');
        await holdManager.run({ showtime: a.showtime, seats: a.candidate.seats });
        held = null;
      }
    }

    if (res.nextWakeMs === STOP) {
      log('감시 종료 — 남은 회차가 없거나 만료되었습니다.');
      return;
    }
    await sleep(res.nextWakeMs);
  }
}

function need(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`환경변수 ${key} 가 필요합니다. .env.example 을 참고하세요.`);
    process.exit(1);
  }
  return v;
}

function log(s: string): void {
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Seoul' });
  console.log(`[${t}] ${s}`);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(msg(e));
  process.exit(1);
});
