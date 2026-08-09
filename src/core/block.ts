import type { Seat, SeatMap } from '../types.js';

/**
 * 좌석 블록 지정.
 *
 * 세 방식을 모두 지원한다. 여러 지점을 동시에 감시하면 상영관 크기가 달라
 * 절대 좌표가 무너지므로, 멀티 지점에서는 ratio 가 사실상 유일한 정답이다.
 */
export type SeatBlock =
  | { kind: 'rect'; rowFrom: string; rowTo: string; colFrom: number; colTo: number }
  | { kind: 'labels'; labels: string[] }
  | { kind: 'ratio'; rowPct: [number, number]; colPct: [number, number] };

/** 상영관 크기에 의존하는 값을 한 번만 계산해 재사용한다. */
export interface BlockContext {
  rows: string[];
  colMin: number;
  colMax: number;
}

export function blockContext(map: SeatMap): BlockContext {
  const rows = [...new Set(map.seats.map((s) => s.row))].sort();
  const cols = map.seats.map((s) => s.col);
  return {
    rows,
    colMin: cols.length ? Math.min(...cols) : 0,
    colMax: cols.length ? Math.max(...cols) : 0,
  };
}

export function inBlock(seat: Seat, blk: SeatBlock | null, ctx: BlockContext): boolean {
  if (!blk) return true; // 미지정 = 상영관 전체

  switch (blk.kind) {
    case 'labels':
      return blk.labels.includes(`${seat.row}${seat.col}`);

    case 'rect':
      return (
        seat.row >= blk.rowFrom &&
        seat.row <= blk.rowTo &&
        seat.col >= blk.colFrom &&
        seat.col <= blk.colTo
      );

    case 'ratio': {
      // 실제 상영관 크기로 정규화 → "뒤에서 40%, 좌우 가운데 40%" 가
      // IMAX관에서도 소형관에서도 같은 의미를 갖는다.
      const rIdx = ctx.rows.indexOf(seat.row) / Math.max(1, ctx.rows.length - 1);
      const cIdx = (seat.col - ctx.colMin) / Math.max(1, ctx.colMax - ctx.colMin);
      return (
        rIdx >= blk.rowPct[0] &&
        rIdx <= blk.rowPct[1] &&
        cIdx >= blk.colPct[0] &&
        cIdx <= blk.colPct[1]
      );
    }
  }
}
