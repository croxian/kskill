/**
 * 테스트용 좌석맵 픽스처 생성기.
 *
 * 2026-08-09 롯데시네마 월드타워 9관(screenId 101609, playSequence 4)의
 * 실제 GetSeats 응답에서 **관측된 계약을 그대로 재현**한다.
 * 실제 응답 본문을 커밋하지 않으려고 합성했을 뿐, 아래 값들은 전부 실측이다.
 *
 *   좌석 총계          360  (A~K 24석 × 11, L~N 26석 × 3, O 리클라이너 18석)
 *   좌석 간격          283, 통로 585 → 실측 583 (col 5 / 9 / 23 앞)
 *   구획(SeatColumGroupNo) 히스토그램  1:40  2:60  3:200  4:60
 *   상태(SeatStatusCode) 히스토그램    0:6  50:335  28:13  80:3  23:2  20:1
 *   BookingSeats       354 = 360 - 6
 *   시작 좌표          x 943 (col 1), y 2082 (row A)
 *
 * 픽스처에는 판정 알고리즘을 시험하는 배치를 일부러 심어 두었다.
 *   H04 / H05  번호는 연속이지만 통로를 사이에 둔 함정 (연석 아님)
 *   J10 / J11  진짜 2연석
 *   C15 / N20  단석
 *
 * 실제 캡처본이 있으면 test/fixtures/ 에 나란히 두고 같은 테스트를 돌리면 된다.
 *
 *   node scripts/make-fixture.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'test', 'fixtures', 'lotte-worldtower-9gwan-seq4.json');

const X0 = 943;
const STEP = 283;
const AISLE_EXTRA = 300;
const AISLE_BEFORE = [5, 9, 23]; // 이 열 앞에 통로
const Y0 = 2082;
const Y_STEP = 460;

const xOf = (col) =>
  X0 + (col - 1) * STEP + AISLE_EXTRA * AISLE_BEFORE.filter((b) => col >= b).length;

const groupOf = (col) => (col <= 4 ? 1 : col <= 8 ? 2 : col <= 22 ? 3 : 4);

const ROWS = [
  ...'ABCDEFGHIJK'.split('').map((r) => ({ row: r, from: 3, to: 26 })),
  ...'LMN'.split('').map((r) => ({ row: r, from: 1, to: 26 })),
];

/** SeatStatusCode 0 인 좌석 — 사이트 표기 "6 / 342" 와 같은 6석 */
const FREE = new Set(['H04', 'H05', 'J10', 'J11', 'C15', 'N20']);

/** 비어 있지만 팔지 않는 좌석 19석. 실측 히스토그램에 맞춰 A열에 몰아 둔다. */
const BLOCKED = new Map([
  ...range(3, 15).map((c) => [`A${pad(c)}`, 28]),
  ...range(16, 18).map((c) => [`A${pad(c)}`, 80]),
  ...range(19, 20).map((c) => [`A${pad(c)}`, 23]),
  [`A21`, 20],
]);

const seats = [];

for (const [i, { row, from, to }] of ROWS.entries()) {
  for (let col = from; col <= to; col++) {
    const label = `${row}${pad(col)}`;
    seats.push(
      seat({
        row,
        col,
        x: xOf(col),
        y: Y0 + i * Y_STEP,
        group: groupOf(col),
        status: FREE.has(label) ? 0 : (BLOCKED.get(label) ?? 50),
        block: row === 'A' ? 100 : 290,
        // 가운데 뒤쪽을 명당으로 표시 (롯데 SweetSpotYN)
        sweet: 'HIJ'.includes(row) && col >= 12 && col <= 15,
      }),
    );
  }
}

// O열 리클라이너 18석. 좌석이 크고 배치가 달라 구획도 따로 매겨진다.
// 구획 히스토그램의 나머지(1:6 2:4 3:4 4:4)가 여기서 채워진다.
const O_GROUPS = [...fill(1, 6), ...fill(2, 4), ...fill(3, 4), ...fill(4, 4)];
for (let col = 1; col <= 18; col++) {
  seats.push(
    seat({
      row: 'O',
      col,
      x: X0 + (col - 1) * 470,
      y: Y0 + ROWS.length * Y_STEP,
      group: O_GROUPS[col - 1],
      status: 50, // 프라임타임 리클라이너는 매진이었다 (div960 잔여 0)
      block: 20,
      sweet: false,
    }),
  );
}

const bookingSeats = seats
  .filter((s) => s.SeatStatusCode !== 0)
  .map((s) => ({
    SeatNo: s.SeatNo,
    SeatRow: s.SeatRow,
    SeatColumn: s.SeatColumn,
    SeatColumnGroupNo: String(s.SeatColumGroupNo),
    ShowSeatRow: s.ShowSeatRow,
    ShowSeatColumn: s.ShowSeatColumn,
    SeatStatusCode: 0,
  }));

const payload = {
  IsOK: true,
  ResultCode: '200',
  ResultMessage: '',
  Seats: { Items: seats, ItemCount: seats.length },
  BookingSeats: { Items: bookingSeats, ItemCount: bookingSeats.length },
  Enterences: {
    Items: [
      {
        EnterenceSequence: '4',
        EnterenceDivisionNameKR: '입구',
        EnterenceAngleCode: 20,
        EnterenceAngleName: null,
        EnterenceXCoordination: '525',
        EnterenceYCoordination: '9360',
        EnterenceFloor: 1,
      },
    ],
    ItemCount: 1,
  },
  ScreenSeatInfo: {
    Items: [
      {
        TotalSeatCount: seats.length,
        BookingCount: bookingSeats.length,
        AloneSeatCancelRate: 0.0,
        MaxSeatColumn: 26,
        StartXCoordinate: X0,
        StartYCoordinate: Y0,
        EndXCoordinate: 9260,
        SeatApplyYNSet: 'Y,N,N',
        DplxYn: '1',
        StartFloor: '7',
        AllSeatIDCheckedYN: 0,
        FloorInfoItems: [],
      },
    ],
    ItemCount: 0,
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log(`wrote ${OUT}`);
console.log(`  seats        ${seats.length}`);
console.log(`  free         ${seats.filter((s) => s.SeatStatusCode === 0).length}`);
console.log(`  bookingSeats ${bookingSeats.length}`);
console.log(`  groups       ${JSON.stringify(hist(seats, 'SeatColumGroupNo'))}`);
console.log(`  statuses     ${JSON.stringify(hist(seats, 'SeatStatusCode'))}`);

function seat({ row, col, x, y, group, status, block, sweet }) {
  return {
    ScreenFloor: 7,
    SeatNo: `1${row}${pad(col)}`,
    PhysicalBlockCode: block === 100 ? 290 : block,
    DisplayPhysicalBlockCode: block,
    LogicalBlockCode: 0,
    SeatBlockSet: 'N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,N,Y',
    SeatRow: row,
    SeatColumn: col,
    SeatColumGroupNo: String(group),
    ShowSeatRow: row,
    ShowSeatColumn: col,
    RelatedSeatNo: '          ',
    RelatedSeatCount: 1,
    SeatXCoordinate: x,
    SeatYCoordinate: y,
    SeatXLength: 226,
    SeatYLength: 416,
    SweetSpotYN: sweet ? 'Y' : 'N',
    SeatFloor: 1,
    FeeBlockCode: 3,
    SeatStatusCode: status,
    SalesDisableTicketCode: '40,50,65,66,80',
    CustomerDivisionCode: 0,
    CustomerDivisionItem: null,
    IDCheckStatCode: 0,
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}
function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
function fill(v, n) {
  return Array.from({ length: n }, () => v);
}
function hist(list, key) {
  const out = {};
  for (const item of list) out[item[key]] = (out[item[key]] ?? 0) + 1;
  return out;
}
