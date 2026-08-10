import type { Page } from 'playwright';

import type { Showtime } from '../types.js';
import { cgvScreenPattern, cgvShowtimePattern, type CgvFlow } from './cgv-flow.js';
import type { Attempt } from './resolve.js';

/**
 * 단계마다 "이렇게도 눌러 본다" 목록.
 *
 * 순서가 곧 우선순위다. 앞쪽에 실측으로 확인한 것, 뒤로 갈수록 헐거운 것.
 * 헐거운 후보를 앞에 두면 엉뚱한 걸 눌러 놓고 성공했다고 믿게 된다 —
 * 예를 들어 '선택' 은 화면 어디에나 있다.
 */

/**
 * 이름으로 누르는 흔한 세 갈래. 버튼 → 링크 → 그냥 글자.
 *
 * CGV 는 같은 것을 화면마다 button 으로도, a 로도, div 로도 그린다.
 * 한 갈래만 보면 화면 하나 바뀔 때마다 흐름이 끊긴다.
 *
 * 이름은 **느슨하게 만들지 않는다.** '원  결제하기' 를 느슨하게 찾으면
 * 진짜 결제 버튼 '결제하기' 에 닿을 수 있다 — 거기서는 돈이 나간다.
 */
export function nameAttempts(name: string | RegExp, opts: { exact?: boolean } = {}): Attempt[] {
  const label = typeof name === 'string' ? name : String(name);
  return [
    {
      how: `button "${label}"`,
      find: (p) => p.getByRole('button', { name, ...(opts.exact ? { exact: true } : {}) }),
    },
    { how: `link "${label}"`, find: (p) => p.getByRole('link', { name }) },
    { how: `text "${label}"`, find: (p) => p.getByText(name) },
  ];
}

/** 공백과 괄호를 무시하고 맞춘다. '1관 (Laser)' 같은 이름이 화면마다 다르게 찍힌다. */
export function loose(s: string): RegExp {
  const core = s.replace(/[\s()]+/g, '').replace(/[.*+?^${}|[\]\\]/g, '\\$&');
  return new RegExp(core.split('').join('[\\s()]*'));
}

export function ticketingAttempts(flow: CgvFlow): Attempt[] {
  return [...nameAttempts(flow.ticketing), ...nameAttempts(/예매|예약/)];
}

export function movieAttempts(s: Showtime): Attempt[] {
  return [
    ...nameAttempts(s.movieName),
    { how: 'title 속성', find: (p) => p.locator(`[title="${cssEscape(s.movieName)}"]`) },
    { how: '느슨한 이름', find: (p) => p.getByText(loose(s.movieName)) },
  ];
}

export function theaterAttempts(s: Showtime): Attempt[] {
  return [
    ...nameAttempts(s.theaterName),
    { how: '느슨한 이름', find: (p) => p.getByText(loose(s.theaterName)) },
    // '용산아이파크몰' 이 화면에서는 '용산' 으로만 나오는 경우가 있다.
    { how: '앞 두 글자', find: (p) => p.getByRole('button', { name: new RegExp(`^${s.theaterName.slice(0, 2)}`) }) },
  ];
}

/**
 * 날짜 버튼.
 *
 * codegen 이 여기서 '내일' 을 뱉었다. 그건 그날 녹화했기 때문이지 날짜를
 * 고르는 방법이 아니다. 오늘·내일은 이름이 따로 붙고 그 밖은 숫자다.
 */
export function dateAttempts(playDate: string, now: number = Date.now()): Attempt[] {
  const day = Number(playDate.slice(6, 8));
  const month = Number(playDate.slice(4, 6));
  const rel = relativeDay(playDate, now);
  const attempts: Attempt[] = [];

  if (rel === 0) attempts.push(...nameAttempts('오늘'));
  if (rel === 1) attempts.push(...nameAttempts('내일'));

  attempts.push(
    {
      how: `data 속성 ${playDate}`,
      find: (p) => p.locator(`[data-date="${playDate}"], [data-value="${playDate}"]`),
    },
    { how: `aria "${month}월 ${day}일"`, find: (p) => p.getByLabel(new RegExp(`${month}월\\s*${day}일`)) },
    { how: `일 숫자 ${day}`, find: (p) => p.getByRole('button', { name: dayPattern(day) }) },
    { how: `글자 ${day}`, find: (p) => p.getByText(String(day), { exact: true }) },
  );
  return attempts;
}

/** '14' 는 맞고 '4' 나 '24' 는 아니다. */
export function dayPattern(day: number): RegExp {
  return new RegExp(`(^|\\D)${day}(\\D|$)`);
}

/** playDate 가 오늘로부터 며칠 뒤인가. KST 기준. */
export function relativeDay(playDate: string, now: number): number {
  const KST = 9 * 3_600_000;
  const target = Date.UTC(
    Number(playDate.slice(0, 4)),
    Number(playDate.slice(4, 6)) - 1,
    Number(playDate.slice(6, 8)),
  );
  const here = new Date(now + KST);
  const today = Date.UTC(here.getUTCFullYear(), here.getUTCMonth(), here.getUTCDate());
  return Math.round((target - today) / 86_400_000);
}

/**
 * 회차 버튼.
 *
 * 이름에 잔여석이 들어 있고 우리가 보는 사이에도 변한다. 시작 시각으로만
 * 좁히고, 같은 시각에 여러 관이 있으면 상영관으로 가른다.
 */
export function showtimeAttempts(s: Showtime): Attempt[] {
  const byTime = (p: Page) => p.getByRole('button', { name: cgvShowtimePattern(s.startTime) });
  return [
    {
      how: `${s.startTime} + ${s.screenName}`,
      find: (p) => byTime(p).filter({ hasText: cgvScreenPattern(s.screenName) }),
    },
    { how: `${s.startTime}`, find: byTime },
    { how: `글자 ${s.startTime}`, find: (p) => p.getByText(new RegExp(escapeRe(s.startTime))) },
  ];
}

/**
 * 인원 선택.
 *
 * flow.audience 가 '선택' 인데 그 글자는 화면 곳곳에 있다. 그래서 여기만
 * exact 로 죈다. 관마다 화면이 다르고 이미 1명으로 잡혀 있는 경우도 있어,
 * 호출하는 쪽에서 optional 로 쓴다 — 좌석이 눌리면 그게 답이다.
 */
export function audienceAttempts(flow: CgvFlow, size: number): Attempt[] {
  return [
    { how: `성인 ${size}`, find: (p) => p.getByRole('button', { name: new RegExp(`성인\\s*${size}`) }) },
    { how: 'data-people', find: (p) => p.locator(`[data-people="${size}"], [data-count="${size}"]`) },
    { how: `"${flow.audience}" exact`, find: (p) => p.getByRole('button', { name: flow.audience, exact: true }) },
    { how: '성인', find: (p) => p.getByRole('button', { name: /^성인/ }) },
  ];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
