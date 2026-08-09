import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { LotteResponse } from '../src/adapters/lotte/client.js';
import { parseSeatMap } from '../src/adapters/lotte/parse.js';
import { blockContext, inBlock, type SeatBlock } from '../src/core/block.js';
import { findCandidates } from '../src/core/runs.js';

const raw = JSON.parse(
  readFileSync(new URL('./fixtures/lotte-worldtower-9gwan-seq4.json', import.meta.url), 'utf8'),
) as LotteResponse;

const map = parseSeatMap(raw, {
  theaterId: '1016',
  screenId: '101609',
  playDate: '20260809',
  playSequence: '4',
});
const ctx = blockContext(map);

const at = (row: string, col: number) => map.seats.find((s) => s.row === row && s.col === col)!;

describe('inBlock', () => {
  it('미지정이면 상영관 전체', () => {
    expect(inBlock(at('A', 3), null, ctx)).toBe(true);
    expect(inBlock(at('O', 18), null, ctx)).toBe(true);
  });

  it('rect — 행·열 범위', () => {
    const blk: SeatBlock = { kind: 'rect', rowFrom: 'H', rowTo: 'J', colFrom: 9, colTo: 14 };
    expect(inBlock(at('J', 11), blk, ctx)).toBe(true);
    expect(inBlock(at('K', 11), blk, ctx)).toBe(false); // 행 밖
    expect(inBlock(at('J', 20), blk, ctx)).toBe(false); // 열 밖
  });

  it('labels — 좌석 하나하나 지정', () => {
    const blk: SeatBlock = { kind: 'labels', labels: ['J10', 'J11'] };
    expect(inBlock(at('J', 10), blk, ctx)).toBe(true);
    expect(inBlock(at('J', 12), blk, ctx)).toBe(false);
  });

  /**
   * 여러 지점을 동시에 감시하면 상영관 크기가 제각각이라 절대 좌표가 무너진다.
   * ratio 는 "어느 관이든 뒤에서 40%, 좌우 가운데" 를 한 번에 표현한다.
   */
  it('ratio — 관 크기에 무관한 상대 지정', () => {
    const middle: SeatBlock = { kind: 'ratio', rowPct: [0.4, 0.8], colPct: [0.3, 0.7] };
    expect(inBlock(at('J', 14), middle, ctx)).toBe(true);
    expect(inBlock(at('A', 3), middle, ctx)).toBe(false); // 맨 앞 맨 왼쪽
    expect(inBlock(at('N', 26), middle, ctx)).toBe(false); // 맨 뒤 맨 오른쪽
  });
});

describe('블록으로 후보 좁히기', () => {
  it('블록 밖 빈자리는 후보에서 빠진다', () => {
    const onlyJ: SeatBlock = { kind: 'rect', rowFrom: 'J', rowTo: 'J', colFrom: 1, colTo: 26 };
    const found = findCandidates(map, onlyJ, { mode: 'single', size: 1 });
    expect(found.map((c) => `${c.seats[0]!.row}${c.seats[0]!.col}`).sort()).toEqual(['J10', 'J11']);
  });

  it('블록이 연석을 가로지르면 후보가 사라진다', () => {
    // J11 만 포함되도록 잘라내면 2연석이 성립하지 않는다
    const cut: SeatBlock = { kind: 'rect', rowFrom: 'J', rowTo: 'J', colFrom: 11, colTo: 26 };
    expect(findCandidates(map, cut, { mode: 'adjacent', size: 2 })).toHaveLength(0);
  });
});
