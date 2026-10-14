#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${READLATER_APP_DIR:-/opt/readlater}"
DATA_FILE="${READLATER_DATA_FILE:-$APP_DIR/data/readlater.json}"
MEDIA_DIR="${READLATER_MEDIA_DIR:-$APP_DIR/data/media}"
TRANSCRIPT_DIR="${READLATER_TRANSCRIPT_DIR:-$APP_DIR/data/transcripts}"
BACKUP_DIR="${READLATER_BACKUP_DIR:-$APP_DIR/backups}"
KEEP="${READLATER_BACKUP_KEEP:-90}"

if [[ ! -f "$DATA_FILE" ]]; then
  echo "Data file not found: $DATA_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$DATA_FILE"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$BACKUP_DIR/readlater-$timestamp.json.gz"
media_backup_file="$BACKUP_DIR/readlater-media-$timestamp.tar.gz"
transcript_backup_file="$BACKUP_DIR/readlater-transcripts-$timestamp.tar.gz"

tmp_file="$(mktemp "$BACKUP_DIR/.readlater-$timestamp.XXXXXX")"
cp "$DATA_FILE" "$tmp_file"
gzip -c "$tmp_file" > "$backup_file"
rm -f "$tmp_file"

if [[ -d "$MEDIA_DIR" ]]; then
  tar -C "$(dirname "$MEDIA_DIR")" -czf "$media_backup_file" "$(basename "$MEDIA_DIR")"
fi

if [[ -d "$TRANSCRIPT_DIR" ]]; then
  tar -C "$(dirname "$TRANSCRIPT_DIR")" -czf "$transcript_backup_file" "$(basename "$TRANSCRIPT_DIR")"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'readlater-*.json.gz' \
  | sort -r \
  | tail -n +"$((KEEP + 1))" \
  | xargs -r rm -f

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'readlater-media-*.tar.gz' \
  | sort -r \
  | tail -n +"$((KEEP + 1))" \
  | xargs -r rm -f

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'readlater-transcripts-*.tar.gz' \
  | sort -r \
  | tail -n +"$((KEEP + 1))" \
  | xargs -r rm -f

echo "$backup_file"
[[ -f "$media_backup_file" ]] && echo "$media_backup_file"
[[ -f "$transcript_backup_file" ]] && echo "$transcript_backup_file"
