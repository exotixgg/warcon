#!/usr/bin/env bash
# Root-only host backup for the isolated EXOTIX Warcon production stack.
set -Eeuo pipefail
umask 077
exec 9>/run/lock/exotix-warcon-backup.lock
flock -n 9 || exit 1
resource=kt53qmh7xfhgimxqpqa0eari
destination=/data/warcon-backups/production
kind=${1:-daily}
[[ "$kind" == daily || "$kind" == pre-upgrade ]] || exit 2
mapfile -t containers < <(docker ps --format '{{.Names}}' | grep -E "^db-${resource}-[0-9]+$")
[[ ${#containers[@]} == 1 ]] || { echo 'Expected exactly one running production database'; exit 1; }
container=${containers[0]}
install -d -m 700 "$destination"
prefix="$destination/$kind-$(date -u +%Y%m%dT%H%M%SZ)"
# Preserve the encryption/authentication keys without displaying them.
install -m 600 "/data/coolify/applications/$resource/.env" "$prefix.env"
docker exec "$container" pg_dump -U warcon -d warcon -Fc > "$prefix.dump.partial"
docker exec -i "$container" pg_restore --list < "$prefix.dump.partial" > "$prefix.toc"
mv "$prefix.dump.partial" "$prefix.dump"
sha256sum "$prefix.dump" "$prefix.env" > "$prefix.sha256"
chmod 600 "$prefix".*
if [[ "$kind" == daily ]]; then
  # Pre-upgrade snapshots are retained until deliberately removed.
  find "$destination" -maxdepth 1 -type f -name 'daily-*' -mtime +14 -delete
fi
printf 'Verified archive: %s\n' "$prefix.dump"
stat -c 'Archive bytes: %s' "$prefix.dump"
