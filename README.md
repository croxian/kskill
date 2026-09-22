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
| `ktx_watch.py` 알림 | `KSKILL_TELEGRAM_TOKEN`, `KSKILL_TELEGRAM_CHAT_ID` | 텔레그램 @BotFather (선택) |
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

### 텔레그램 알림

자리를 찾거나 예약에 성공하면 휴대폰으로 알려줍니다. PC 앞에 없어도 됩니다.

**1. 봇 만들기** — 텔레그램에서 `@BotFather` 검색 → 대화 시작 → `/newbot` →
이름과 아이디를 정하면 토큰을 줍니다.

**2. 토큰 저장** — `secrets.env` 에 추가합니다.

```
KSKILL_TELEGRAM_TOKEN=받은토큰
```

**3. 봇에게 말 걸기** — 방금 만든 봇을 찾아 아무 말이나 한 마디 보냅니다.
이걸 안 하면 봇이 먼저 말을 걸 수 없습니다.

**4. chat_id 찾기**

```bash
python ktx_watch.py --telegram-setup
```

출력된 `KSKILL_TELEGRAM_CHAT_ID=...` 줄을 `secrets.env` 에 추가합니다.

**5. 확인**

```bash
python ktx_watch.py --telegram-test
```

휴대폰에 메시지가 오면 끝입니다. 이후 감시는 평소대로 실행하면 됩니다.

| 언제 | 보내는 내용 |
|---|---|
| 빈자리 발견 (알림 모드) | 열차 목록 + 바로 예매하라는 안내 |
| 예약 성공 (`--reserve`) | 예약번호 + **10분 안에 결제** 경고 |
| 예약 실패 | 실패 사유 |
| 에러 3회로 중단 | 마지막 오류 |

알림이 실패해도 감시와 예약은 그대로 진행되고, 결과는 화면에 남습니다.
잠시 끄려면 `--no-telegram` 을 붙이세요.

## ktx_bot.py — 텔레그램으로 조종하기

PC 에서 봇을 한 번 켜 두면, 이후에는 밖에서 휴대폰으로 감시를 걸고 끄고
확인할 수 있습니다. cmd 를 다시 만질 필요가 없습니다.

먼저 위의 **텔레그램 알림** 설정(1~5단계)을 끝내야 합니다. 같은 토큰과
chat_id 를 씁니다.

```bash
python ktx_bot.py     # PC 에서 켜 두고 그대로 둡니다
```

이후 휴대폰 텔레그램에서:

| 명령 | 하는 일 |
|---|---|
| `/watch 서울 부산 0923 0928` | 09:28 열차만 감시 |
| `/watch 서울 부산 0923 all` | 하루 전체 |
| `/watch 서울 부산 0923 0900-1200` | 구간 |
| `/watch 서울 부산 0923 0928 reserve` | 찾으면 예약까지 (결제는 안 함) |
| `/status` | 지금 무엇을 감시 중인지, 몇 회 조회했는지 |
| `/stop` | 중단 |
| `/help` | 도움말 |

날짜는 `0923` 또는 `20260923`, 역 이름은 `서울역` 처럼 적어도 됩니다.
시간을 생략하면 하루 전체입니다.

### 보안

**봇은 `secrets.env` 에 적힌 `KSKILL_TELEGRAM_CHAT_ID` 하나만 받아들입니다.**
텔레그램 봇 아이디는 누구나 검색해 말을 걸 수 있으므로, 다른 사람이 보낸
명령은 답장도 하지 않고 무시합니다. 무시한 내역은 PC 화면에만 남습니다.

```
[무시] 허용되지 않은 chat_id 999: /watch ...
```

명령은 정해진 목록만 받습니다. 봇이 임의의 명령을 실행하지 않습니다.

### 제한

- 감시는 **한 번에 하나만** 돕니다. 새로 걸려면 `/stop` 먼저.
- 조회 간격 30초(하루 전체는 60초), 최대 12시간. `ktx_watch.py` 와 같습니다.
- PC 가 꺼지거나 봇을 닫으면 감시도 멈춥니다. 휴대폰이 대신 돌리는 게
  아니라, PC 에게 시키는 리모컨입니다.

## 클라우드 서버에 올리기

PC 를 아예 안 켜도 되게 하려면 서버에 올립니다. 봇이 24시간 떠 있고,
휴대폰으로만 조종합니다.

### 먼저 알아둘 것

- **코레일이 해외 IP 나 데이터센터 IP 를 어떻게 대하는지 저는 모릅니다.**
  차단될 수도, 아무 문제 없을 수도 있습니다. **한국 리전**(서울/춘천)을
  고르면 위험이 줄어듭니다. 해외 리전은 피하세요.
- 무료로 쓰려면 Oracle Cloud Free Tier 가 현실적입니다. 가입에 카드 등록이
  필요하고(과금은 안 됨), ARM 인스턴스는 자리가 없을 때가 잦습니다.
- 유료로 편하게 가려면 국내 VPS 나 Vultr 서울 리전이 월 5~6천원 수준입니다.

### 1. 서버 만들기

Oracle Cloud 기준입니다.

| 항목 | 고를 값 |
|---|---|
| Region | **South Korea Central (Chuncheon)** 또는 Seoul |
| Image | Ubuntu 24.04 |
| Shape | VM.Standard.A1.Flex (Always Free) — 1 OCPU / 6GB 면 충분 |
| SSH key | **새로 생성해서 개인키를 내려받으세요** |

비밀번호 로그인은 쓰지 마세요. SSH 키만 씁니다.

### 2. 접속하기

Windows PowerShell 에서 (cmd 아님):

```powershell
ssh -i C:\Users\user\Downloads\받은키.key ubuntu@서버IP
```

`Permissions ... too open` 오류가 나면:

```powershell
icacls C:\Users\user\Downloads\받은키.key /inheritance:r /grant:r "$env:USERNAME:R"
```

### 3. 설치

서버에 접속한 상태에서 그대로 붙여넣으세요.

```bash
sudo apt-get update && sudo apt-get install -y git
git clone -b claude/intelligent-meitner-0i7sgd https://github.com/croxian/kskill.git
cd kskill
sudo bash deploy/setup-ubuntu.sh
```

하는 일: 파이썬 설치 → 로그인 불가능한 전용 계정 `ktxbot` 생성 →
`/opt/ktx-bot` 에 파일 배치 → 가상환경에 `korail2-ncard` 설치 →
비밀 파일 양식 생성(권한 600) → systemd 서비스 등록.

여러 번 실행해도 안전하고, **채워둔 비밀 파일은 절대 덮어쓰지 않습니다.**

### 4. 비밀 값 채우기

```bash
sudo nano /opt/ktx-bot/.config/k-skill/secrets.env
```

네 줄을 채우고 `Ctrl+O` → `Enter` → `Ctrl+X`.

```
KSKILL_KTX_ID=코레일아이디
KSKILL_KTX_PASSWORD=비밀번호
KSKILL_TELEGRAM_TOKEN=봇토큰
KSKILL_TELEGRAM_CHAT_ID=내chat_id
```

### 5. 시작

```bash
sudo systemctl start ktx-bot
sudo systemctl status ktx-bot      # active (running) 이면 성공
```

텔레그램에 "봇이 켜졌습니다" 가 오면 끝입니다. 이제 휴대폰에서
`/watch` 로 조종하세요. PC 는 꺼도 됩니다.

### 코드는 어디서 고치나

파일이 세 군데 있습니다. 헷갈리기 쉬운 부분입니다.

| 위치 | 역할 |
|---|---|
| 내 PC 바탕화면 | 로컬 테스트용. **서버와 무관** |
| 서버 `~/kskill/` | git 으로 받은 **원본**. 여기서 고칩니다 |
| 서버 `/opt/ktx-bot/` | 실제로 도는 **복사본**. 직접 고치지 마세요 |

설치 스크립트가 `~/kskill/` → `/opt/ktx-bot/` 으로 복사합니다. 그래서
`~/kskill/` 만 고치면 서버 동작은 그대로입니다. 반드시 반영 과정이 필요합니다.

**갱신은 한 줄로 끝납니다.**

```bash
cd ~/kskill && bash deploy/update.sh
```

최신 코드 받기 → `/opt/ktx-bot` 반영 → 봇 재시작까지 합니다. `sudo` 를 앞에
붙이지 마세요. 필요한 부분에서만 알아서 씁니다.

직접 고친 파일이 있으면 받아오기 전에 멈추고 알려줍니다.

```
이 폴더에서 직접 고친 파일이 있습니다:
  ktx_watch.py

  내 수정을 살리려면 : git stash
  내 수정을 버리려면 : git checkout .
```

**급할 때만** 쓰는 방법 — 도는 파일을 바로 고치기:

```bash
sudo nano /opt/ktx-bot/ktx_watch.py
sudo systemctl restart ktx-bot
```

빠르지만 **다음에 `update.sh` 를 돌리면 덮어써집니다.** 상수 하나 바꿔
시험해 볼 때만 쓰고, 계속 남길 수정은 `~/kskill/` 에서 하세요.

### 운영

```bash
sudo journalctl -u ktx-bot -f      # 실시간 로그 (Ctrl+C 로 빠져나오기)
sudo systemctl restart ktx-bot     # 다시 시작
sudo systemctl stop ktx-bot        # 멈추기
sudo systemctl disable ktx-bot     # 재부팅 시 자동 시작 끄기
```

코드가 바뀌었을 때 갱신 (위 "코드는 어디서 고치나" 참고):

```bash
cd ~/kskill && bash deploy/update.sh
```

### 보안

- 봇은 **받는 포트가 없습니다.** 텔레그램으로 나가기만 합니다. 방화벽을
  열 필요가 없고, 밖에서 서버로 들어올 경로도 없습니다.
- 전용 계정 `ktxbot` 은 로그인이 불가능하고, systemd 설정에서 읽기·쓰기를
  `/opt/ktx-bot` 으로 제한했습니다.
- 비밀 파일은 권한 600, 해당 계정만 읽습니다.
- 봇은 `secrets.env` 의 chat_id 하나에서 온 명령만 받습니다.
- 죽으면 30초 뒤 자동으로 되살아나고, 재부팅해도 자동으로 켜집니다.

### 감시 중 멈출 때

`[알림] 대기 중 N초 동안 멈춰 있었습니다` 가 뜨면 프로그램이 얼어붙은 것입니다.
조회가 느린 것과는 다릅니다.

가장 흔한 원인은 명령 프롬프트의 **빠른 편집 모드**입니다. 창을 클릭하면
제목에 `선택` 이 붙으면서 프로그램이 통째로 멈추고, Esc 나 Enter 를 눌러야
다시 돕니다. 스크립트가 시작할 때 이 모드를 끄려고 시도하지만, 실패하면
`[설정] 빠른 편집 끔: 실패` 라고 알려줍니다.

직접 끄시려면 명령 프롬프트 제목 표시줄 우클릭 → 속성 →
**빠른 편집 모드** 체크 해제.

절전도 막습니다(`SetThreadExecutionState`). 실패하면 그것도 알려주니
Windows 전원 설정에서 직접 바꾸세요.

`(이번 조회에 N초 걸렸습니다)` 는 다른 문제입니다. 그건 코레일 서버가
느린 것이고, 프로그램은 정상입니다.

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
