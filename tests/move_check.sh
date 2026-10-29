#!/usr/bin/env bash
# The sandbox mounts a throwaway store and rejects writes outside its allowlist.
set -euo pipefail
SERVE="" DRYONLY="" WITH=() SUITE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --serve) SERVE=1; shift ;;
    --dry) DRYONLY=1; shift ;;
    --with) [ -f "${2:-}" ] || { echo "--with needs a picker-type.json"; exit 2; }; WITH+=("$(realpath "$2")"); shift 2 ;;
    --suite) [ -f "${2:-}/fixture.py" ] || { echo "--suite needs a folder with a fixture.py"; exit 2; }; SUITE=$(realpath "$2"); shift 2 ;;
    *) break ;;
  esac
done
export FIXTURE_TYPES=$(IFS=:; echo "${WITH[*]}")
[ -n "$SERVE" ] && export FIXTURE_PUBLIC=1
HERE=$(cd "$(dirname "$0")" && pwd)
PICKER=$(dirname "$HERE")
WORK=$(mktemp -d /tmp/picker-move-XXXXXX)
SRV=""
cleanup() { set +e; pkill -f "^$WORK/venv/bin/python" 2>/dev/null; [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; wait 2>/dev/null
            rm -rf "$WORK"; }
trap cleanup EXIT
trap 'exit 130' INT TERM
KNOWN=()
uv venv -q "$WORK/venv"
uv pip install -q --python "$WORK/venv/bin/python" "flask>=3.0" numpy pillow
PY="$WORK/venv/bin/python"
"$PY" "$HERE/fixture/build.py" "$WORK/store" --runners "$WORK/runners" ${SUITE:+--suite "$SUITE"} > /dev/null
[ -n "${FIXTURE_SCALE:-}" ] && "$PY" "$HERE/fixture/scale.py" "$WORK/store" "$FIXTURE_SCALE" > /dev/null
mkdir -p "$WORK/cache" "$WORK/empty"
: > "$WORK/leaks.log"
OPCFG=$("$PY" -c 'import importlib.util as u, sys; s = u.spec_from_file_location("c", sys.argv[1]); C = sys.modules["c"] = u.module_from_spec(s)
s.loader.exec_module(C); p = C.DEFAULT.resolve(); print(p if p.is_file() else "")' "$PICKER/core/config.py")
[ -n "$SUITE" ] && [ -z "$OPCFG" ] && { echo "--suite needs the operator's config (core/config.DEFAULT)"; exit 2; }
REPO="" HIDE=() HIDDEN=""
if [ -n "$OPCFG" ]; then
  REPO=$("$PY" -c 'import importlib.util as u, sys; s = u.spec_from_file_location("c", sys.argv[1]); C = sys.modules["c"] = u.module_from_spec(s)
s.loader.exec_module(C); print(C.read(sys.argv[2]).research)' "$PICKER/core/config.py" "$OPCFG")
  # Fail closed if outputs cannot be listed; hiding none would expose private data.
  MASK=$(FIXTURE_TYPES="" "$PY" -c 'import importlib.util as u, sys; s = u.spec_from_file_location("b", sys.argv[1]); B = u.module_from_spec(s)
s.loader.exec_module(B); C = B._config(); [print(o) for t in B.types_of(C, C.read(sys.argv[2])) for o in [*t.get("outputs", []), t.get("cards")]
 if o and "/src/" not in "/" + o + "/"]' "$HERE/fixture/build.py" "$OPCFG") || { echo "can't list the operator's outputs to hide them"; exit 2; }
  while IFS= read -r d; do [ -d "$REPO/$d" ] && HIDE+=(--tmpfs "$REPO/$d"); done < <(
    printf '%s\n' "$MASK"
    [ -n "$SUITE" ] && "$PY" -c 'import runpy, sys; print("\n".join(runpy.run_path(sys.argv[1]).get("HIDDEN", [])))' "$SUITE/fixture.py")
  [ -n "$SUITE" ] && HIDDEN=$("$PY" -c 'import os, runpy, sys; print(os.pathsep.join(os.path.join(sys.argv[2], d) for d in runpy.run_path(sys.argv[1]).get("HIDDEN", [])))' "$SUITE/fixture.py" "$REPO")
fi
UVPY="$HOME/.local/share/uv/python"
[ -n "$OPCFG" ] && while IFS= read -r d; do [ -d "$d" ] && HIDE+=(--ro-bind "$WORK/empty" "$d"); done < <(
  "$PY" -c 'import importlib.util as u, sys; s = u.spec_from_file_location("c", sys.argv[1]); C = sys.modules["c"] = u.module_from_spec(s)
s.loader.exec_module(C); c = C.read(sys.argv[2]); [print(p) for p in (c.data, c.state, c.cache)]' "$PICKER/core/config.py" "$OPCFG")
mkcfg() {
  cat > "$1" <<EOF
data = "$2"
state = "$2.state"
cache = "$WORK/cache"
agents = "$PICKER/agents.json"
types = $4
research = "$RESEARCH"
plugins = $OPPLUGINS
${3:+downloads = \"$3\"}
$EXECUTIONLINE
$BANDLINE
$NAMESLINE
EOF
}
# the names it answers to besides localhost (FIXTURE_NAMES, colon-separated: a tailnet's), as [server] names
NAMESLINE=""
[ -n "${FIXTURE_NAMES:-}" ] && NAMESLINE=$(printf '[server]\nnames = [%s]' "$(tr ':' '\n' <<< "$FIXTURE_NAMES" | sed 's/.*/"&"/' | paste -sd, -)")
RESEARCH="$WORK" OPPLUGINS="[]" OPDOWNLOADS=""
EXECUTIONLINE="unrestricted_agents = false"
if [ -n "$SUITE" ]; then
  RESEARCH="$REPO"
  OPPLUGINS=$("$PY" -c 'import importlib.util as u, json, sys; s = u.spec_from_file_location("c", sys.argv[1]); C = sys.modules["c"] = u.module_from_spec(s)
s.loader.exec_module(C); print(json.dumps([str(p) for p in C.read(sys.argv[2]).plugins]))' "$PICKER/core/config.py" "$OPCFG")
  OPDOWNLOADS=$("$PY" -c 'import importlib.util as u, sys; s = u.spec_from_file_location("c", sys.argv[1]); C = sys.modules["c"] = u.module_from_spec(s)
s.loader.exec_module(C); print(C.read(sys.argv[2]).downloads)' "$PICKER/core/config.py" "$OPCFG")
  EXECUTIONLINE=$("$PY" -c 'import importlib.util as u, sys; s = u.spec_from_file_location("c", sys.argv[1]); C = sys.modules["c"] = u.module_from_spec(s)
s.loader.exec_module(C); print("unrestricted_agents = " + str(C.read(sys.argv[2]).unrestricted_agents).lower())' "$PICKER/core/config.py" "$OPCFG")
fi
BANDLINE=""; [ -n "${FIXTURE_BAND:-}" ] && BANDLINE="band = \"$FIXTURE_BAND\""
mkcfg "$WORK/picker.toml" "$WORK/store" "$OPDOWNLOADS" "$(cat "$WORK/runners/types.toml")"
mkcfg "$WORK/dry.toml" "$WORK/dry" "" "$(cat "$WORK/runners/dry_types.toml")"
FAKES=() ALLOW=""
while IFS=$'\t' read -r t home; do
  FAKES+=(--bind "$WORK/runners/$t" "$home"); ALLOW+="$home:"
done < <("$PY" -c 'import json, sys; [print(f"{t}\t{h}") for t, h in json.load(open(sys.argv[1])).items()]' \
           "$WORK/runners/homes.json")
ALLOW+="$WORK/runners:"
EXTRA=()
sandbox() {
  exec bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --bind "$WORK" "$WORK" \
        --tmpfs "$HOME" ${REPO:+--ro-bind "$REPO" "$REPO"} --ro-bind "$PICKER" "$PICKER" --ro-bind "$UVPY" "$UVPY" \
        --ro-bind-try "$HOME/.config/picker" "$HOME/.config/picker" \
        --ro-bind "$(command -v uv)" "$(command -v uv)" --bind "$HOME/.cache/uv" "$HOME/.cache/uv" \
        "${HIDE[@]}" "${EXTRA[@]}" \
        --setenv PICKER_CONFIG "${CONFIG:-$WORK/picker.toml}" --setenv PICKER_HOME "$PICKER" \
        ${SUITE:+--setenv FIXTURE_SUITE "$SUITE"} \
        --tmpfs "/run/user/$(id -u)" --setenv HOME "$HOME" --setenv PYTHONDONTWRITEBYTECODE 1 \
        --unsetenv INVOCATION_ID --unshare-pid --die-with-parent "$@"
}
unknown() { sort -u "$1" | grep -v -F -f <(printf '%s\n' "${KNOWN[@]:-}" | grep . || true) || true; }
fail=0
if [ -n "$SERVE" ]; then
  PORT=${FIXTURE_PORT:-$("$PY" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}
  [ "$PORT" = 8080 ] && { echo "never on :8080"; exit 2; }
  echo "the fixture picker: http://127.0.0.1:$PORT/  (^C stops it; its store is $WORK/store)"
  (EXTRA=("${FAKES[@]}" --setenv FIXTURE_ALLOW "$ALLOW")
   sandbox "$PY" "$HERE/fixture/serve.py" "$PORT" "$WORK/leaks.log") &
  SRV=$!
  wait "$SRV"
  exit 0
fi
echo "== the check checks itself"
: > "$WORK/self.log"
(EXTRA=(--setenv FIXTURE_HIDDEN "$HIDDEN"); sandbox "$PY" "$HERE/fixture/selftest.py" "$WORK/self.log") > "$WORK/self.out" 2>&1 || true
self=$(unknown "$WORK/self.log")
if grep -qP "^write\t\Q$PICKER/selftest_escape.txt\E$" <<< "$self" && grep -qP "^exec\tclaude " <<< "$self" \
   && grep -qP "^net\t127.0.0.1:8080$" <<< "$self" \
   && [ ! -e "$PICKER/selftest_escape.txt" ] && ! grep -q "^read" <<< "$self"; then
  echo "an escaped write (it never landed), a forbidden program, a call to :8080: all caught; no login or recording visible"
else
  echo "NOT caught — the check would pass a leak:"; cat "$WORK/self.log" "$WORK/self.out"; fail=1
fi
if [ $# -eq 0 ] && [ -z "$DRYONLY" ]; then
  echo "== python tests, in the sandbox"
  if (sandbox "$PY" -m unittest discover -s "${SUITE:-$HERE}/py") > "$WORK/py.log" 2>&1; then
    tail -3 "$WORK/py.log" | grep -E "^(Ran|OK)" | tr '\n' ' '; echo
  else
    grep -E "^(FAIL|ERROR):|^Ran|^FAILED" "$WORK/py.log" | head -20; fail=1
    awk '/^(FAIL|ERROR): /{t=$0; n=0} /^Traceback/{p=1} p&&n<200{buf[t]=buf[t] $0 "\n"; n++} /^-{20,}$/{p=0}
         END{for (k in buf) {print "--- " k; printf "%s", buf[k]}}' "$WORK/py.log" | grep -v "^  File \"/usr\|unittest" \
      | tail -60
  fi
fi
if [ $# -eq 0 ] && [ "$(cat "$WORK/runners/dry_types.toml")" != "[]" ]; then
  DRY=()
  while IFS=$'\t' read -r t home; do DRY+=(--overlay-src "$home" --tmp-overlay "$home"); done < <(
    "$PY" -c 'import json, sys; [print(f"{t}\t{h}") for t, h in json.load(open(sys.argv[1])).items()]' \
      "$WORK/runners/homes.json")
  DRY+=("${HIDE[@]}")
  cp -a "$WORK/store" "$WORK/dry"
  echo "== each type's dry run (its real runner, no agent)"
  (EXTRA=("${DRY[@]}"); CONFIG="$WORK/dry.toml"; sandbox "$PY" "$HERE/fixture/dry_runs.py") > "$WORK/dry.log" 2>&1 || fail=1
  cat "$WORK/dry.log"
  [ -n "$DRYONLY" ] && exit $fail
fi
echo "== the fixture picker"
PORT=$("$PY" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
DOWN=() DOWNPORTS=""
[ -n "$SUITE" ] && while IFS= read -r v; do
  p=$("$PY" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  DOWN+=(--setenv "$v" "$p"); DOWNPORTS+="$p:"
done < <("$PY" -c 'import runpy, sys; print("\n".join(runpy.run_path(sys.argv[1]).get("DOWN", [])))' "$SUITE/fixture.py" | grep .)
(EXTRA=("${FAKES[@]}" "${DOWN[@]}" --setenv FIXTURE_ALLOW "$ALLOW" --setenv FIXTURE_DOWN "$DOWNPORTS")
 sandbox "$PY" "$HERE/fixture/serve.py" "$PORT" "$WORK/leaks.log") > "$WORK/server.log" 2>&1 &
SRV=$!
for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/api/types" > /dev/null && break
  kill -0 "$SRV" 2>/dev/null || { echo "the fixture picker died:"; tail -20 "$WORK/server.log"; exit 1; }
  sleep 0.5
done
head -1 "$WORK/server.log"
PICKER_URL="http://127.0.0.1:$PORT" CHECKS_DIR="${SUITE:-}" node "$HERE/run.mjs" "$@" || fail=1
echo "== writes outside the store"
leaks=$(unknown "$WORK/leaks.log")
if [ -n "$leaks" ]; then echo "$leaks"; fail=1; else echo "none (known: ${#KNOWN[@]})"; fi
if grep -q "Traceback" "$WORK/server.log"; then
  echo "== the fixture picker raised:"; grep -A80 "Traceback" "$WORK/server.log" | grep -v "^ *[\^~]*$" | head -120
fi
exit $fail
