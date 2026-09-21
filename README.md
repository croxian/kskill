# kskill

[NomaDamas/k-skill](https://github.com/NomaDamas/k-skill) 설치와 초기 설정을 한 번에
재현하기 위한 스크립트입니다. 새 머신이나 새 컨테이너에서 같은 상태를 다시 만들 때 씁니다.

## 사용법

```bash
./setup-k-skill.sh              # 전체: 설치 + credential 파일 + 검증
./setup-k-skill.sh --verify     # 설치 없이 현재 상태만 점검
./setup-k-skill.sh --no-python  # SRT/KTX 파이썬 의존성 설치 생략
```

## 하는 일

1. **사전 요구사항 확인** — Node.js 18+, `npx`, (예매 스킬용) Python 3.10+
2. **전체 스킬 설치** — `npx --yes skills add NomaDamas/k-skill --all -g` 로 122개 스킬을
   `~/.claude/skills/` 에 전역 설치
3. **Python 의존성** — `SRTrain`(SRT), `korail2-ncard` + `pycryptodome`(KTX). 이미 있으면 건너뜀
4. **credential 파일** — `~/.config/k-skill/secrets.env` 를 퍼미션 `0600` 으로 준비.
   **기존 파일은 절대 덮어쓰지 않습니다**
5. **검증** — 퍼미션, 채워진 키 이름, `k-skill-proxy` 도달 가능 여부

멱등합니다. 여러 번 실행해도 안전합니다.

## credential

대부분의 조회 스킬은 **키가 전혀 필요 없습니다.** 날씨, 미세먼지, 법령 검색, 부동산 실거래가,
주식, 도서관, 지하철, 급식 등은 hosted proxy(`k-skill-proxy.nomadamas.org`)를 경유하고
API 키는 프록시 서버 쪽에서 관리합니다.

값이 필요한 것은 본인 계정으로 로그인해야 하는 스킬뿐입니다.

| 스킬 | 필요한 값 | 발급처 |
|---|---|---|
| `srt-booking` | `KSKILL_SRT_ID`, `KSKILL_SRT_PASSWORD` | [etk.srail.kr](https://etk.srail.kr) 계정 |
| `ktx-booking` | `KSKILL_KTX_ID`, `KSKILL_KTX_PASSWORD` | [letskorail.com](https://www.letskorail.com) 계정 |

`~/.config/k-skill/secrets.env` 를 **직접 편집해서** 채우세요.

```
KSKILL_SRT_ID=your-id
KSKILL_SRT_PASSWORD=your-password
```

필요해지면 아래 값도 같은 파일에 추가할 수 있습니다.

| 스킬 | 값 | 비고 |
|---|---|---|
| `korean-patent-search` | `KIPRIS_PLUS_API_KEY` | [plus.kipris.or.kr](https://plus.kipris.or.kr) 에서 발급 |
| `keris-academic-search` | `KSKILL_RISS_API_KEY` | 비영리 기관·대학에만 발급 |
| `k-dart` | `API_K_DART` | [opendart.fss.or.kr](https://opendart.fss.or.kr) 무료 발급 |

### 보안

- 이 파일은 퍼미션 `0600`, 소유자만 읽기 가능해야 합니다. 스크립트가 매번 강제합니다.
- `.gitignore` 가 `secrets.env` 와 `.env` 를 막고 있습니다. 커밋하지 마세요.
- 스크립트는 값이 **채워진 키 이름만** 출력하고 값 자체는 절대 출력하지 않습니다.
- 1Password CLI, Bitwarden CLI, macOS Keychain 등을 이미 쓰신다면 그쪽에서 꺼내
  환경변수로 주입해도 됩니다. dotenv 파일은 fallback일 뿐 강제가 아닙니다.

## 네트워크 요구사항

스킬이 동작하려면 아래 호스트로 나가는 HTTPS 가 열려 있어야 합니다.

| 호스트 | 용도 |
|---|---|
| `k-skill-proxy.nomadamas.org` | 조회 스킬 대부분의 기본 경로 |
| `registry.npmjs.org` | 스킬 설치 및 `npx` 헬퍼 실행 |
| `pypi.org`, `files.pythonhosted.org` | SRT/KTX 파이썬 패키지 |
| `etk.srail.kr`, `www.letskorail.com` | 예매 스킬 상류 |
| `apis.data.go.kr` | `--direct` 호출을 쓸 때만 |

> **Claude Code on the web 사용 시 주의.** 기본 네트워크 정책은 allowlist 방식이라
> GitHub 과 패키지 레지스트리만 열려 있고 위 호스트 대부분이 차단됩니다. 원격 세션에서
> 스킬을 쓰려면 환경 설정에서 해당 도메인을 허용 목록에 추가해야 합니다.
> 참고: https://code.claude.com/docs/en/claude-code-on-the-web

`./setup-k-skill.sh --verify` 로 도달 가능 여부를 바로 확인할 수 있습니다.

## 설치 후

```bash
# 개별 스킬의 최신 사용법 (설치된 SKILL.md 는 stub 이고, 실제 지침은 CLI 가 출력합니다)
npx -y @nomadamas/k-skill@0 instruct srt-booking

# 설치된 스킬 목록
ls ~/.claude/skills
```

안 쓰는 스킬이 많아지면 `k-skill-cleaner` 스킬로 정리할 수 있습니다.

## 참고

- 설치 로그에 `Eve does not support global skill installation` 같은 ✗ 줄이 나오는 것은
  정상입니다. 다른 에이전트 대상 항목이고 Claude Code 설치와는 무관합니다.
- 설치되는 스킬은 전체 에이전트 권한으로 실행됩니다. 처음 쓰는 스킬은 한 번 훑어보세요.

## ktx_watch.py — KTX 빈자리 감시

본인이 탈 표를 잡기 위한 개인용 감시 스크립트입니다. `ktx-booking` 스킬과 같은
`korail2-ncard` 라이브러리를 씁니다.

```bash
python -m pip install korail2-ncard pycryptodome

# 가장 간단한 방법 — 그냥 실행하면 하나씩 물어봅니다
python ktx_watch.py

# 익숙해지면 한 줄로
python ktx_watch.py --dep 서울 --arr 부산 --date 20260925 --time 060000

# 예약까지 시도 (결제는 하지 않습니다)
python ktx_watch.py --dep 서울 --arr 부산 --date 20260925 --time 060000 --reserve
```

물어볼 때 그냥 엔터를 치면 `[]` 안의 기본값을 씁니다. 입력은 알아서 다듬으니
편한 대로 적으세요.

| 적어도 되는 것 | 실제로 쓰이는 값 |
|---|---|
| `서울역`, `서울` | `서울` |
| `2026-09-25`, `2026.09.25`, `0925` | `20260925` |
| `6`, `06`, `0600`, `06:30` | `060000`, `063000` |

날짜를 비우면 **내일**, 시각을 비우면 **첫차부터**입니다.

### 중요: `--allday` 를 붙이세요

`search_train` 은 **지정한 시각부터 10여 대만** 돌려줍니다. 시각을 비우고 돌리면
새벽 첫차 근처만 보고 "전부 매진"이라고 나옵니다. 낮 열차는 조회조차 안 됩니다.

```bash
python ktx_watch.py --dep 서울 --arr 부산 --date 20260925 --allday
```

`--allday` 는 첫차부터 끝차까지 훑습니다. 대신 한 번에 여러 번 요청하므로
조회 간격이 자동으로 **60초**로 올라갑니다.

| 옵션 | 뜻 |
|---|---|
| `--allday` | 하루 전체. 안 붙이면 지정 시각부터 10여 대만 |
| `--time 0900` | 이 시각 이후 열차 |
| `--at 0928` | 이 시각에 출발하는 열차만. 쉼표로 여러 개 (`0928,1018`) |
| `--until 1200` | 이 시각까지. `--time` 과 같이 쓰면 구간 |
| `--ktx-only` | KTX 만. 안 붙이면 ITX-새마을, 무궁화도 함께 |
| `--reserve` | 예약까지 시도 (결제는 안 함) |

### 시간대 세 가지로 좁히기

```bash
# 1. 날짜 전체
python ktx_watch.py --dep 서울 --arr 부산 --date 20260923 --allday

# 2. 특정 시각 이후
python ktx_watch.py --dep 서울 --arr 부산 --date 20260923 --time 0900

# 3. 특정 시각만 (그 열차 하나만 노릴 때)
python ktx_watch.py --dep 서울 --arr 부산 --date 20260923 --at 0928

# 구간으로 (09:00 ~ 12:00)
python ktx_watch.py --dep 서울 --arr 부산 --date 20260923 --time 0900 --until 1200 --allday
```

`--at` 은 그 시각부터 조회를 시작하므로 **요청 한 번**이면 끝납니다.
`--allday` 는 한 번에 10여 회 요청하니, 노리는 열차가 정해져 있으면
`--at` 이 훨씬 가볍고 빠릅니다.

### 왜 간격을 5초로 못 줄이나

`MIN_INTERVAL_SEC` 은 30초로 고정되어 있고 명령줄로 못 내립니다.
7.5초 간격이면 시간당 480회, `--allday` 와 같이 쓰면 시간당 4,800회입니다.
개인이 표 한 장 잡으려고 보낼 양이 아니고, 계정이 막히는 가장 빠른 길입니다.

노리는 열차를 `--at` 으로 좁히는 편이 실제로 더 효과적입니다.
요청 한 번에 원하는 열차만 보므로, 30초 간격이어도 `--allday` 5초 간격보다
그 열차에 대해서는 반응이 빠릅니다.

### 안 될 때

```bash
python check_ktx.py        # 진짜 매진인지, 환경 문제인지 가려냅니다
python check_waitlist.py   # 하루 전체 좌석 현황 + 예약대기 가능 여부
```

`NoResultsError` 가 나면 `check_ktx.py` 를 돌려 보세요. 파이썬/라이브러리 경로,
`korail2` 중복 설치, 로그인 성공 여부를 확인하고 매진 포함 조회까지 해 봅니다.

`check_waitlist.py` 는 하루 전체를 훑어 어느 열차에 자리가 있는지, 예약대기를
걸 수 있는지 보여줍니다. 둘 다 **조회만 하고 예매는 하지 않습니다.**

### 예약대기가 되면 그쪽이 낫습니다

빈자리가 없어도 **예약대기(waiting list)** 를 걸 수 있는 열차가 있습니다.
코레일이 운영하는 공식 대기열이라, 30초마다 두드리는 것보다 확실하고 안전합니다.
`check_waitlist.py` 가 `[예약대기]` 로 표시해 주면 **코레일톡 앱에서 신청하세요.**

아이디/비밀번호는 `~/.config/k-skill/secrets.env` 의 `KSKILL_KTX_ID`,
`KSKILL_KTX_PASSWORD` 에서 읽습니다. 스크립트에 직접 적지 마세요.

### 코드에 박혀 있는 안전장치

| 항목 | 값 | 비고 |
|---|---|---|
| 조회 간격 | 30초 이상 | `--interval` 로 더 짧게 줘도 30초로 올라갑니다 |
| 총 실행 시간 | 12시간 이하 | `--minutes` 로 더 길게 줘도 720분에서 잘립니다 |
| 연속 에러 | 3회면 중단 | 에러 상태로 계속 두드리지 않습니다 |
| 로그인 | 시작할 때 1회 | 매 조회마다 다시 로그인하지 않습니다 |
| 예약 성공 시 | 즉시 종료 | 필요 이상으로 잡지 않습니다 |

### 지켜야 할 것

- **본인이 실제로 탈 표만** 예약하세요. 되팔이 목적의 매크로 예매는 한국에서 법적
  문제가 됩니다.
- **계정 하나, 실행 하나.** 창을 여러 개 띄우거나 다계정을 쓰면 위 안전장치가
  전부 무의미해집니다.
- 간격을 짧게 만들려고 `MIN_INTERVAL_SEC` 을 고치지 마세요. 계정이 막히는
  지름길입니다.
- 코레일 이용약관의 자동화 프로그램 관련 조항을 한 번 직접 읽어보시길 권합니다.
- 코레일톡 앱에 공식 "예약대기" 기능이 있다면 그쪽이 더 안전하고 확실합니다.
  앱에서 먼저 확인해 보세요.

### 결제는 자동이 아닙니다

`--reserve` 는 **예약만** 합니다. 코레일 예약은 보통 10분 안에 직접 결제해야
유지됩니다. 예약이 잡히면 코레일톡 앱에서 결제하세요.
