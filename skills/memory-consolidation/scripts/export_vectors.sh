#!/usr/bin/env bash
# Export denis's memories + embeddings to export.csv (psql \copy, proper CSV quoting).
set -euo pipefail
WS="${WORKSPACE:-$HOME/mem0-consolidation}"
HOST="${MEM0_DB_HOST:-192.168.1.6}"
mkdir -p "$WS"
SQL="\\copy (SELECT id, payload->>'data' AS data, payload->>'created_at' AS created_at, payload->>'updated_at' AS updated_at, vector::text AS vec FROM memories WHERE payload->>'user_id' = 'denis' ORDER BY id) TO STDOUT WITH CSV HEADER"
ssh "$HOST" "podman exec mem0-db psql -U mem0 -d postgres -c \"$SQL\"" > "$WS/export.csv"
rows=$(( $(wc -l < "$WS/export.csv") - 1 ))
echo "$WS/export.csv: $rows rows"
