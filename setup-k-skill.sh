#!/usr/bin/env bash
#
# k-skill 설치 + 초기 설정 재현 스크립트
#
# NomaDamas/k-skill 전체 스킬을 전역 설치하고, credential 파일을 안전한
# 퍼미션으로 준비한 뒤, 런타임이 실제로 쓸 수 있는 상태인지 검증한다.
#
#   ./setup-k-skill.sh              전체 실행
#   ./setup-k-skill.sh --verify     설치 없이 현재 상태만 점검
#   ./setup-k-skill.sh --no-python  SRT/KTX 파이썬 의존성 설치 생략
#
# 이 스크립트는 기존 secrets 파일을 덮어쓰지 않으며, cron/launchd 같은
# 지속성 설정을 건드리지 않는다.

set -euo pipefail

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/k-skill"
SECRETS_FILE="$CONFIG_DIR/secrets.env"
PROXY_HOST="k-skill-proxy.nomadamas.org"

DO_INSTALL=1
DO_PYTHON=1

for arg in "$@"; do
  case "$arg" in
    --verify)    DO_INSTALL=0; DO_PYTHON=0 ;;
    --no-python) DO_PYTHON=0 ;;
    -h|--help)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

problems=0

# ---------------------------------------------------------------- 1. 사전 요구사항
step "1. 사전 요구사항"

if ! command -v node >/dev/null 2>&1; then
  fail "node 없음 — Node.js 18 이상이 필요합니다: https://nodejs.org"
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 18 ]; then
  fail "node $(node --version) — 18 이상이 필요합니다"
  exit 1
fi
ok "node $(node --version)"

command -v npx >/dev/null 2>&1 || { fail "npx 없음"; exit 1; }
ok "npx $(npx --version)"

if command -v python3 >/dev/null 2>&1; then
  ok "python3 $(python3 --version 2>&1 | awk '{print $2}')"
else
  warn "python3 없음 — SRT/KTX 예매 스킬은 Python 3.10+ 가 필요합니다"
fi

# ---------------------------------------------------------------- 2. 스킬 설치
if [ "$DO_INSTALL" -eq 1 ]; then
  step "2. k-skill 전체 스킬 설치"
  echo "  npx --yes skills add NomaDamas/k-skill --all -g"
  # Eve / PromptScript 대상 실패 줄은 정상입니다 — 그 둘은 전역 설치를 지원하지 않습니다.
  npx --yes skills add NomaDamas/k-skill --all -g
  ok "설치 완료"
else
  step "2. 스킬 설치 (--verify: 건너뜀)"
fi

# ---------------------------------------------------------------- 3. Python 의존성
if [ "$DO_PYTHON" -eq 1 ] && command -v python3 >/dev/null 2>&1; then
  step "3. 예매 스킬 Python 의존성"
  # SRT → SRTrain / KTX → korail2-ncard + pycryptodome
  if python3 -c 'import SRT' >/dev/null 2>&1; then
    ok "SRTrain 설치됨"
  else
    echo "  python3 -m pip install SRTrain"
    python3 -m pip install --quiet SRTrain && ok "SRTrain 설치 완료" \
      || { warn "SRTrain 설치 실패 — venv 또는 --user 로 재시도해 보세요"; problems=$((problems+1)); }
  fi
  if python3 -c 'import korail2' >/dev/null 2>&1; then
    ok "korail2 설치됨"
  else
    echo "  python3 -m pip install korail2-ncard pycryptodome"
    python3 -m pip install --quiet korail2-ncard pycryptodome && ok "korail2 설치 완료" \
      || { warn "korail2 설치 실패 — venv 또는 --user 로 재시도해 보세요"; problems=$((problems+1)); }
  fi
else
  step "3. Python 의존성 (건너뜀)"
fi

# ---------------------------------------------------------------- 4. credential 파일
step "4. credential 파일"

mkdir -p "$CONFIG_DIR"

if [ -f "$SECRETS_FILE" ]; then
  ok "이미 존재함 — 덮어쓰지 않습니다: $SECRETS_FILE"
else
  cat > "$SECRETS_FILE" <<'EOF'
# k-skill secrets
# 실제 값을 이 파일에 직접 채워 넣으세요. 값은 따옴표 없이 그대로 씁니다.
# 대부분의 조회 스킬은 hosted proxy 를 쓰므로 키가 전혀 필요 없습니다.

# --- SRT 예매 (srt-booking) ---
# SRT 홈페이지(etk.srail.kr) 계정. ID는 회원번호/이메일/휴대폰번호 중 하나.
KSKILL_SRT_ID=
KSKILL_SRT_PASSWORD=

# --- KTX / 코레일 예매 (ktx-booking) ---
# 레츠코레일(letskorail.com) 계정.
KSKILL_KTX_ID=
KSKILL_KTX_PASSWORD=

# --- self-host proxy 를 쓸 때만 채웁니다. 비워두면 hosted 기본값 사용. ---
KSKILL_PROXY_BASE_URL=
EOF
  ok "생성됨: $SECRETS_FILE"
fi

chmod 0600 "$SECRETS_FILE"
perms="$(stat -c '%a' "$SECRETS_FILE" 2>/dev/null || stat -f '%Lp' "$SECRETS_FILE" 2>/dev/null)"
if [ "$perms" = "600" ]; then
  ok "퍼미션 $perms"
else
  fail "퍼미션 $perms — 600 이어야 합니다"
  problems=$((problems+1))
fi

# 값이 채워진 키 이름만 보여준다. 값 자체는 절대 출력하지 않는다.
filled="$(grep -E '^[A-Z_]+=.+' "$SECRETS_FILE" | cut -d= -f1 | tr '\n' ' ' || true)"
if [ -n "$filled" ]; then
  ok "값이 채워진 항목: $filled"
else
  warn "아직 채워진 값이 없습니다 — 예매 스킬을 쓰려면 직접 편집하세요"
fi

# ---------------------------------------------------------------- 5. 연결성 검증
step "5. 연결성"

check_host() {
  local host="$1" label="$2"
  local code
  # curl 이 실패하면 -w 가 이미 000 을 출력하므로, 여기서 값을 덮어써 중복을 막는다.
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "https://$host" 2>/dev/null)" || code=000
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    fail "$label ($host) 도달 불가 — 방화벽/네트워크 정책을 확인하세요"
    return 1
  fi
  ok "$label ($host) 도달 가능 — HTTP $code"
  return 0
}

check_host "$PROXY_HOST" "k-skill-proxy" || problems=$((problems+1))

# ---------------------------------------------------------------- 결과
step "결과"

if [ "$problems" -eq 0 ]; then
  ok "k-skill setup looks usable"
else
  warn "$problems 개 항목을 확인하세요 (위의 ✗ / ! 참고)"
fi

cat <<EOF

다음 단계
  · 예매 스킬을 쓰려면 $SECRETS_FILE 을 직접 편집해 값을 채우세요.
  · 조회 스킬(날씨·법령·실거래가·지하철 등)은 키 없이 바로 씁니다.
  · 개별 스킬 사용법:  npx -y @nomadamas/k-skill@0 instruct <skill-name>
  · 안 쓰는 스킬 정리:  k-skill-cleaner 스킬 호출
EOF

exit 0
