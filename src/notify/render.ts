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
  seats: Seat[];
  seatMap: SeatMap;
  mode: 'single' | 'adjacent';
  action: 'notify' | 'hold';
}

export function renderAlert(a: AlertBody): string {
  const labels = a.seats.map((s) => `${s.row}${s.col}`).join(', ');
  const kind = a.mode === 'single' ? '단석' : `${a.seats.length}연석`;
  const free = a.seatMap.seats.filter((s) => s.state === 'free').length;

  const head = [
    `🎟 <b>빈 좌석 발견</b>`,
    ``,
    `<b>${esc(a.showtime.movieName)}</b>`,
    `${esc(a.showtime.theaterName)} · ${esc(a.showtime.screenName)}`,
    `${formatDate(a.showtime.playDate)} ${a.showtime.startTime}`,
    ``,
    `좌석 <b>${esc(labels)}</b> · ${kind}`,
    `이 회차 잔여 ${free}석`,
    ``,
  ];

  const map = `<pre>${esc(renderSeatMapText(a.seatMap, { highlight: a.seats }))}</pre>`;
  const tail =
    a.action === 'hold'
      ? `\n<i>좌석 확보를 시도합니다. 결제는 직접 하셔야 합니다.</i>`
      : `\n<i>알림 전용 모드입니다.</i>`;

  return head.join('\n') + map + tail;
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
