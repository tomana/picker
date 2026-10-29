#!/bin/bash
# Unknown changes fall back to the full isolated check, not a partial selection.
set -u -o pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SEL=$(python3 "$HERE/affects.py" "$@") || { echo "the selector failed: the whole move_check"; exec "$HERE/move_check.sh"; }
mapfile -t L <<< "$SEL"
PYT=${L[0]:-}; WEB=${L[1]:-}
if [ "$PYT" = "ALL" ]; then
  echo "== a change it can't place: the whole move_check"
  exec "$HERE/move_check.sh"
fi
fail=0
if [ -n "$PYT" ]; then
  echo "== python: the suite"
  (cd "$HERE/.." && uv run --quiet --no-project --with "flask>=3.0" --with numpy --with pillow \
     python -m unittest discover -s tests/py 2>&1 | tail -3) || fail=1
fi
if [ -n "$WEB" ]; then
  echo "== browser: $WEB"
  "$HERE/move_check.sh" $WEB 2>&1 | grep -E "^(PASS|FAIL)|passed in|^ {8}" | grep -vE "^ {8}" ; [ "${PIPESTATUS[0]}" = 0 ] || fail=1
fi
[ -z "$PYT$WEB" ] && echo "nothing to check"
exit $fail
