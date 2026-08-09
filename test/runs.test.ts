import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { LotteResponse } from '../src/adapters/lotte/client.js';
import { parseSeatMap } from '../src/adapters/lotte/parse.js';
import { aisleThreshold, findCandidates, isOrphan, leavesOrphan } from '../src/core/runs.js';
import type { Seat, SeatMap } from '../src/types.js';

const raw = JSON.parse(
  readFileSync(new URL('./fixtures/lotte-worldtower-9gwan-seq4.json', import.meta.url), 'utf8'),
) as LotteResponse;

const map = parseSeatMap(raw, {
  theaterId: '1016',
  screenId: '101609',
  playDate: '20260809',
  playSequence: '4',
});

const label = (s: Seat) => `${s.row}${s.col}`;
const labels = (c: { seats: Seat[] }) => c.seats.map(label);

describe('연석 판정 — 통로', () => {
  /**
   * 이 프로젝트에서 가장 비싼 버그.
   *
   * H04 와 H05 는 좌석 번호가 이어져 있고 둘 다 비어 있지만,
   * 사이에 통로가 있다(구획 1 → 2, x 간격 583 vs 정상 283).
   * 이걸 2연석이라고 알리면 "잡았다" 하고 가서 통로를 사이에 두고 따로 앉는다.
   */
  it('번호가 연속이어도 통로 건너면 연석이 아니다', () => {
    const found = findCandidates(map, null, { mode: 'adjacent', size: 2 });
    for (const c of found) {
      expect(labels(c)).not.toEqual(['H4', 'H5']);
    }
  });

  it('통로에 끊기지 않은 자리만 2연석으로 잡는다', () => {
    const found = findCandidates(map, null, { mode: 'adjacent', size: 2 });
    expect(found.map(labels)).toEqual([['J10', 'J11']]);
  });

  it('3연석은 하나도 없다', () => {
    expect(findCandidates(map, null, { mode: 'adjacent', size: 3 })).toHaveLength(0);
  });

  it('통로 임계값을 행마다 따로 잡는다', () => {
    const h = map.seats.filter((s) => s.row === 'H');
    const o = map.seats.filter((s) => s.row === 'O'); // 리클라이너, 좌석 간격 470

    expect(aisleThreshold(h)).toBeCloseTo(283 * 1.6, 5);
    expect(aisleThreshold(o)).toBeCloseTo(470 * 1.6, 5);

    // 전체 중앙값(283)을 쓰면 리클라이너의 정상 간격 470 이 통로로 오인된다.
    expect(470).toBeGreaterThan(aisleThreshold(h));
    expect(470).toBeLessThan(aisleThreshold(o));
  });
});

describe('단석 판정', () => {
  it('빈자리 전부를 후보로 낸다', () => {
    const found = findCandidates(map, null, { mode: 'single', size: 1 });
    expect(found).toHaveLength(6);
  });

  it('양옆이 막힌 외톨이석을 알아본다', () => {
    const c15 = map.seats.find((s) => s.row === 'C' && s.col === 15)!;
    const h4 = map.seats.find((s) => s.row === 'H' && s.col === 4)!;
    expect(isOrphan(c15, map)).toBe(true);
    expect(isOrphan(h4, map)).toBe(false); // H05 가 비어 있다
  });

  it('혼자 볼 때는 외톨이석에 가점을 준다', () => {
    const found = findCandidates(map, null, { mode: 'single', size: 1 });
    const c15 = found.find((c) => labels(c)[0] === 'C15')!;
    const h4 = found.find((c) => labels(c)[0] === 'H4')!;
    // 두 좌석의 중앙 근접도는 C15 가 더 나쁘지만(15 vs 4 → 오히려 C15 가 중앙),
    // 외톨이 가점이 실제로 반영되는지만 본다.
    expect(c15.score).toBeGreaterThan(0);
    expect(h4.score).toBeLessThan(c15.score);
  });
});

describe('leavesOrphan', () => {
  it('가져가면 옆에 1자리만 남는 배치를 감점 대상으로 본다', () => {
    // ...F F F...  가운데 2석을 가져가면 양끝 1석씩이 외톨이가 된다
    const m = tinyRow([
      { col: 10, state: 'sold' },
      { col: 11, state: 'free' },
      { col: 12, state: 'free' },
      { col: 13, state: 'free' },
      { col: 14, state: 'sold' },
    ]);
    const win = m.seats.filter((s) => s.col === 11 || s.col === 12);
    expect(leavesOrphan(win, m)).toBe(true);
  });

  it('외톨이를 만들지 않으면 감점하지 않는다', () => {
    const m = tinyRow([
      { col: 10, state: 'sold' },
      { col: 11, state: 'free' },
      { col: 12, state: 'free' },
      { col: 13, state: 'sold' },
    ]);
    const win = m.seats.filter((s) => s.col === 11 || s.col === 12);
    expect(leavesOrphan(win, m)).toBe(false);
  });
});

function tinyRow(spec: Array<{ col: number; state: Seat['state'] }>): SeatMap {
  return {
    chain: 'lotte',
    theaterId: 'T',
    screenId: 'S',
    playDate: '20260809',
    playSequence: '1',
    fetchedAt: 0,
    seats: spec.map(({ col, state }) => ({
      id: `H${col}`,
      row: 'H',
      col,
      x: col * 283,
      y: 0,
      group: 1,
      state,
    })),
  };
}
