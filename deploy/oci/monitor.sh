#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
env_file="${repo_root}/.env"
state_file="${repo_root}/data/.monitor-state"

if [ ! -f "${env_file}" ]; then
  echo "Missing .env." >&2
  exit 1
fi

domain="$(sed -n 's/^AI_WORKERS_DOMAIN=//p' "${env_file}" | tail -n 1)"
if [[ ! "${domain}" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  echo "AI_WORKERS_DOMAIN is invalid." >&2
  exit 1
fi
base_url="https://${domain}"

health_body="$(mktemp /tmp/ai-workers-health.XXXXXX)"
ready_body="$(mktemp /tmp/ai-workers-ready.XXXXXX)"
cleanup() {
  find "${health_body}" "${ready_body}" -maxdepth 0 -type f -delete 2>/dev/null || true
}
trap cleanup EXIT

health_code="$(curl -sS --max-time 15 -o "${health_body}" -w '%{http_code}' "${base_url}/health" || true)"
ready_code="$(curl -sS --max-time 15 -o "${ready_body}" -w '%{http_code}' "${base_url}/ready" || true)"
state="healthy"
if [ "${health_code}" != "200" ] || [ "${ready_code}" != "200" ] || ! grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "${ready_body}"; then
  state="failed"
fi

previous_state="unknown"
if [ -f "${state_file}" ]; then
  previous_state="$(sed -n 's/^state=//p' "${state_file}" | tail -n 1)"
fi

alert_url="${MONITOR_ALERT_WEBHOOK_URL:-}"
if [ -z "${alert_url}" ]; then
  alert_url="$(sed -n 's/^MONITOR_ALERT_WEBHOOK_URL=//p' "${env_file}" | tail -n 1)"
fi
if [ "${state}" != "${previous_state}" ] && [ -n "${alert_url}" ]; then
  if [[ ! "${alert_url}" =~ ^https:// ]]; then
    echo "MONITOR_ALERT_WEBHOOK_URL must use HTTPS; alert skipped." >&2
  else
    event="ai_workers_recovered"
    [ "${state}" = "failed" ] && event="ai_workers_not_ready"
    curl -fsS --max-time 15 -X POST "${alert_url}" \
      -H 'content-type: application/json' \
      --data "{\"event\":\"${event}\",\"service\":\"ai-workers\",\"healthStatus\":\"${health_code}\",\"readyStatus\":\"${ready_code}\"}" \
      >/dev/null || echo "Monitor alert delivery failed." >&2
  fi
fi

state_tmp="${state_file}.partial"
{
  printf 'state=%s\n' "${state}"
  printf 'checked_at=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf 'health_status=%s\n' "${health_code}"
  printf 'ready_status=%s\n' "${ready_code}"
} > "${state_tmp}"
mv -- "${state_tmp}" "${state_file}"

if [ "${state}" != "healthy" ]; then
  echo "AI Workers readiness failed: health=${health_code} ready=${ready_code}" >&2
  exit 1
fi
echo "AI Workers readiness is healthy."
