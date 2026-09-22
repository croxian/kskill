# -*- coding: utf-8 -*-
"""
ktx_watch.py - KTX 빈자리 감시 (개인용)

본인이 탈 표 한 장을 잡기 위한 도구입니다.
서버에 부담을 주지 않도록 조회 간격과 총 실행 시간을 코드 안에서 강제합니다.

기본 동작은 "감시 + 알림"입니다. 자리를 찾으면 소리를 내고 멈춥니다.
--reserve 를 붙였을 때만 예약까지 시도하고, 결제는 하지 않습니다.
(코레일 예약은 보통 10분 안에 직접 결제해야 유지됩니다. 앱에서 결제하세요.)

주의: search_train 은 지정한 시각부터 10여 대만 돌려줍니다. 하루 전체를 보려면
--allday 를 붙이세요. 안 붙이면 첫차 근처만 보고 "전부 매진"처럼 보입니다.

사용 예:
    python ktx_watch.py
    python ktx_watch.py --dep 서울 --arr 부산 --date 20260925 --allday
    python ktx_watch.py --dep 서울 --arr 부산 --date 20260925 --time 060000 --ktx-only
"""

from __future__ import annotations

import argparse
import datetime as dt
import inspect
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# 안전장치. 명령줄로 더 공격적으로 바꿀 수 없도록 여기서 못을 박아 둡니다.
# ---------------------------------------------------------------------------
SCRIPT_VERSION = "2026-09-22a"

MIN_INTERVAL_SEC = 30      # 조회 간격의 하한. 이보다 짧게는 절대 돌지 않습니다.
MIN_INTERVAL_ALLDAY = 60   # --allday 는 한 번에 여러 번 요청하므로 더 길게 잡습니다.
MAX_RUNTIME_MIN = 720      # 총 실행 시간의 상한(12시간). 더 필요하면 다시 실행하세요.
MAX_CONSECUTIVE_ERRORS = 3  # 에러가 이만큼 연달아 나면 멈춥니다.


def load_secrets() -> None:
    """~/.config/k-skill/secrets.env 를 읽어 환경변수로 올립니다.

    파일이 없으면 조용히 넘어갑니다. 이미 환경변수가 있으면 덮어쓰지 않습니다.
    (Windows 에서 Path.home() 은 C:\\Users\\사용자이름 입니다.)
    """
    path = Path.home() / ".config" / "k-skill" / "secrets.env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


TELEGRAM_TIMEOUT = 10   # 초. 알림이 안 가도 감시는 계속돼야 합니다.


def telegram_call(token: str, method: str, params: dict) -> dict:
    """텔레그램 API 를 부릅니다. 실패하면 예외를 던집니다."""
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params).encode("utf-8")
    with urllib.request.urlopen(url, data=data, timeout=TELEGRAM_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def scrub(text: str, token: str) -> str:
    """오류 메시지에 토큰이 섞여 있으면 지웁니다."""
    if token and token in text:
        text = text.replace(token, "<토큰가림>")
    return text


def telegram_send(token: str, chat_id: str, text: str) -> tuple[bool, str]:
    """메시지를 보냅니다. (성공여부, 실패이유) 를 돌려줍니다.

    알림이 실패해도 감시나 예약은 절대 멈추지 않습니다.
    """
    if not token or not chat_id:
        return False, "토큰이나 chat_id 가 없습니다"
    try:
        result = telegram_call(token, "sendMessage", {"chat_id": chat_id, "text": text})
        if result.get("ok"):
            return True, ""
        return False, scrub(str(result.get("description", result)), token)
    except urllib.error.HTTPError as exc:
        # 본문에 이유가 들어 있습니다. 토큰은 절대 찍지 않습니다.
        try:
            body = json.loads(exc.read().decode("utf-8"))
            return False, scrub(str(body.get("description", exc)), token)
        except Exception:
            return False, f"HTTP {exc.code}"
    except Exception as exc:
        return False, scrub(f"{type(exc).__name__}: {exc}", token)


def telegram_setup(token: str) -> int:
    """봇에게 온 메시지를 읽어 chat_id 를 찾아 줍니다."""
    if not token:
        print("[중단] KSKILL_TELEGRAM_TOKEN 이 없습니다.\n")
        print("먼저 텔레그램에서 봇을 만드세요.")
        print("  1) 텔레그램에서 @BotFather 를 검색해 대화 시작")
        print("  2) /newbot 입력, 이름과 아이디를 정하면 토큰을 줍니다")
        print("  3) 그 토큰을 secrets.env 에 KSKILL_TELEGRAM_TOKEN= 으로 저장")
        return 1

    print("봇에게 온 메시지를 확인합니다...\n")
    try:
        result = telegram_call(token, "getUpdates", {})
    except Exception as exc:
        print(f"[실패] {scrub(f'{type(exc).__name__}: {exc}', token)}")
        print("       토큰이 맞는지, 인터넷이 되는지 확인하세요.")
        return 1

    if not result.get("ok"):
        print("[실패]", scrub(str(result.get("description", result)), token))
        return 1

    chats = {}
    for update in result.get("result", []):
        msg = update.get("message") or update.get("channel_post") or {}
        chat = msg.get("chat") or {}
        if chat.get("id") is not None:
            name = chat.get("title") or chat.get("first_name") or chat.get("username") or "?"
            chats[str(chat["id"])] = name

    if not chats:
        print("봇에게 온 메시지가 없습니다.")
        print("  1) 텔레그램에서 방금 만든 봇을 찾아 대화를 시작하세요")
        print("  2) 아무 말이나 한 마디 보내세요 (예: 안녕)")
        print("  3) 이 명령을 다시 실행하세요")
        return 1

    print("찾았습니다. 아래 값을 secrets.env 에 넣으세요.\n")
    for chat_id, name in chats.items():
        print(f"  KSKILL_TELEGRAM_CHAT_ID={chat_id}      ({name})")
    return 0


def prevent_sleep(keep_awake: bool = True) -> bool:
    """Windows 가 절전으로 들어가지 않게 막습니다. 성공하면 True.

    감시 중에 PC 가 자버리면 스크립트도 같이 멈춥니다. 마우스를 움직여
    깨우기 전까지는 조회가 안 나갑니다.
    """
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        ES_CONTINUOUS = 0x80000000
        ES_SYSTEM_REQUIRED = 0x00000001
        flags = ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if keep_awake else 0)
        return bool(ctypes.windll.kernel32.SetThreadExecutionState(flags))
    except Exception:
        return False


def disable_quick_edit() -> bool:
    """명령 프롬프트의 '빠른 편집' 을 끕니다. 성공하면 True.

    이게 켜져 있으면 창을 실수로 클릭하는 순간 프로그램이 통째로 멈춥니다.
    Enter 나 Esc 를 눌러야 다시 돕니다.
    """
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        STD_INPUT_HANDLE = -10
        ENABLE_QUICK_EDIT_MODE = 0x0040
        ENABLE_EXTENDED_FLAGS = 0x0080

        handle = kernel32.GetStdHandle(STD_INPUT_HANDLE)
        mode = wintypes.DWORD()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        new_mode = (mode.value & ~ENABLE_QUICK_EDIT_MODE) | ENABLE_EXTENDED_FLAGS
        return bool(kernel32.SetConsoleMode(handle, new_mode))
    except Exception:
        return False


def beep() -> None:
    """자리를 찾았을 때 소리를 냅니다. 실패해도 프로그램은 계속 갑니다."""
    try:
        if sys.platform == "win32":
            import winsound

            for _ in range(3):
                winsound.Beep(880, 300)
                time.sleep(0.1)
        else:
            print("\a", end="", flush=True)
    except Exception:
        pass


def keep_supported(fn, candidates: dict) -> dict:
    """fn 이 실제로 받는 인자만 남깁니다.

    search_train 과 search_train_allday 는 받는 인자가 서로 다릅니다.
    한쪽 기준으로 만든 인자를 다른 쪽에 그대로 넘기면 TypeError 가 납니다.
    """
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return dict(candidates)
    # **kwargs 를 받는 함수면 전부 통과시킵니다.
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(candidates)
    return {k: v for k, v in candidates.items() if k in params}


def clean_station(name: str) -> str:
    """역 이름을 다듬습니다. '서울역' 처럼 뒤에 '역'을 붙여도 받아줍니다."""
    name = name.strip()
    if len(name) > 2 and name.endswith("역"):
        name = name[:-1]
    return name


def clean_date(text: str) -> str:
    """날짜를 8자리로 맞춥니다. 2026-09-25, 2026.09.25, 0925 전부 받습니다."""
    digits = "".join(c for c in text if c.isdigit())
    if not digits:
        return (dt.date.today() + dt.timedelta(days=1)).strftime("%Y%m%d")
    if len(digits) == 4:
        return f"{dt.date.today().year}{digits}"   # 월일만 적으면 올해를 붙입니다
    return digits[:8]


def clean_time(text: str) -> str:
    """시각을 6자리로 맞춥니다. 6, 06, 0600, 06:00 전부 060000 이 됩니다."""
    digits = "".join(c for c in text if c.isdigit())
    if not digits:
        return "000000"
    if len(digits) % 2:               # 6 -> 06,  630 -> 0630
        digits = digits.zfill(len(digits) + 1)
    return digits.ljust(6, "0")[:6]   # 06 -> 060000,  0630 -> 063000


def to_hhmm(text: str) -> str:
    """시각을 4자리(HHMM)로 맞춥니다. 9, 09, 0930, 09:30 전부 받습니다."""
    digits = "".join(c for c in text if c.isdigit())
    if not digits:
        return ""
    if len(digits) % 2:
        digits = digits.zfill(len(digits) + 1)
    return digits.ljust(4, "0")[:4]


def ask(prompt: str, default: str = "") -> str:
    """물어보고 답을 받습니다. 그냥 엔터를 치면 기본값을 씁니다."""
    suffix = f" [{default}]" if default else ""
    return input(f"{prompt}{suffix}: ").strip() or default


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="KTX 빈자리 감시 (개인용). 인자 없이 실행하면 하나씩 물어봅니다."
    )
    p.add_argument("--dep", help="출발역. 예: 서울")
    p.add_argument("--arr", help="도착역. 예: 부산")
    p.add_argument("--date", help="날짜. 예: 20260925")
    p.add_argument("--time", help="이 시각 이후로 검색. 예: 060000")
    p.add_argument(
        "--interval",
        type=int,
        default=MIN_INTERVAL_SEC,
        help=f"조회 간격(초). {MIN_INTERVAL_SEC}초 미만은 {MIN_INTERVAL_SEC}초로 올립니다.",
    )
    p.add_argument(
        "--minutes",
        type=int,
        default=30,
        help=f"몇 분간 감시할지. 최대 {MAX_RUNTIME_MIN}분.",
    )
    p.add_argument(
        "--at",
        help="이 시각에 출발하는 열차만 봅니다. 쉼표로 여러 개. 예: 0928 또는 0928,1018",
    )
    p.add_argument(
        "--until",
        help="이 시각까지 출발하는 열차만 봅니다. --time 과 같이 쓰면 구간이 됩니다. 예: 1200",
    )
    p.add_argument(
        "--allday",
        action="store_true",
        help="첫차부터 끝차까지 하루 전체를 봅니다. 기본값은 지정 시각부터 10여 대뿐입니다.",
    )
    p.add_argument(
        "--ktx-only",
        action="store_true",
        help="KTX 만 봅니다. 기본값은 ITX-새마을, 무궁화 등도 함께 봅니다.",
    )
    p.add_argument(
        "--telegram-setup",
        action="store_true",
        help="텔레그램 chat_id 를 찾아 줍니다. 처음 한 번만 실행하세요.",
    )
    p.add_argument(
        "--telegram-test",
        action="store_true",
        help="텔레그램으로 테스트 메시지를 보내고 끝냅니다.",
    )
    p.add_argument(
        "--no-telegram",
        action="store_true",
        help="설정돼 있어도 텔레그램 알림을 보내지 않습니다.",
    )
    p.add_argument(
        "--reserve",
        action="store_true",
        help="자리를 찾으면 예약까지 시도합니다. 결제는 하지 않습니다.",
    )
    return p.parse_args()


def main() -> int:
    print(f"*** ktx_watch.py 버전: {SCRIPT_VERSION} ***")

    args = parse_args()
    load_secrets()

    tg_token = os.environ.get("KSKILL_TELEGRAM_TOKEN", "")
    tg_chat = os.environ.get("KSKILL_TELEGRAM_CHAT_ID", "")

    if args.telegram_setup:
        return telegram_setup(tg_token)

    tg_on = bool(tg_token and tg_chat) and not args.no_telegram

    def notify(text: str) -> None:
        """텔레그램으로 알립니다. 실패해도 진행에는 영향이 없습니다."""
        if not tg_on:
            return
        ok, why = telegram_send(tg_token, tg_chat, text)
        if not ok:
            print(f"[알림 실패] 텔레그램: {why}")

    if args.telegram_test:
        if not tg_token or not tg_chat:
            print("[중단] 토큰이나 chat_id 가 없습니다.")
            print("       python ktx_watch.py --telegram-setup 을 먼저 실행하세요.")
            return 1
        ok, why = telegram_send(tg_token, tg_chat, "KTX 감시 테스트 메시지입니다. 이게 보이면 설정 완료입니다.")
        print("전송 성공. 텔레그램을 확인하세요." if ok else f"전송 실패: {why}")
        return 0 if ok else 1

    # 명령줄로 안 준 값은 여기서 직접 물어봅니다.
    interactive = args.dep is None or args.arr is None or args.date is None
    if interactive:
        print("KTX 빈자리 감시. 그냥 엔터를 치면 [] 안의 값을 씁니다.\n")
    tomorrow = (dt.date.today() + dt.timedelta(days=1)).strftime("%Y%m%d")
    dep = clean_station(args.dep or ask("출발역", "서울"))
    arr = clean_station(args.arr or ask("도착역", "부산"))
    date = clean_date(args.date or ask("날짜 (예: 20260925)", tomorrow))
    if args.time is not None:
        depart_time = clean_time(args.time)
    elif interactive:
        depart_time = clean_time(ask("몇 시 이후 (예: 06)", "000000"))
    else:
        depart_time = "000000"

    if dep == arr:
        print("[중단] 출발역과 도착역이 같습니다.")
        return 1

    # 시간대 타겟. 셋 중 하나를 고르는 게 아니라 겹쳐 쓸 수 있습니다.
    #   1) 날짜 전체            : --allday
    #   2) 특정 시각 이후        : --time 0900
    #   3) 특정 시각만          : --at 0928  (또는 --time 0900 --until 1200 으로 구간)
    at_times = {to_hhmm(x) for x in args.at.split(",")} if args.at else set()
    at_times.discard("")
    until = to_hhmm(args.until) if args.until else ""

    # --at 을 쓰면 그 시각부터 조회해야 합니다. 안 그러면 첫차 근처만 보고 못 찾습니다.
    if at_times and not args.allday and args.time is None:
        depart_time = min(at_times) + "00"

    def in_target(train) -> bool:
        """이 열차가 내가 노리는 시간대에 드는지."""
        raw = getattr(train, "dep_time", None)
        if not raw:
            return True          # 출발시각을 못 읽으면 거르지 않습니다
        hhmm = str(raw)[:4]
        if at_times and hhmm not in at_times:
            return False
        if until and hhmm > until:
            return False
        return True

    korail_id = os.environ.get("KSKILL_KTX_ID")
    korail_pw = os.environ.get("KSKILL_KTX_PASSWORD")
    if not korail_id or not korail_pw:
        print("[중단] 아이디/비밀번호를 찾지 못했습니다.")
        print("       ~/.config/k-skill/secrets.env 에 아래 두 줄을 채워 주세요.")
        print("       KSKILL_KTX_ID=아이디")
        print("       KSKILL_KTX_PASSWORD=비밀번호")
        return 1

    try:
        from korail2 import Korail
    except ImportError:
        print("[중단] korail2 가 설치되어 있지 않습니다.")
        print("       python -m pip install korail2-ncard pycryptodome")
        return 1

    # 안전장치를 실제 값에 적용합니다.
    interval = max(args.interval, MIN_INTERVAL_SEC)
    minutes = min(args.minutes, MAX_RUNTIME_MIN)
    deadline = time.time() + minutes * 60

    print(f"\n[설정] {dep} -> {arr}  {date} {depart_time} 이후")
    print(f"[설정] {interval}초 간격으로 최대 {minutes}분간 감시합니다.")
    if at_times:
        print(f"[설정] 타겟: {', '.join(sorted(at_times))} 출발 열차만")
    elif until:
        print(f"[설정] 타겟: {depart_time[:4]} ~ {until} 출발 열차")
    elif args.allday:
        print("[설정] 타겟: 하루 전체")
    else:
        print(f"[설정] 타겟: {depart_time[:4]} 이후 열차 (앞쪽 10여 대)")
    print(f"[설정] 예약 시도: {'예' if args.reserve else '아니오 (알림만)'}")
    if tg_on:
        print("[설정] 텔레그램 알림: 켬")
    elif args.no_telegram:
        print("[설정] 텔레그램 알림: 끔 (--no-telegram)")
    else:
        print("[설정] 텔레그램 알림: 없음 (--telegram-setup 으로 설정하세요)")
    print("[안내] 멈추려면 Ctrl+C 를 누르세요.\n")

    # 로그인은 딱 한 번만 합니다. 반복할수록 서버에 부담이 됩니다.
    korail = Korail(korail_id, korail_pw)

    # 이 버전의 라이브러리가 뭘 지원하는지 시작할 때 한 번만 확인합니다.
    search_params = set(inspect.signature(Korail.search_train).parameters)
    supports_no_seats = "include_no_seats" in search_params
    supports_allday = hasattr(Korail, "search_train_allday")

    extra = {}
    if args.ktx_only:
        try:
            from korail2 import TrainType

            extra["train_type"] = TrainType.KTX
        except Exception:
            print("[알림] KTX 만 걸러내지 못했습니다. 전체 열차를 봅니다.")

    use_allday = args.allday and supports_allday
    if args.allday and not supports_allday:
        print("[알림] 이 버전은 하루 전체 조회를 지원하지 않습니다. 앞쪽 일부만 봅니다.")
    if use_allday:
        # 하루 전체 조회는 내부에서 여러 번 요청합니다. 간격을 더 벌립니다.
        interval = max(interval, MIN_INTERVAL_ALLDAY)
        print(f"[설정] 하루 전체를 봅니다. 요청이 많아 간격을 {interval}초로 올렸습니다.")

    # rich_mode: 매진까지 한 번에 받아와 직접 걸러내는 방식.
    # 요청 횟수는 그대로면서 "전체 몇 대 중 몇 대 빈자리"를 보여줄 수 있습니다.
    rich_mode = supports_no_seats

    def seat_state(train):
        """빈자리 여부. 판단할 수 없으면 None 입니다."""
        fn = getattr(train, "has_seat", None)
        if not callable(fn):
            return None
        try:
            return bool(fn())
        except Exception:
            return None

    def fetch():
        wanted = dict(extra)
        if rich_mode:
            wanted["include_no_seats"] = True
        fn = korail.search_train_allday if use_allday else korail.search_train
        # 함수마다 받는 인자가 다릅니다. 안 받는 건 빼고 부릅니다.
        return fn(dep, arr, date, depart_time, **keep_supported(fn, wanted))

    # 요청한 옵션이 실제로 먹는지 시작할 때 한 번 확인해 알려줍니다.
    _fn = korail.search_train_allday if use_allday else korail.search_train
    _wanted = dict(extra)
    if rich_mode:
        _wanted["include_no_seats"] = True
    _dropped = sorted(set(_wanted) - set(keep_supported(_fn, _wanted)))
    if _dropped:
        print(f"[알림] 이 함수가 안 받는 옵션은 무시됩니다: {', '.join(_dropped)}")

    # 감시 중에 PC 가 자거나 창 클릭으로 멈추는 것을 막습니다.
    if sys.platform == "win32":
        awake = prevent_sleep(True)
        quiet = disable_quick_edit()
        print(f"[설정] 절전 방지: {'켬' if awake else '실패 (전원 설정을 직접 바꾸세요)'}")
        print(f"[설정] 빠른 편집 끔: {'예' if quiet else '실패 (창을 클릭하지 마세요)'}")

    attempts = 0
    errors = 0
    last_cycle = None

    while time.time() < deadline:
        cycle_start = time.monotonic()

        # 지난 주기가 설정보다 크게 길었으면 뭔가 멈췄던 것입니다.
        if last_cycle is not None:
            gap = cycle_start - last_cycle
            if gap > interval * 2:
                print(f"[알림] 지난 주기가 {gap:.0f}초 걸렸습니다 (설정 {interval}초).")
        last_cycle = cycle_start

        attempts += 1
        stamp = time.strftime("%H:%M:%S")

        total = None
        fetch_start = time.monotonic()
        try:
            trains = fetch()
            errors = 0  # 성공했으니 에러 카운터를 되돌립니다.

            # 노리는 시간대만 남깁니다. 요청 수를 늘리지 않고 결과만 좁힙니다.
            trains = [t for t in trains if in_target(t)]

            if rich_mode:
                states = [seat_state(t) for t in trains]
                if trains and all(s is None for s in states):
                    # 빈자리 여부를 읽을 수 없는 버전입니다. 안전하게 옛 방식으로 돌아갑니다.
                    print("[알림] 좌석 상태를 읽지 못해 기본 조회 방식으로 바꿉니다.")
                    rich_mode = False
                    trains = [t for t in fetch() if in_target(t)]
                else:
                    total = len(trains)
                    trains = [t for t, s in zip(trains, states) if s]
        except Exception as exc:
            name = type(exc).__name__
            if name in ("NoResultsError", "SoldOutError"):
                # 매진입니다. 정상적인 상황이므로 에러로 세지 않습니다.
                trains = []
            else:
                errors += 1
                print(f"[{stamp}] {attempts}회 - 문제 발생: {name}: {exc}")
                if errors >= MAX_CONSECUTIVE_ERRORS:
                    print("\n[중단] 에러가 연달아 발생했습니다. 더 두드리지 않고 멈춥니다.")
                    print("       비밀번호, 역 이름, 날짜를 다시 확인해 주세요.")
                    notify(f"[KTX] 감시가 중단됐습니다\n{dep} -> {arr} {date}\n\n에러가 {MAX_CONSECUTIVE_ERRORS}회 연속 발생\n마지막 오류: {name}: {exc}")
                    return 1
                trains = []

        took = time.monotonic() - fetch_start
        if took > 15:
            print(f"    (이번 조회에 {took:.0f}초 걸렸습니다. 서버가 느립니다)")

        if not trains:
            # 라이브러리가 에러 대신 빈 목록을 주는 경우도 있어 여기서 한 번에 찍습니다.
            # 이 줄이 없으면 대기 중에 화면이 멈춘 것처럼 보입니다.
            if total:
                print(f"[{stamp}] {attempts}회 - 열차 {total}대 전부 매진")
            else:
                print(f"[{stamp}] {attempts}회 - 빈자리 없음")

        if trains:
            print(f"\n[{stamp}] 빈자리를 찾았습니다.")
            for t in trains:
                print(f"    {t}")
            beep()

            found = "\n".join(f"- {t}" for t in trains[:10])

            if not args.reserve:
                print("\n[완료] 코레일톡 앱에서 직접 예매하세요.")
                notify(f"[KTX] 빈자리를 찾았습니다\n{dep} -> {arr} {date}\n\n{found}\n\n코레일톡에서 바로 예매하세요.")
                return 0

            try:
                reservation = korail.reserve(trains[0])
            except Exception as exc:
                print(f"\n[실패] 예약이 되지 않았습니다: {type(exc).__name__}: {exc}")
                print("       한발 늦었을 수 있습니다. 앱에서 직접 확인해 보세요.")
                notify(f"[KTX] 빈자리는 찾았지만 예약에 실패했습니다\n{dep} -> {arr} {date}\n\n{found}\n\n사유: {type(exc).__name__}: {exc}")
                return 1

            # 예약은 됐습니다. 알림이 실패하더라도 이 사실은 반드시 화면에 남깁니다.
            print(f"\n[예약됨] {reservation}")
            print("[중요] 결제는 되지 않았습니다.")
            print("       코레일톡 앱에서 제한시간(보통 10분) 안에 결제하세요.")
            notify(
                "[KTX] 예약 성공!\n"
                f"{dep} -> {arr} {date}\n\n"
                f"{reservation}\n\n"
                "아직 결제가 안 됐습니다.\n"
                "코레일톡 앱에서 10분 안에 결제하세요.\n"
                "시간이 지나면 자동 취소됩니다."
            )
            return 0

        # 다음 조회까지 대기. 조회에 걸린 시간을 빼서 주기를 일정하게 맞춥니다.
        # (이걸 안 하면 "조회 6분 + 대기 30초" 가 되어 주기가 점점 늘어집니다)
        wait = interval - (time.monotonic() - cycle_start)
        if wait < 0:
            wait = 0
        if time.time() + wait >= deadline:
            break
        if wait:
            sleep_start = time.monotonic()
            time.sleep(wait)
            # sleep 은 정확합니다. 실제로 더 걸렸다면 프로세스가 멈춰 있던 겁니다.
            frozen = (time.monotonic() - sleep_start) - wait
            if frozen > 5:
                print(f"[알림] 대기 중 {frozen:.0f}초 동안 멈춰 있었습니다.")
                print("       조회가 느린 게 아니라 프로그램이 얼어붙은 것입니다.")
                print("       창 제목에 '선택' 이 떠 있었다면 빠른 편집 모드 때문입니다.")
                print("       창을 클릭하지 마시고, 클릭했다면 Esc 를 누르세요.")

    print(f"\n[종료] {minutes}분 동안 빈자리를 찾지 못했습니다. (총 {attempts}회 조회)")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n[종료] 사용자가 중단했습니다.")
        sys.exit(130)
    finally:
        prevent_sleep(False)   # 절전 방지를 원래대로 돌려놓습니다
