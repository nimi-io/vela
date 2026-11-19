#!/bin/sh
# Called by MediaMTX: hook.sh <ready|not_ready|segment>
# (runOnAvailable → ready, runOnUnavailable → not_ready, runOnRecordSegmentComplete → segment)
# MediaMTX provides MTX_PATH, MTX_SOURCE_TYPE and (for segments) MTX_SEGMENT_PATH.
EVENT="$1"
API="${VELA_API_URL:-http://api:4000}"

# Percent-encode every byte: the body is application/x-www-form-urlencoded, so a raw "+" (as in
# the %z UTC offset of recording file names, e.g. "_+0000.mp4") would otherwise decode to a space.
enc() { printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g'; }

wget -q -O /dev/null -T 10 \
  --header "X-Internal-Secret: ${INTERNAL_SECRET}" \
  --post-data "event=$(enc "$EVENT")&path=$(enc "$MTX_PATH")&segment_path=$(enc "$MTX_SEGMENT_PATH")&protocol=$(enc "$MTX_SOURCE_TYPE")" \
  "${API}/internal/live/hooks" || echo "vela hook ${EVENT} failed for ${MTX_PATH}" >&2
exit 0
