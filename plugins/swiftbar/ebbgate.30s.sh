#!/usr/bin/env bash
# SwiftBar/xbar plugin: ebbgate presence mode toggle.
# <xbar.title>Ebbgate</xbar.title>
# <xbar.version>v0.2</xbar.version>
# <xbar.author>ebbgate</xbar.author>
# <xbar.desc>Shows ebbgate presence, how many tasks are held and why; toggles busy/available/auto.</xbar.desc>
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
held=""
top_reason=""
waiting_lines=""
dispatcher_url="${EBBGATE_DISPATCHER_URL:-http://127.0.0.1:8790}"
if [[ -f "$AGENT_JSON" ]] && command -v python3 >/dev/null 2>&1; then
  dispatcher_url="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('dispatcherUrl',sys.argv[2]))" "$AGENT_JSON" "$dispatcher_url" 2>/dev/null || echo "$dispatcher_url")"
fi

# Best-effort: ● available / ◐ busy / ○ offline (BUILD_SPEC §8), plus held count and
# the top reason tasks are waiting. Needs the dispatcher's admin secret; without it
# only the local mode is shown.
if command -v curl >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 \
  && [[ -n "${EG_PAPERCLIP_SECRET:-}" ]]; then
  json="$(curl -fsS --max-time 4 -H "Authorization: Bearer ${EG_PAPERCLIP_SECRET}" \
    "${dispatcher_url}/status" 2>/dev/null || true)"
  if [[ -n "$json" ]]; then
    # Prints: state, held count, top reason, then up to 5 "taskId<TAB>code<TAB>text" lines.
    # Everything is sanitised: SwiftBar treats '|' as a parameter separator.
    parsed="$(python3 -c "
import json,re,sys
def clean(s,n=120): return re.sub(r'[|\r\n\t]',' ',str(s))[:n]
def ident(s): return re.sub(r'[^A-Za-z0-9._:-]','',str(s))[:160]
try:
  d=json.loads(sys.argv[1]); n=sys.argv[2]
  state=''
  for x in d.get('nodes',[]):
    if x.get('node')==n: state=x.get('state','')
  if not state: state=(d.get('presence') or {}).get('overall','')
  q=d.get('queue') or {}
  held=q.get('held', d.get('queueDepth',0))
  t=d.get('topReason') or {}
  top=clean(t.get('text',''))+(' ('+str(int(t.get('count',0)))+')' if t else '')
  print(clean(state,16)); print(int(held)); print(top)
  for w in (d.get('waiting') or [])[:5]:
    print(ident(w.get('taskId',''))+'\t'+clean(w.get('code',''),40)+'\t'+clean(w.get('text','')))
except Exception:
  pass
" "$json" "$node_id" 2>/dev/null || true)"
    if [[ -n "$parsed" ]]; then
      dispatcher_state="$(sed -n 1p <<<"$parsed")"
      held="$(sed -n 2p <<<"$parsed")"
      top_reason="$(sed -n 3p <<<"$parsed")"
      waiting_lines="$(sed -n '4,$p' <<<"$parsed")"
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

title="${icon} ${label}"
if [[ -n "$held" && "$held" != "0" ]]; then
  title="${title} · ${held} held"
fi
echo "$title"
echo "---"
echo "Local mode: ${mode}"
if [[ -n "$dispatcher_state" ]]; then
  echo "Dispatcher: ${dispatcher_state}"
fi
if [[ -n "$held" ]]; then
  echo "Held at the gate: ${held}"
  if [[ -n "$top_reason" ]]; then
    echo "Top reason: ${top_reason}"
  fi
  if [[ -n "$waiting_lines" ]]; then
    while IFS=$'\t' read -r task_id code text; do
      [[ -z "$task_id" ]] && continue
      echo "--${task_id}: ${text}"
      echo "--Why? (${code}) | bash='$EBBGATE_BIN' param1=why param2=${task_id} terminal=true"
    done <<<"$waiting_lines"
  fi
fi
echo "Set busy | bash='$EBBGATE_BIN' param1=busy param2=on terminal=false refresh=true"
echo "Set available | bash='$EBBGATE_BIN' param1=busy param2=off terminal=false refresh=true"
echo "Set auto | bash='$EBBGATE_BIN' param1=busy param2=auto terminal=false refresh=true"
echo "---"
echo "Status | bash='$EBBGATE_BIN' param1=status terminal=true"
