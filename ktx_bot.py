# -*- coding: utf-8 -*-
"""
ktx_bot.py - 텔레그램으로 조종하는 KTX 빈자리 감시 봇

PC 에서 이 스크립트를 한 번 켜 두면, 이후에는 밖에서 휴대폰 텔레그램으로
감시를 걸고 끄고 확인할 수 있습니다.

    python ktx_bot.py

켜 둔 다음 텔레그램에서:
    /watch 서울 부산 0923 0928      09:28 열차만 감시
    /watch 서울 부산 0923 all       하루 전체
    /watch 서울 부산 0923 0900-1200 구간
    /status                        지금 상태
    /stop                          감시 중단

안전장치는 ktx_watch.py 와 같습니다. 조회 간격 30초 하한, 12시간 상한,
연속 에러 3회 중단. 감시는 한 번에 하나만 돕니다.

주의: 이 봇은 secrets.env 에 적힌 chat_id 하나만 받아들입니다. 다른
사람이 봇에게 말을 걸어도 무시합니다.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import traceback

import ktx_watch as kw   # 같은 폴더의 ktx_watch.py 를 그대로 재사용합니다

SCRIPT_VERSION = "2026-09-22a"

POLL_TIMEOUT = 30        # 롱폴링 대기(초). 텔레그램이 이 동안 붙잡고 있어 줍니다.
MAX_TRAINS_IN_MSG = 8    # 메시지에 넣을 열차 수 상한
RELOGIN_AFTER_MIN = 20   # 이 시간마다 코레일에 다시 로그인합니다.
MAX_ERRORS = 6           # 오류가 이만큼 연속되면 포기합니다.
ERROR_BACKOFF_MAX = 600  # 오류 후 최대 대기(초). 10분.


def explain_login_error(name: str) -> str:
    """로그인 단계에서 난 오류를 설명합니다. 조회 실패와는 원인이 다릅니다."""
    if name == "KeyError":
        return ("코레일이 로그인을 거부했습니다.\n\n"
                "확인된 사례로는 코레일의 매크로 탐지에 걸린 경우입니다.\n"
                "코레일이 403 과 함께 이렇게 답합니다:\n"
                "  \"매크로 등 미허가 도구 사용 시 이용이 제한될 수 있습니다\"\n\n"
                "이건 우회할 문제가 아니라 그만둬야 하는 신호입니다.\n"
                "계속 시도하면 계정이 제한될 수 있습니다.\n\n"
                "정확한 응답을 보려면 서버에서:\n"
                "  /opt/ktx-bot/venv/bin/python ~/kskill/check_login.py\n\n"
                "표가 필요하시면 코레일톡 앱의 예약대기를 쓰세요.")
    if name == "NeedToLoginError":
        return "아이디나 비밀번호가 틀렸습니다. secrets.env 를 확인하세요."
    return "잠시 뒤 다시 시도하되, 반복 실패하면 계정 상태를 먼저 확인하세요."


def explain_error(name: str) -> str:
    """오류 이름을 사람이 읽을 수 있는 설명으로 바꿉니다."""
    if name == "KeyError":
        return ("코레일이 예상과 다른 응답을 보냈습니다.\n"
                "보통 세션 만료이거나, 코레일 예매 시스템이 야간 점검 중일 때 납니다.\n"
                "잠시 뒤 /watch 로 다시 걸어보세요.")
    if name in ("ConnectionError", "Timeout", "ReadTimeout", "ProxyError"):
        return "코레일 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요."
    if name == "NeedToLoginError":
        return "로그인이 풀렸습니다. 봇을 다시 시작하세요: sudo systemctl restart ktx-bot"
    return "잠시 뒤 /watch 로 다시 걸어보세요."


HELP = """KTX 빈자리 감시 봇

/watch 출발 도착 날짜 [시간] [reserve]
  예) /watch 서울 부산 0923 0928
      /watch 서울 부산 0923 all
      /watch 서울 부산 0923 0900-1200
      /watch 서울 부산 0923 0928 reserve

  날짜: 0923 또는 20260923
  시간: all(하루 전체) / 0928(그 시각만) / 0900-1200(구간) / 생략시 하루 전체
  reserve: 붙이면 자리를 찾았을 때 예약까지 시도합니다 (결제는 안 함)

/status  지금 무엇을 감시 중인지
/stop    감시 중단
/help    이 도움말"""


class Watcher:
    """감시 작업 하나. 한 번에 하나만 돕니다."""

    def __init__(self, korail, spec: dict, say):
        self.korail = korail
        self.spec = spec
        self.say = say                      # 텔레그램으로 한 줄 보내는 함수
        self.stop_flag = threading.Event()
        self.attempts = 0
        self.started = time.time()
        self.last_line = "시작 준비 중"
        self.last_login = time.time()       # 봇이 방금 로그인한 상태로 시작합니다
        self.reserve_fails = 0              # 예약을 시도했다 놓친 횟수
        self.thread = threading.Thread(target=self._run, daemon=True)

    # --- 로그인 유지 ---
    def _relogin(self) -> bool:
        """코레일에 다시 로그인합니다. 성공하면 True.

        오래 돌면 세션이 끊깁니다. 그 상태로 조회하면 코레일이 평소와 다른
        응답을 주고, 라이브러리가 KeyError: 'strResult' 로 터집니다.
        """
        fn = getattr(self.korail, "login", None)
        if not callable(fn):
            return False
        try:
            fn()
            self.last_login = time.time()
            return True
        except Exception as exc:
            print(f"    재로그인 실패: {type(exc).__name__}: {exc}")
            return False

    # --- 조회 ---
    def _fetch(self):
        s = self.spec
        fn = self.korail.search_train_allday if s["allday"] else self.korail.search_train
        wanted = {"include_no_seats": True}
        return fn(s["dep"], s["arr"], s["date"], s["from_time"],
                  **kw.keep_supported(fn, wanted))

    def _search_once(self):
        """한 번 조회합니다. 세션이 끊긴 것 같으면 다시 로그인하고 한 번 더 시도합니다."""
        try:
            return self._fetch()
        except Exception as exc:
            if type(exc).__name__ in ("NoResultsError", "SoldOutError"):
                raise                      # 매진은 정상이므로 그대로 올립니다
            print(f"    조회 실패({type(exc).__name__}). 다시 로그인해 봅니다.")
            if not self._relogin():
                raise
            return self._fetch()           # 재로그인했으니 한 번만 더

    def _in_target(self, train) -> bool:
        s = self.spec
        raw = getattr(train, "dep_time", None)
        if not raw:
            return True
        hhmm = str(raw)[:4]
        if s["at"] and hhmm not in s["at"]:
            return False
        if s["until"] and hhmm > s["until"]:
            return False
        return True

    @staticmethod
    def _has_seat(train):
        fn = getattr(train, "has_seat", None)
        if not callable(fn):
            return None
        try:
            return bool(fn())
        except Exception:
            return None

    # --- 본체 ---
    def _run(self):
        s = self.spec
        interval = kw.MIN_INTERVAL_ALLDAY if s["allday"] else kw.MIN_INTERVAL_SEC
        deadline = time.time() + kw.MAX_RUNTIME_MIN * 60
        errors = 0

        while not self.stop_flag.is_set() and time.time() < deadline:
            cycle_start = time.monotonic()
            self.attempts += 1
            stamp = time.strftime("%H:%M:%S")

            # 오래 돌면 세션이 끊기므로 주기적으로 미리 갱신합니다.
            if time.time() - self.last_login > RELOGIN_AFTER_MIN * 60:
                if self._relogin():
                    print(f"[{stamp}] 세션 갱신")

            try:
                trains = [t for t in self._search_once() if self._in_target(t)]
                errors = 0
                states = [self._has_seat(t) for t in trains]
                if trains and not all(x is None for x in states):
                    total = len(trains)
                    trains = [t for t, x in zip(trains, states) if x]
                else:
                    total = len(trains)
            except Exception as exc:
                name = type(exc).__name__
                if name in ("NoResultsError", "SoldOutError"):
                    trains, total = [], 0
                else:
                    errors += 1
                    self.last_line = f"{stamp} 오류: {name} ({errors}회째)"
                    print(f"[{stamp}] {self.attempts}회 - 오류 {name}: {exc}")

                    if errors >= MAX_ERRORS:
                        self.say(f"[중단] 오류가 {errors}회 연속 발생했습니다.\n"
                                 f"마지막: {name}: {exc}\n\n{explain_error(name)}")
                        return

                    # 코레일이 흔들리는 중일 수 있습니다. 점점 더 오래 쉽니다.
                    backoff = min(interval * (2 ** errors), ERROR_BACKOFF_MAX)
                    print(f"    {backoff:.0f}초 쉬었다가 다시 시도합니다 "
                          f"({errors}/{MAX_ERRORS})")
                    self.stop_flag.wait(backoff)
                    continue

            if trains:
                if self._on_found(trains):
                    return
                # 예약에 실패했으면 감시를 계속합니다. 남이 먼저 가져갔을 뿐,
                # 취소표는 또 나옵니다. 여기서 끝내면 다시 걸어야 했습니다.
                self.stop_flag.wait(interval)
                continue

            self.last_line = f"{stamp} {self.attempts}회 - {total}대 매진"
            print(f"[{stamp}] {self.attempts}회 - 열차 {total}대 전부 매진")

            wait = interval - (time.monotonic() - cycle_start)
            if wait > 0:
                # stop 명령이 오면 기다리는 중에도 바로 깨어납니다.
                self.stop_flag.wait(wait)

        if self.stop_flag.is_set():
            self.say(f"감시를 중단했습니다. (총 {self.attempts}회 조회)")
        else:
            self.say(f"12시간이 지나 감시를 마쳤습니다. (총 {self.attempts}회 조회)")

    @staticmethod
    def seat_detail(train) -> str:
        """이 열차의 좌석 상태를 최대한 자세히 적습니다.

        '잔여석없음' 이 났을 때, 한발 늦은 것인지 애초에 앉을 자리가 아닌
        것인지(입석·자유석만 있는 경우) 구분하기 위한 기록입니다.
        """
        bits = []
        for method in ("has_general_seat", "has_special_seat", "has_seat", "has_waiting_list"):
            fn = getattr(train, method, None)
            if callable(fn):
                try:
                    bits.append(f"{method}={fn()}")
                except Exception:
                    bits.append(f"{method}=?")
        for field in ("general_seat", "special_seat", "reserve_possible",
                      "reserve_possible_name", "train_no"):
            if hasattr(train, field):
                bits.append(f"{field}={getattr(train, field)!r}")
        return ", ".join(bits) if bits else "(정보 없음)"

    def _on_found(self, trains) -> bool:
        """자리를 찾았을 때의 처리. 감시를 끝내야 하면 True 를 돌려줍니다."""
        s = self.spec
        listed = "\n".join(f"- {t}" for t in trains[:MAX_TRAINS_IN_MSG])
        head = f"{s['dep']} -> {s['arr']} {s['date']}"
        print(f"\n빈자리 발견: {listed}")

        if not s["reserve"]:
            self.say(f"[빈자리 발견]\n{head}\n\n{listed}\n\n코레일톡에서 바로 예매하세요.")
            return True

        # 첫 번째만 보지 않고, 자리가 있다고 나온 열차를 차례로 시도합니다.
        last_exc = None
        for train in trains:
            detail = self.seat_detail(train)
            print(f"  예약 시도: {train}\n    좌석상태: {detail}")
            try:
                reservation = self.korail.reserve(train)
            except Exception as exc:
                last_exc = exc
                print(f"    실패: {type(exc).__name__}: {exc}")
                continue

            # 예약은 됐습니다. 화면에 먼저 남기고 알립니다.
            print(f"\n[예약됨] {reservation}")
            self.say(f"[예약 성공]\n{head}\n\n{reservation}\n\n"
                     "아직 결제가 안 됐습니다.\n"
                     "코레일톡 앱에서 10분 안에 결제하세요.\n"
                     "시간이 지나면 자동 취소됩니다.")
            return True

        # 전부 실패했습니다. 대개는 남이 먼저 가져간 것이므로 계속 감시합니다.
        self.reserve_fails += 1
        name = type(last_exc).__name__ if last_exc else "?"
        self.last_line = f"{time.strftime('%H:%M:%S')} 예약 실패 {self.reserve_fails}회"

        # 매번 알리면 시끄럽습니다. 처음과 5회마다만 보냅니다.
        if self.reserve_fails == 1 or self.reserve_fails % 5 == 0:
            self.say(f"[예약 실패 {self.reserve_fails}회]\n{head}\n\n{listed}\n\n"
                     f"사유: {name}: {last_exc}\n\n"
                     "한발 늦은 것으로 보입니다. 감시는 계속합니다.\n"
                     "멈추려면 /stop")
        return False       # 감시를 계속합니다

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_flag.set()

    def alive(self) -> bool:
        return self.thread.is_alive()

    def describe(self) -> str:
        s = self.spec
        if s["at"]:
            when = ", ".join(sorted(s["at"])) + " 출발"
        elif s["until"]:
            when = f"{s['from_time'][:4]}~{s['until']}"
        elif s["allday"]:
            when = "하루 전체"
        else:
            when = f"{s['from_time'][:4]} 이후"
        mins = int((time.time() - self.started) / 60)
        return (f"{s['dep']} -> {s['arr']} {s['date']}\n"
                f"시간대: {when}\n"
                f"예약 시도: {'예' if s['reserve'] else '아니오 (알림만)'}\n"
                f"경과: {mins}분, {self.attempts}회 조회\n"
                f"최근: {self.last_line}")


def parse_watch(parts: list[str]) -> tuple[dict | None, str]:
    """/watch 명령의 인자를 해석합니다. (설정, 오류메시지) 를 돌려줍니다."""
    if len(parts) < 3:
        return None, "출발역, 도착역, 날짜는 꼭 필요합니다.\n예) /watch 서울 부산 0923 0928"

    dep = kw.clean_station(parts[0])
    arr = kw.clean_station(parts[1])
    if dep == arr:
        return None, "출발역과 도착역이 같습니다."

    date = kw.clean_date(parts[2])
    rest = [x.lower() for x in parts[3:]]

    reserve = "reserve" in rest
    rest = [x for x in rest if x != "reserve"]

    at, until, allday = set(), "", True
    from_time = "000000"

    if rest:
        spec = rest[0]
        if spec in ("all", "전체"):
            pass
        elif "-" in spec:                       # 0900-1200 형태
            a, _, b = spec.partition("-")
            from_time = (kw.to_hhmm(a) or "0000") + "00"
            until = kw.to_hhmm(b)
        else:                                   # 0928 형태 (여러 개는 쉼표)
            at = {kw.to_hhmm(x) for x in spec.split(",")}
            at.discard("")
            if not at:
                return None, f"시간을 알아볼 수 없습니다: {spec}"
            from_time = min(at) + "00"
            allday = False                      # 그 시각부터 한 번만 조회하면 됩니다

    return {"dep": dep, "arr": arr, "date": date, "from_time": from_time,
            "at": at, "until": until, "allday": allday, "reserve": reserve}, ""


def main() -> int:
    print(f"*** ktx_bot.py 버전: {SCRIPT_VERSION} ***\n")
    kw.load_secrets()

    token = os.environ.get("KSKILL_TELEGRAM_TOKEN", "")
    owner = os.environ.get("KSKILL_TELEGRAM_CHAT_ID", "")
    korail_id = os.environ.get("KSKILL_KTX_ID", "")
    korail_pw = os.environ.get("KSKILL_KTX_PASSWORD", "")

    missing = [n for n, v in [("KSKILL_TELEGRAM_TOKEN", token),
                              ("KSKILL_TELEGRAM_CHAT_ID", owner),
                              ("KSKILL_KTX_ID", korail_id),
                              ("KSKILL_KTX_PASSWORD", korail_pw)] if not v]
    if missing:
        print("[중단] secrets.env 에 아래 값이 없습니다:")
        for name in missing:
            print(f"       {name}")
        print("\n       python ktx_watch.py --telegram-setup 으로 chat_id 를 찾을 수 있습니다.")
        return 1

    def say(text: str) -> None:
        ok, why = kw.telegram_send(token, owner, text)
        if not ok:
            print(f"[알림 실패] {why}")

    try:
        from korail2 import Korail
    except ImportError:
        print("[중단] korail2 가 없습니다. python -m pip install korail2-ncard pycryptodome")
        return 1

    print("코레일에 로그인합니다...")
    try:
        korail = Korail(korail_id, korail_pw)
    except Exception as exc:
        name = type(exc).__name__
        print(f"[중단] 로그인 실패: {name}: {exc}")
        print(explain_login_error(name))
        # 화면에만 남기면 서버를 안 볼 때 알 수가 없습니다. 휴대폰으로도 알립니다.
        say(f"[봇이 뜨지 못했습니다]\n로그인 실패: {name}\n\n{explain_login_error(name)}")
        # 종료코드 2 = "다시 띄우지 마세요". 서비스 파일의
        # RestartPreventExitStatus=2 가 이걸 보고 재시도를 멈춥니다.
        # 로그인을 거부당한 상태에서 30초마다 두드리면 안 됩니다.
        return 2
    print("로그인 성공.\n")

    if sys.platform == "win32":
        kw.prevent_sleep(True)
        kw.disable_quick_edit()

    watcher: Watcher | None = None
    say(f"봇이 켜졌습니다. 명령을 기다립니다.\n\n{HELP}")
    print("텔레그램 명령을 기다립니다. 멈추려면 Ctrl+C.\n")

    offset = None
    while True:
        try:
            params = {"timeout": POLL_TIMEOUT}
            if offset is not None:
                params["offset"] = offset
            result = kw.telegram_call(token, "getUpdates", params,
                                      timeout=POLL_TIMEOUT + kw.TELEGRAM_TIMEOUT)
        except Exception as exc:
            # 네트워크가 잠깐 끊긴 것일 수 있습니다. 조금 쉬고 다시 시도합니다.
            print(f"[알림] 텔레그램 수신 실패: {kw.scrub(str(exc), token)}")
            time.sleep(5)
            continue

        for update in result.get("result", []):
            offset = update["update_id"] + 1
            msg = update.get("message") or {}
            chat_id = str((msg.get("chat") or {}).get("id", ""))
            text = (msg.get("text") or "").strip()
            if not text:
                continue

            # 허락된 사람만 조종할 수 있습니다. 나머지는 답도 하지 않습니다.
            if chat_id != owner:
                print(f"[무시] 허용되지 않은 chat_id {chat_id}: {text[:40]}")
                continue

            parts = text.split()
            cmd = parts[0].lower().split("@")[0]
            args = parts[1:]
            print(f"[명령] {text}")

            if cmd in ("/start", "/help"):
                say(HELP)

            elif cmd == "/status":
                if watcher and watcher.alive():
                    say("감시 중입니다.\n\n" + watcher.describe())
                else:
                    say("감시 중인 작업이 없습니다.\n\n/watch 로 시작하세요.")

            elif cmd == "/stop":
                if watcher and watcher.alive():
                    watcher.stop()
                    say("중단 요청을 보냈습니다.")
                else:
                    say("감시 중인 작업이 없습니다.")

            elif cmd == "/watch":
                if watcher and watcher.alive():
                    say("이미 감시 중입니다. 먼저 /stop 하세요.\n\n" + watcher.describe())
                    continue
                spec, err = parse_watch(args)
                if err:
                    say(err)
                    continue
                watcher = Watcher(korail, spec, say)
                # 시작 알림을 먼저 보냅니다. 첫 조회에서 바로 자리를 찾으면
                # "예약 성공" 이 "시작했습니다" 보다 먼저 도착할 수 있습니다.
                say("감시를 시작했습니다.\n\n" + watcher.describe())
                watcher.start()

            else:
                say(f"모르는 명령입니다: {cmd}\n\n{HELP}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n[종료] 사용자가 중단했습니다.")
        sys.exit(130)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
    finally:
        kw.prevent_sleep(False)
