#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"
env_file="${repo_root}/.env"
compose_file="${repo_root}/compose.oci.yaml"
data_dir="${repo_root}/data"
backup_dir="${repo_root}/backups"
status_file="${data_dir}/.backup-status"
manifest_tool="${script_dir}/backup-manifest.mjs"

if [ ! -f "${env_file}" ] || [ ! -d "${data_dir}" ]; then
  echo "Missing .env or data directory; nothing was backed up." >&2
  exit 1
fi
for command_name in docker tar openssl node flock; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required backup command is unavailable: ${command_name}" >&2
    exit 1
  fi
done

read_env_value() {
  local key="$1"
  awk -v wanted="${key}" '
    index($0, wanted "=") == 1 { value = substr($0, length(wanted) + 2) }
    END { print value }
  ' "${env_file}"
}

backup_encryption_secret="${BACKUP_ENCRYPTION_SECRET:-}"
backup_manifest_secret="${BACKUP_MANIFEST_SECRET:-}"
if [ -z "${backup_encryption_secret}" ]; then backup_encryption_secret="$(read_env_value BACKUP_ENCRYPTION_SECRET)"; fi
if [ -z "${backup_manifest_secret}" ]; then backup_manifest_secret="$(read_env_value BACKUP_MANIFEST_SECRET)"; fi
if [ "${#backup_encryption_secret}" -lt 32 ] || [ "${#backup_manifest_secret}" -lt 32 ]; then
  echo "BACKUP_ENCRYPTION_SECRET and BACKUP_MANIFEST_SECRET must each contain at least 32 characters." >&2
  exit 1
fi
if [ "${backup_encryption_secret}" = "${backup_manifest_secret}" ]; then
  echo "Backup encryption and manifest secrets must be distinct." >&2
  exit 1
fi
export BACKUP_ENCRYPTION_SECRET="${backup_encryption_secret}"
export BACKUP_MANIFEST_SECRET="${backup_manifest_secret}"

# A restore deliberately refuses links and special files, so stop before
# creating an archive that could never pass the restore boundary.
if [ -n "$(find "${data_dir}" -mindepth 1 ! -type f ! -type d -print -quit)" ]; then
  echo "Backup refused: data contains a symlink, device, fifo, socket, or another unsupported entry." >&2
  exit 1
fi
if [ -n "$(find "${data_dir}" -type f -links +1 -print -quit)" ]; then
  echo "Backup refused: data contains a hard-linked file." >&2
  exit 1
fi

mkdir -p -- "${backup_dir}"
exec 9>"${backup_dir}/.backup.lock"
if ! flock -n 9; then
  echo "Another AI Workers backup is already running." >&2
  exit 1
fi

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
archive_name="ai-workers-data-${timestamp}.tar.gz.enc"
archive="${backup_dir}/${archive_name}"
temporary_archive="${archive}.partial"
manifest="${archive}.manifest"
manifest_signature="${manifest}.hmac"
plaintext_archive="$(mktemp "${backup_dir}/.ai-workers-plaintext-${timestamp}.XXXXXX")"
data_bytes="$(du -sk "${data_dir}" | awk '{print $1 * 1024}')"
available_bytes="$(df -Pk "${backup_dir}" | awk 'NR == 2 {print $4 * 1024}')"
required_bytes="$((data_bytes * 2 + 104857600))"
if [ "${available_bytes}" -lt "${required_bytes}" ]; then
  echo "Not enough free space to stage and encrypt a backup safely." >&2
  exit 1
fi

container_id="$(docker compose --env-file "${env_file}" -f "${compose_file}" ps -q app 2>/dev/null || true)"
restart_required=0

cleanup() {
  rm -f -- "${plaintext_archive}" "${temporary_archive}"
  if [ "${restart_required}" -eq 1 ]; then
    docker compose --env-file "${env_file}" -f "${compose_file}" start app >/dev/null || true
  fi
}
trap cleanup EXIT

if [ -n "${container_id}" ] && [ "$(docker inspect -f '{{.State.Running}}' "${container_id}")" = "true" ]; then
  restart_required=1
  docker compose --env-file "${env_file}" -f "${compose_file}" stop app >/dev/null
fi

tar -C "${data_dir}" -czf "${plaintext_archive}" .
if [ "${restart_required}" -eq 1 ]; then
  docker compose --env-file "${env_file}" -f "${compose_file}" start app >/dev/null
  restart_required=0
fi

openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 \
  -pass env:BACKUP_ENCRYPTION_SECRET \
  -in "${plaintext_archive}" -out "${temporary_archive}"
rm -f -- "${plaintext_archive}"
mv -- "${temporary_archive}" "${archive}"
node "${manifest_tool}" create "${archive}" "${manifest}" "${manifest_signature}" "${timestamp}" >/dev/null
echo "Encrypted backup and signed manifest created: ${archive}"

backup_state="encrypted_local"
backup_remote="${BACKUP_RCLONE_REMOTE:-}"
if [ -z "${backup_remote}" ]; then backup_remote="$(read_env_value BACKUP_RCLONE_REMOTE)"; fi

if [ -n "${backup_remote}" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "BACKUP_RCLONE_REMOTE is set but rclone is unavailable." >&2
    exit 1
  fi
  if [[ ! "${backup_remote}" =~ ^[A-Za-z0-9._-]+:.+ ]]; then
    echo "BACKUP_RCLONE_REMOTE must name a dedicated rclone remote and path." >&2
    exit 1
  fi
  remote_name="${backup_remote%%:*}"
  remote_type="$(rclone config show "${remote_name}" 2>/dev/null | awk -F= '
    /^[[:space:]]*type[[:space:]]*=/ { gsub(/[[:space:]]/, "", $2); print tolower($2); exit }
  ')"
  if [ "${remote_type}" != "crypt" ]; then
    echo "BACKUP_RCLONE_REMOTE must use a verified rclone crypt remote." >&2
    exit 1
  fi
  remote="${backup_remote%/}"
  rclone copyto "${archive}" "${remote}/${archive_name}"
  rclone copyto "${manifest}" "${remote}/$(basename -- "${manifest}")"
  rclone copyto "${manifest_signature}" "${remote}/$(basename -- "${manifest_signature}")"
  rclone check "${backup_dir}" "${remote}" \
    --include "${archive_name}" \
    --include "$(basename -- "${manifest}")" \
    --include "$(basename -- "${manifest_signature}")" \
    --one-way --download
  backup_state="offsite_verified"
  echo "Encrypted off-VM backup copied through and verified behind rclone crypt: ${remote}/${archive_name}"
else
  echo "The local archive is encrypted and authenticated, but it is not disaster recovery until a verified off-VM copy exists."
fi

status_tmp="${status_file}.partial"
{
  printf 'state=%s\n' "${backup_state}"
  printf 'archive=%s\n' "${archive_name}"
  printf 'created_at=%s\n' "${timestamp}"
  printf 'encrypted=true\n'
  printf 'manifest_signed=true\n'
} > "${status_tmp}"
mv -- "${status_tmp}" "${status_file}"

local_retention_days="${BACKUP_LOCAL_RETENTION_DAYS:-$(read_env_value BACKUP_LOCAL_RETENTION_DAYS)}"
remote_retention_days="${BACKUP_REMOTE_RETENTION_DAYS:-$(read_env_value BACKUP_REMOTE_RETENTION_DAYS)}"
local_retention_days="${local_retention_days:-14}"
remote_retention_days="${remote_retention_days:-90}"
if [[ ! "${local_retention_days}" =~ ^[0-9]+$ ]] || [ "${local_retention_days}" -lt 1 ] || [ "${local_retention_days}" -gt 3650 ]; then
  echo "BACKUP_LOCAL_RETENTION_DAYS must be an integer from 1 to 3650." >&2
  exit 1
fi
if [[ ! "${remote_retention_days}" =~ ^[0-9]+$ ]] || [ "${remote_retention_days}" -lt 1 ] || [ "${remote_retention_days}" -gt 3650 ]; then
  echo "BACKUP_REMOTE_RETENTION_DAYS must be an integer from 1 to 3650." >&2
  exit 1
fi

while IFS= read -r -d '' old_archive; do
  old_name="$(basename -- "${old_archive}")"
  if [[ "${old_name}" =~ ^ai-workers-data-[0-9]{8}T[0-9]{6}Z\.tar\.gz\.enc$ ]] && [ "${old_name}" != "${archive_name}" ]; then
    rm -f -- "${old_archive}" "${old_archive}.manifest" "${old_archive}.manifest.hmac"
    echo "Rotated expired local encrypted backup: ${old_name}"
  fi
done < <(find "${backup_dir}" -maxdepth 1 -type f -name 'ai-workers-data-*.tar.gz.enc' -mtime "+${local_retention_days}" -print0)

if [ "${backup_state}" = "offsite_verified" ]; then
  rclone delete "${remote}" --min-age "${remote_retention_days}d" \
    --include 'ai-workers-data-*.tar.gz.enc' \
    --include 'ai-workers-data-*.tar.gz.enc.manifest' \
    --include 'ai-workers-data-*.tar.gz.enc.manifest.hmac'
  echo "Applied ${remote_retention_days}-day retention to the dedicated encrypted backup path."
fi
