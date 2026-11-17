#!/bin/sh
# Applies db/init/*.sql once. Uses the standard PG* environment variables.
set -eu

if [ "$(psql -tAc "SELECT to_regclass('public.facilities') IS NOT NULL")" = "t" ]; then
  echo "schema already present, nothing to do"
  exit 0
fi

for f in /migrations/*.sql; do
  echo "applying $f"
  psql -v ON_ERROR_STOP=1 -1 -f "$f"
done
echo "migrations complete"
