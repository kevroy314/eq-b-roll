#!/bin/bash
# Apply the b-roll database changes on every start, then hand over to the upstream entrypoint.
# Running them at start rather than at image build means an existing database volume also picks
# up any new or changed SQL after the image is rebuilt.
service mariadb start
for i in $(seq 60); do mariadb -e "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
for f in /broll/sql/*.sql; do
  echo "[broll] applying $(basename "$f")"
  mariadb peq < "$f" || echo "[broll] WARNING: $f failed"
done
exec entrypoint.sh
