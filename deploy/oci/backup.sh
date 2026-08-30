#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
env_file="${repo_root}/.env"
compose_file="${repo_root}/compose.oci.yaml"
data_dir="${repo_root}/data"
backup_dir="${repo_root}/backups"

if [ ! -f "${env_file}" ] || [ ! -d "${data_dir}" ]; then
  echo "Missing .env or data directory; nothing was backed up." >&2
  exit 1
fi

mkdir -p -- "${backup_dir}"
exec 9>"${backup_dir}/.backup.lock"
if ! flock -n 9; then
  echo "Another AI Workers backup is already running." >&2
  exit 1
fi

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
archive="${backup_dir}/ai-workers-data-${timestamp}.tar.gz"
temporary_archive="${archive}.partial"
data_bytes="$(du -sb "${data_dir}" | awk '{print $1}')"
available_bytes="$(df -PB1 "${backup_dir}" | awk 'NR == 2 {print $4}')"
required_bytes="$((data_bytes + 104857600))"
if [ "${available_bytes}" -lt "${required_bytes}" ]; then
  echo "Not enough free space to stage a backup safely. Copy verified old archives off-VM, then remove them deliberately." >&2
  exit 1
fi

container_id="$(docker compose --env-file "${env_file}" -f "${compose_file}" ps -q app 2>/dev/null || true)"
was_running=0

restart_app() {
  if [ "${was_running}" -eq 1 ]; then
    docker compose --env-file "${env_file}" -f "${compose_file}" start app >/dev/null
  fi
}
trap restart_app EXIT

if [ -n "${container_id}" ] && [ "$(docker inspect -f '{{.State.Running}}' "${container_id}")" = "true" ]; then
  was_running=1
  docker compose --env-file "${env_file}" -f "${compose_file}" stop app >/dev/null
fi

tar -C "${data_dir}" -czf "${temporary_archive}" .
mv -- "${temporary_archive}" "${archive}"
archive_name="$(basename -- "${archive}")"
(
  cd -- "${backup_dir}"
  sha256sum "${archive_name}" > "${archive_name}.sha256"
)

echo "Backup staging archive created: ${archive}"
echo "It is not a valid disaster-recovery backup until both files are copied off this VM and the checksum is verified there."
