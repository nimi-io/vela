#!/bin/sh
# Called by MediaMTX: hook.sh <ready|not_ready|segment>
# MediaMTX provides MTX_PATH, MTX_SOURCE_TYPE and (for segments) MTX_SEGMENT_PATH.
EVENT="$1"
API="${VELA_API_URL:-http://api:4000}"
wget -q -O /dev/null -T 10 \
  --header "X-Internal-Secret: ${INTERNAL_SECRET}" \
  --post-data "event=${EVENT}&path=${MTX_PATH}&segment_path=${MTX_SEGMENT_PATH}&protocol=${MTX_SOURCE_TYPE}" \
  "${API}/internal/live/hooks" || echo "vela hook ${EVENT} failed for ${MTX_PATH}" >&2
exit 0
