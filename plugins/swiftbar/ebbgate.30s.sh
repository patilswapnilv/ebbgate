#!/usr/bin/env bash
# SwiftBar/xbar plugin: ebbgate presence mode toggle.
# <xbar.title>Ebbgate</xbar.title>
# <xbar.version>v0.1</xbar.version>
# <xbar.author>ebbgate</xbar.author>
# <xbar.desc>Shows local ebbgate presence and toggles busy/available/auto.</xbar.desc>
# <xbar.dependencies>bash,curl</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>

set -euo pipefail

MODE_FILE="${HOME}/.ebbgate/mode"
NODE_FILE="${HOME}/.ebbgate/node"
AGENT_JSON="${HOME}/.ebbgate/agent.json"
EBBGATE_BIN="${EBBGATE_BIN:-ebbgate}"

mode="auto"
if [[ -f "$MODE_FILE" ]]; then
  mode="$(tr -d '[:space:]' <"$MODE_FILE")"
fi

node_id=""
if [[ -f "$NODE_FILE" ]]; then
  node_id="$(tr -d '[:space:]' <"$NODE_FILE")"
fi

dispatcher_state=""
dispatcher_url="${EBBGATE_DISPATCHER_URL:-http://127.0.0.1:8790}"
if [[ -f "$AGENT_JSON" ]] && command -v python3 >/dev/null 2>&1; then
  dispatcher_url="$(python3 -c "import json;print(json.load(open('$AGENT_JSON')).get('dispatcherUrl','$dispatcher_url'))" 2>/dev/null || echo "$dispatcher_url")"
fi

# Best-effort: ● available / ◐ busy / ○ offline (BUILD_SPEC §8).
if [[ -n "$node_id" ]] && command -v curl >/dev/null 2>&1; then
  secret="${EG_PAPERCLIP_SECRET:-}"
  if [[ -z "$secret" && -f "${EBBGATE_CONFIG:-}" ]]; then
    :
  fi
  # Without admin secret we still show local mode; with secret, prefer dispatcher state.
  if [[ -n "${EG_PAPERCLIP_SECRET:-}" ]]; then
    json="$(curl -fsS -H "Authorization: Bearer ${EG_PAPERCLIP_SECRET}" \
      "${dispatcher_url}/status" 2>/dev/null || true)"
    if [[ -n "$json" ]]; then
      dispatcher_state="$(python3 -c "
import json,sys
try:
  d=json.loads(sys.argv[1]); n=sys.argv[2]
  for x in d.get('nodes',[]):
    if x.get('node')==n: print(x.get('state','')); break
except Exception:
  pass
" "$json" "$node_id" 2>/dev/null || true)"
    fi
  fi
fi

display="$mode"
if [[ -n "$dispatcher_state" ]]; then
  display="$dispatcher_state"
elif [[ "$mode" == "busy" ]]; then
  display="busy"
elif [[ "$mode" == "available" ]]; then
  display="available"
else
  display="auto"
fi

case "$display" in
  available) icon="●"; label="available" ;;
  busy) icon="◐"; label="busy" ;;
  offline) icon="○"; label="offline" ;;
  *) icon="○"; label="auto" ;;
esac

echo "${icon} ${label}"
echo "---"
echo "Local mode: ${mode}"
if [[ -n "$dispatcher_state" ]]; then
  echo "Dispatcher: ${dispatcher_state}"
fi
echo "Set busy | bash='$EBBGATE_BIN' param1=busy param2=on terminal=false refresh=true"
echo "Set available | bash='$EBBGATE_BIN' param1=busy param2=off terminal=false refresh=true"
echo "Set auto | bash='$EBBGATE_BIN' param1=busy param2=auto terminal=false refresh=true"
echo "---"
echo "Status | bash='$EBBGATE_BIN' param1=status terminal=true"
