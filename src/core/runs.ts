import type { Seat, SeatMap } from '../types.js';
import { blockContext, inBlock, type SeatBlock } from './block.js';

/**
 * 단석 / 연석 판정.
 *
 * 핵심 함정은 통로다. 좌석 번호가 이어져도 사이에 통로가 있으면 연석이 아니다.
 * 롯데는 SeatColumGroupNo 로 구획을 직접 알려주므로 그것을 1순위로 쓰고,
 * 그 정보가 없는 체인을 위해 x 좌표 간격 추정을 2순위로 둔다.
 */

export interface Candidate {
  seats: Seat[];
  score: number;
}

export type PartyMode = 'single' | 'adjacent';

export interface PartySpec {
  mode: PartyMode;
  size: number;
}

export function findCandidates(
  map: SeatMap,
  block: SeatBlock | null,
  party: PartySpec,
): Candidate[] {
  const ctx = blockContext(map);
  const free = map.seats.filter((s) => s.state === 'free' && inBlock(s, block, ctx));

  if (party.mode === 'single') {
    return free
      .map((s) => ({ seats: [s], score: scoreSeats([s], map) }))
      .sort(byScore);
  }
  return findAdjacent(free, map, Math.max(2, party.size)).sort(byScore);
}

const byScore = (a: Candidate, b: Candidate) => b.score - a.score;

export function findAdjacent(free: Seat[], map: SeatMap, size: number): Candidate[] {
  const out: Candidate[] = [];
  const byRow = groupBy(map.seats, (s) => s.row);

  for (const [row, rowSeats] of groupBy(free, (s) => s.row)) {
    // 임계값은 행마다 따로 잡는다. 리클라이너 행은 좌석이 커서 정상 간격이
    // 일반석의 통로 폭보다 넓다 — 전체 중앙값을 쓰면 멀쩡한 연석이 끊긴다.
    const gap = aisleThreshold(byRow.get(row) ?? []);
    const line = [...rowSeats].sort((a, b) => a.x - b.x);
    let run: Seat[] = [];

    for (const seat of line) {
      const prev = run[run.length - 1];
      run = prev && isBroken(prev, seat, gap) ? [seat] : [...run, seat];

      if (run.length >= size) {
        const win = run.slice(-size);
        out.push({ seats: win, score: scoreSeats(win, map) });
      }
    }
  }
  return out;
}

/**
 * 두 좌석 사이가 끊겼는가.
 *
 * 세 가지 중 하나라도 해당하면 연석이 아니다.
 *   1. 구획 번호가 다르다        → 사이에 통로 (체인이 알려준 확정 정보)
 *   2. 좌석 번호가 건너뛴다      → 사이에 팔린 좌석이 끼어 있다
 *   3. x 간격이 통로 폭 이상이다 → 1번 정보가 없는 체인을 위한 보루
 */
function isBroken(prev: Seat, seat: Seat, gap: number): boolean {
  if (prev.group !== seat.group) return true;
  if (seat.col - prev.col !== 1) return true;
  return seat.x - prev.x > gap;
}

/**
 * 한 행 안에서 x 간격이 중앙값의 1.6배를 넘으면 통로로 본다.
 *
 * 좌표 단위나 좌석 크기와 무관하게 동작한다.
 * 롯데 9관 일반석 실측: 정상 283, 통로 583 (2.06배) — 넉넉히 걸린다.
 * 같은 관의 리클라이너 행은 정상 간격이 470 이지만, 자기 행의 중앙값으로
 * 재므로 통로로 오인하지 않는다.
 */
export function aisleThreshold(rowSeats: Seat[]): number {
  const xs = rowSeats.map((s) => s.x).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i]! - xs[i - 1]!);
  if (gaps.length === 0) return Number.POSITIVE_INFINITY;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 1;
  return median * 1.6;
}

/**
 * 후보 점수 — 사람이 실제로 원하는 순서.
 *
 * 빈자리가 여러 개일 때 아무거나 알리면 알림을 받고도 고민하게 된다.
 * 알림 하나로 결정이 끝나도록 정렬한다.
 */
export function scoreSeats(win: Seat[], map: SeatMap): number {
  const cols = map.seats.map((s) => s.col);
  const center = (Math.min(...cols) + Math.max(...cols)) / 2;
  const mid = win.reduce((a, s) => a + s.col, 0) / win.length;

  let score = 100 - Math.abs(mid - center) * 4;

  // 체인이 직접 "명당"이라고 표시한 좌석
  if (win.some((s) => s.sweetSpot)) score += 15;

  if (win.length === 1) {
    // 혼자 볼 때 외톨이석은 오히려 노려야 할 자리다.
    // 남들이 피하니 늦게까지 남고 경쟁이 가장 적다.
    if (isOrphan(win[0]!, map)) score += 18;
  } else {
    // 여럿이 볼 때 옆에 1자리만 남기는 배치는 서로에게 나쁘다.
    if (leavesOrphan(win, map)) score -= 25;
  }
  return score;
}

/** 양옆이 모두 막힌 1자리인가. */
export function isOrphan(seat: Seat, map: SeatMap): boolean {
  const row = rowOf(seat.row, map);
  const i = row.findIndex((s) => s.id === seat.id);
  if (i === -1) return false;
  return blocked(row[i - 1]) && blocked(row[i + 1]);
}

/** 이 묶음을 가져가면 같은 열에 외톨이 1석이 생기는가. */
export function leavesOrphan(win: Seat[], map: SeatMap): boolean {
  const taken = new Set(win.map((s) => s.id));
  const row = rowOf(win[0]!.row, map);

  return row.some((s, i) => {
    if (s.state !== 'free' || taken.has(s.id)) return false;
    const l = row[i - 1];
    const r = row[i + 1];
    return blocked(l, taken) && blocked(r, taken);
  });
}

/** 없거나(열 끝) / 못 사거나 / 이번에 우리가 가져가는 좌석 = 막힘 */
function blocked(s: Seat | undefined, taken?: Set<string>): boolean {
  if (!s) return true;
  if (s.state !== 'free') return true;
  return taken ? taken.has(s.id) : false;
}

function rowOf(row: string, map: SeatMap): Seat[] {
  return map.seats.filter((s) => s.row === row).sort((a, b) => a.col - b.col);
}

function groupBy<T, K>(list: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of list) {
    const k = key(item);
    const bucket = m.get(k);
    if (bucket) bucket.push(item);
    else m.set(k, [item]);
  }
  return m;
}
