import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { createCgvAdapter } from '../src/adapters/cgv/adapter.js';
import { POLL_FLOOR_SEC, showtimeRef, type WatchSpec } from '../src/core/spec.js';
import type { Showtime } from '../src/types.js';
import { CGV_THEATERS } from './cgv-theaters.js';

/**
 * 로컬 감시 콘솔.
 *
 *   npm run ui        →  http://localhost:5173
 *
 * 설정 화면을 웹 아티팩트로 만들었더니 두 가지가 막혔다.
 *
 *   1. 회차를 보여줄 수 없다. 아티팩트는 외부 요청이 전부 차단된 샌드박스라
 *      CGV 를 부르지 못한다. 사용자가 상영관 번호와 회차 순번을 어디선가
 *      찾아 손으로 적어야 했다.
 *   2. 감시를 시작할 수 없다. JSON 을 복사해 cmd 에 붙여넣는 단계가 남았고,
 *      실제로 거기서 명령어를 잘못 복사해 설정 파일이 깨진 적이 있다.
 *
 * 로컬에서 돌면 둘 다 없다. 회차를 실제로 불러와 보여주고, 고른 것으로
 * 설정을 써서 감시까지 바로 띄운다. 붙여넣기 단계가 사라진다.
 *
 * 바깥으로 열지 않는다. 127.0.0.1 에만 묶는다 — 이 서버는 프로세스를
 * 띄울 수 있으므로 남이 닿으면 안 된다.
 */

/**
 * 감시기를 띄우는 명령.
 *
 * 처음에는 npm run watch 를 셸로 띄웠는데, Windows 에서 .cmd 를 실행하려면
 * shell: true 가 필요하고 Node 가 그 조합에 경고를 낸다 (DEP0190) —
 * 인자가 이스케이프되지 않고 이어붙기만 하기 때문이다. 설정 파일 이름이
 * 우리 손에서 나오니 당장 위험하진 않지만, 셸을 거칠 이유가 없다.
 *
 * node 를 직접 띄우고 tsx 를 로더로 물린다. 셸도 npm 도 끼지 않는다.
 * package.json 의 watch 스크립트와 같은 일을 한다.
 */
const WATCH_ARGS = ['--import', 'tsx', '--env-file-if-exists=.env', 'src/main.ts'];

const PORT = Number(process.env.UI_PORT ?? 5173);
const HOST = '127.0.0.1';
const CONFIG = 'watch.json';
const LOG_LINES = 300;

let watcher: ChildProcess | null = null;
let log: string[] = [];
let spec: WatchSpec | null = null;

const page = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  try {
    if (url.pathname === '/') return send(res, 200, page, 'text/html; charset=utf-8');
    // 하한을 화면에도 알려준다. 양쪽에 따로 적어두면 한쪽만 고치게 된다 —
    // 실제로 하한을 15초에서 10초로 내리고 여기 두 군데를 놓쳤다.
    if (url.pathname === '/api/theaters') {
      return json(res, { theaters: CGV_THEATERS, floorSec: POLL_FLOOR_SEC });
    }
    if (url.pathname === '/api/showtimes') return await showtimes(res, url);
    if (url.pathname === '/api/status') return json(res, status());
    if (url.pathname === '/api/start' && req.method === 'POST') return await start(req, res);
    if (url.pathname === '/api/stop' && req.method === 'POST') return stop(res);
    send(res, 404, 'not found', 'text/plain');
  } catch (err) {
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n감시 콘솔  http://localhost:${PORT}\n`);
  console.log('  회차를 불러와 고르고, 거기서 바로 감시를 시작합니다.');
  console.log('  이 창을 닫으면 감시도 함께 멈춥니다.\n');
});

/* ── 회차 ─────────────────────────────────────────────── */

async function showtimes(res: import('node:http').ServerResponse, url: URL): Promise<void> {
  const theater = url.searchParams.get('theater') ?? '';
  const date = url.searchParams.get('date') ?? '';
  if (!/^\d{4}$/.test(theater) || !/^\d{8}$/.test(date)) {
    return json(res, { error: '지점 코드 4자리와 날짜 8자리가 필요합니다' }, 400);
  }

  const adapter = createCgvAdapter([{ chain: 'cgv', theaterId: theater }]);
  try {
    const list = await adapter.listShowtimes(0, date);
    json(res, { showtimes: list.map(brief).sort(byTime) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 차단은 다른 실패와 구분해서 보여준다. 다시 눌러도 소용없다.
    json(res, { error: msg, blocked: /이용이 제한|비정상적으로/.test(msg) }, 502);
  } finally {
    await adapter.close();
  }
}

function brief(s: Showtime) {
  return {
    ref: showtimeRef(s),
    startTime: s.startTime,
    screenName: s.screenName,
    movieName: s.movieName,
    movieId: s.movieId,
    remainingSeats: s.remainingSeats,
    totalSeats: s.totalSeats,
  };
}

function byTime(a: { startTime: string; screenName: string }, b: typeof a): number {
  return a.startTime.localeCompare(b.startTime) || a.screenName.localeCompare(b.screenName);
}

/* ── 감시 ─────────────────────────────────────────────── */

interface StartBody {
  /** 고른 회차가 걸쳐 있는 지점들. 회차 키에서 뽑아 보낸다. */
  theaters: { theaterId: string; label?: string }[];
  date: string;
  refs: string[];
  /** 시간당 요청 상한. 간격은 여기서 짝 수로 나눠 나온다. */
  maxRequestsPerHour?: number;
  /** 한 번에 이만큼 풀렸을 때만 알린다. 단석 1, 연석 2. */
  minIncrease?: number;
  lastStart?: string;
}

async function start(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  if (watcher) return json(res, { error: '이미 감시 중입니다' }, 409);

  const body = (await readJson(req)) as StartBody;
  if (!body.refs?.length) return json(res, { error: '회차를 하나 이상 고르세요' }, 400);
  if (!body.theaters?.length) return json(res, { error: '지점을 알 수 없습니다' }, 400);

  spec = {
    id: `cgv-${body.theaters.map((t) => t.theaterId).join('-')}-${body.date}`,
    theaters: body.theaters.map((t) => ({
      chain: 'cgv' as const,
      theaterId: t.theaterId,
      label: t.label ?? t.theaterId,
    })),
    movies: [],
    dates: [body.date],
    windows: [],
    showtimes: body.refs,
    block: null,
    party: { mode: 'single', size: 1 },
    action: 'notify',
    pollFloorSec: POLL_FLOOR_SEC,
    maxRequestsPerHour: Math.max(12, body.maxRequestsPerHour ?? 120),
    ...(body.minIncrease && body.minIncrease > 1 ? { minIncrease: body.minIncrease } : {}),
    maxAlertsPerRun: 5,
    expiresAt: endOfDay(body.date, body.lastStart ?? '23:59'),
  };
  writeFileSync(CONFIG, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

  log = [`${stamp()} ${CONFIG} 을 쓰고 감시를 시작합니다`];
  watcher = spawn(process.execPath, [...WATCH_ARGS, CONFIG], { env: process.env });
  watcher.stdout?.on('data', (b: Buffer) => absorb(b));
  watcher.stderr?.on('data', (b: Buffer) => absorb(b));
  watcher.on('close', (code) => {
    log.push(`${stamp()} 감시가 끝났습니다 (종료 코드 ${code ?? 0})`);
    watcher = null;
  });

  json(res, status());
}

function stop(res: import('node:http').ServerResponse): void {
  if (!watcher) return json(res, status());
  log.push(`${stamp()} 중지를 요청했습니다`);
  // 확보 모드에서는 감시기가 브라우저를 띄운다. Windows 에서는 트리째 잡는다.
  if (process.platform === 'win32' && watcher.pid) {
    spawn('taskkill', ['/pid', String(watcher.pid), '/t', '/f']);
  } else {
    watcher.kill('SIGTERM');
  }
  json(res, status());
}

function absorb(b: Buffer): void {
  for (const line of b.toString('utf8').split(/\r?\n/)) {
    if (line.trim()) log.push(line);
  }
  if (log.length > LOG_LINES) log = log.slice(-LOG_LINES);
}

function status() {
  return {
    running: watcher !== null,
    spec,
    log,
    // 요청량을 화면에 계속 띄워둔다. 모르면 조절할 수 없다.
    perHour: spec?.maxRequestsPerHour ?? 0,
  };
}

/* ── 자잘한 것 ────────────────────────────────────────── */

function send(res: import('node:http').ServerResponse, code: number, body: string, type: string) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function json(res: import('node:http').ServerResponse, body: unknown, code = 200) {
  send(res, code, JSON.stringify(body), 'application/json; charset=utf-8');
}

async function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
}

function stamp(): string {
  return `[${new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Seoul' })}]`;
}

/** 마지막 회차가 끝난 뒤 한 시간. 무한 감시를 막는 안전장치다. */
function endOfDay(ymd: string, lastStart: string): string {
  const [h = '23', m = '59'] = lastStart.split(':');
  return new Date(
    Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), +h - 9, +m) + 3_600_000,
  ).toISOString();
}

/** 창을 닫으면 감시도 함께 멈춘다. 몰래 남아 계속 조회하면 안 된다. */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    watcher?.kill();
    server.close();
    process.exit(0);
  });
}

// tsx 가 이 파일을 직접 실행하는지 확인 (import 되면 서버를 띄우지 않는다)
void fileURLToPath(import.meta.url);
