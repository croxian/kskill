import type { Seat, SeatMap, Showtime } from '../types.js';
import { esc } from './telegram.js';

/**
 * 알림 본문 조립.
 *
 * "H11, H12"라는 글자보다 배치도 위의 점 두 개가 훨씬 빨리 읽힌다.
 * 원래 SVG 이미지를 붙일 생각이었는데 텔레그램은 사진으로 SVG 를 받지 않고
 * (JPEG/PNG/GIF 만), 래스터라이저를 끌어오면 의존성이 무거워진다.
 * 고정폭 코드 블록으로 그리면 의존성 0 에 모바일에서도 인라인으로 뜬다.
 */

const CH = {
  free: '.',
  sold: '#',
  /** 남이 붙잡고 있는 중. 곧 풀릴 수 있어 sold 와 구분해 보여준다. */
  held: 'x',
  blocked: ' ',
  target: 'O',
} as const;

export interface MapRenderOpts {
  /** 강조할 좌석 (후보) */
  highlight?: Seat[];
  /** 행이 이보다 길면 후보 주변만 잘라 보여준다. 모바일 가독성. */
  maxWidth?: number;
}

/**
 * 좌석 배치도를 고정폭 텍스트로 그린다.
 *
 *          SCREEN
 *    A  ##  ####  ############  ####
 *    H  #O  O###  ############  ####
 *
 * 통로에는 빈 칸을 넣어 구획을 눈에 보이게 한다.
 */
export function renderSeatMapText(map: SeatMap, opts: MapRenderOpts = {}): string {
  const target = new Set((opts.highlight ?? []).map((s) => s.id));
  const rows = [...new Set(map.seats.map((s) => s.row))].sort();
  const cols = map.seats.map((s) => s.col);
  const colMin = Math.min(...cols);
  const colMax = Math.max(...cols);

  const lines: string[] = [];
  for (const row of rows) {
    const inRow = new Map(map.seats.filter((s) => s.row === row).map((s) => [s.col, s]));
    let line = '';
    let prevGroup: number | undefined;

    for (let col = colMin; col <= colMax; col++) {
      const seat = inRow.get(col);
      if (seat && prevGroup !== undefined && seat.group !== prevGroup) line += ' ';
      if (seat) prevGroup = seat.group;

      if (!seat) line += CH.blocked;
      else if (target.has(seat.id)) line += CH.target;
      else if (seat.state === 'free') line += CH.free;
      else if (seat.state === 'sold') line += CH.sold;
      else if (seat.state === 'held') line += CH.held;
      else line += CH.blocked;
    }
    lines.push(`${row.padEnd(2)}${line}`);
  }

  const width = Math.max(...lines.map((l) => l.length));
  const screen = 'SCREEN'.padStart(Math.floor((width + 6) / 2)).padEnd(width);
  return [screen, '-'.repeat(width), ...lines].join('\n');
}

/** 'YYYYMMDD' → '8월 9일(일)' */
export function formatDate(playDate: string): string {
  const y = Number(playDate.slice(0, 4));
  const m = Number(playDate.slice(4, 6));
  const d = Number(playDate.slice(6, 8));
  const dow = ['일', '월', '화', '수', '목', '금', '토'][
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  ];
  return `${m}월 ${d}일(${dow})`;
}

export interface AlertBody {
  showtime: Showtime;
  /** 좌석맵을 못 구하는 체인에서는 비어 있다. */
  seats: Seat[];
  seatMap: SeatMap | null;
  mode: 'single' | 'adjacent';
  action: 'notify' | 'hold';
  /**
   * 설정에 좌석 조건이 있었는데 이 알림에는 적용되지 않았는가.
   *
   * 좌석맵을 못 구하는 체인에서 블록을 지정하면 그 조건은 그냥 무시된다.
   * 그런데 알림 생김새는 조건을 통과한 것과 똑같아서, 받는 사람은 자기가
   * 지정한 블록에 자리가 난 줄 안다. 실제로 그렇게 오해가 났다.
   * 조건이 안 걸렸다는 사실은 알림 안에 있어야 한다 — 시작 로그가 아니라.
   */
  unfiltered?: 'block' | 'party' | 'both';
  /**
   * 이번에 몇 석이 한꺼번에 풀렸는가. 좌석맵을 못 보는 체인에서만 쓴다.
   * 2 이상이면 붙어 있을 가능성이 있지만 보장은 아니다.
   */
  increase?: number;
}

/** 무엇이 적용되지 않았는지 한 줄로. */
export function unfilteredNote(what: NonNullable<AlertBody['unfiltered']>): string {
  const label =
    what === 'both' ? '좌석 블록과 연석 조건' : what === 'block' ? '좌석 블록' : '연석 조건';
  return `⚠️ <b>${label}이 적용되지 않았습니다.</b> 이 회차에 자리가 났다는 것까지만 확인된 것이라, 지정한 자리가 났다는 뜻은 아닙니다.`;
}

/**
 * 좌석맵 없이 회차만 알린다.
 *
 * 좌석 단위 판정을 못 해도 "이 회차에 자리가 났다" 는 알려줄 수 있다.
 * 알림이 늦는 것보다 좌석을 모르는 편이 낫다 — 다만 무엇을 모르는지는 말해야 한다.
 */
export function renderCountAlert(a: AlertBody): string {
  return [
    `🎟 <b>자리가 났습니다</b>`,
    ``,
    `<b>${esc(a.showtime.movieName)}</b>`,
    `${esc(a.showtime.theaterName)} · ${esc(a.showtime.screenName)}`,
    `${formatDate(a.showtime.playDate)} ${a.showtime.startTime}`,
    ``,
    a.increase && a.increase > 1
      ? `<b>${a.increase}석</b>이 한꺼번에 풀렸습니다 · 잔여 ${a.showtime.remainingSeats} / ${a.showtime.totalSeats}`
      : `잔여 <b>${a.showtime.remainingSeats}석</b> / ${a.showtime.totalSeats}`,
    ``,
    a.increase && a.increase > 1
      ? '<i>같이 취소된 것이라 붙어 있을 수 있지만, 확인은 화면에서 하셔야 합니다.</i>'
      : a.unfiltered
        ? unfilteredNote(a.unfiltered)
        : `<i>좌석은 직접 고르셔야 합니다.</i>`,
  ].join('\n');
}

export function renderAlert(a: AlertBody): string {
  if (!a.seatMap || a.seats.length === 0) return renderCountAlert(a);
  const map = a.seatMap;
  const labels = a.seats.map((s) => `${s.row}${s.col}`).join(', ');
  const kind = a.mode === 'single' ? '단석' : `${a.seats.length}연석`;
  const free = map.seats.filter((s) => s.state === 'free').length;
  const held = map.seats.filter((s) => s.state === 'held').length;

  const head = [
    `🎟 <b>빈 좌석 발견</b>`,
    ``,
    `<b>${esc(a.showtime.movieName)}</b>`,
    `${esc(a.showtime.theaterName)} · ${esc(a.showtime.screenName)}`,
    `${formatDate(a.showtime.playDate)} ${a.showtime.startTime}`,
    ``,
    `좌석 <b>${esc(labels)}</b> · ${kind}`,
    // 지금 남이 붙잡고 있는 좌석 수는 그대로 경쟁 강도다.
    held ? `이 회차 잔여 ${free}석 · 선점 중 ${held}석` : `이 회차 잔여 ${free}석`,
    ``,
  ];

  const grid = `<pre>${esc(renderSeatMapText(map, { highlight: a.seats }))}</pre>`;
  const tail =
    a.action === 'hold'
      ? `\n<i>좌석 확보를 시도합니다. 결제는 직접 하셔야 합니다.</i>`
      : `\n<i>알림 전용 모드입니다.</i>`;

  return head.join('\n') + grid + tail;
}

/** 좌석을 확보한 뒤. 남은 시간이 줄어들 때마다 이 메시지를 고쳐 쓴다. */
export function renderHeld(a: AlertBody, secondsLeft: number): string {
  const labels = a.seats.map((s) => `${s.row}${s.col}`).join(', ');
  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const urgency = secondsLeft <= 60 ? '🔴' : '🟢';

  return [
    `✅ <b>좌석 확보됨</b>`,
    ``,
    `<b>${esc(a.showtime.movieName)}</b>`,
    `${esc(a.showtime.theaterName)} · ${esc(a.showtime.screenName)}`,
    `${formatDate(a.showtime.playDate)} ${a.showtime.startTime}`,
    `좌석 <b>${esc(labels)}</b>`,
    ``,
    `${urgency} <b>결제까지 ${mm}:${ss}</b>`,
    ``,
    `<i>열려 있는 브라우저에서 결제를 완료하세요.</i>`,
    `<i>시간이 지나면 좌석은 자동으로 해제됩니다.</i>`,
  ].join('\n');
}

export function renderExpired(a: AlertBody): string {
  const labels = a.seats.map((s) => `${s.row}${s.col}`).join(', ');
  return [
    `⌛ <b>홀드 만료 — 좌석을 해제했습니다</b>`,
    ``,
    `${esc(a.showtime.movieName)} ${a.showtime.startTime}`,
    `좌석 ${esc(labels)}`,
    ``,
    `<i>감시를 계속합니다.</i>`,
  ].join('\n');
}
