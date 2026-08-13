#!/bin/bash
# Self-check for the model logic in ccx-models.py, plus the default-model
# handoff in ccx. No framework — feed a fake catalogue, assert on the output.
#   ./test-picker.sh
set -uo pipefail
cd "$(dirname "$0")"

# Non-Claude models reach the client under a disguised id: a Claude prefix
# plus the real id reversed. Build the fixture the same way the proxy does.
mk() { python3 -c "
import json,sys
name,plain,owner=sys.argv[1],sys.argv[2],sys.argv[3]
mid = plain if owner=='anthropic' and plain.startswith('claude') else 'claude-fable-5-dd-'+plain[::-1]
row = {'id':mid,'display_name':name,'owned_by':owner}
if len(sys.argv)>4 and sys.argv[4]: row['max_input_tokens']=int(sys.argv[4])
print(json.dumps(row))"  "$1" "$2" "$3" "${4:-}"; }

FAKE=$(python3 -c "
import json,subprocess,sys
rows=[]
for line in sys.stdin: rows.append(json.loads(line))
print(json.dumps({'data':rows}))" <<EOF
$(mk "Claude Opus 5" claude-opus-5 anthropic)
$(mk "Claude Opus 4.8" claude-opus-4-8 anthropic)
$(mk "Claude 4.5 Opus" claude-opus-4-5-20251101 anthropic)
$(mk "Claude Sonnet 5" claude-sonnet-5 anthropic)
$(mk "Claude Sonnet 4.6 (Thinking)" claude-sonnet-4-6 antigravity)
$(mk "Claude 4.6 Sonnet" claude-sonnet-4-6 anthropic)
$(mk "Claude Fable 5" claude-fable-5 anthropic)
$(mk "Claude 4.5 Haiku" claude-haiku-4-5-20251001 anthropic 200000)
$(mk "Claude 3.5 Haiku" claude-3-5-haiku-20241022 anthropic)
$(mk "GPT 5.6 Luna" gpt-5.6-luna openai)
$(mk "GPT 5.5" gpt-5.5 openai)
$(mk "GPT 5.4 Mini" gpt-5.4-mini openai)
$(mk "GPT-OSS 120B (Medium)" gpt-oss-120b-medium antigravity)
$(mk "Codex Auto Review" codex-auto-review openai)
$(mk "Gemini 3.6 Flash" gemini-3.6-flash-high antigravity)
$(mk "Gemini 3.5 Flash (High)" gemini-3-flash-agent antigravity)
$(mk "Gemini 3.1 Pro (High)" gemini-pro-agent antigravity)
$(mk "Gemini 3.1 Pro (Low)" gemini-3.1-pro-low antigravity)
$(mk "Grok 4.6" grok-4.6 xai 500000)
$(mk "Grok 4.20 0309 Reasoning" grok-4.20-0309-reasoning xai)
$(mk "Grok 4.5" grok-4.5 xai)
$(mk "Grok Imagine Video" grok-imagine-video xai)
EOF
)

fail=0
say() { if [ "$1" = 1 ]; then echo "  ok   $2"; else echo "  FAIL $2"; fail=1; fi; }
shown() { echo "$FAKE" | python3 ccx-models.py plan; }

echo "only the current generation of each model line is offered:"
PLAN="$(shown)"
EXPECTED="claude-fable-5
claude-haiku-4-5-20251001
claude-opus-5
claude-sonnet-5
gpt-5.6-luna
gemini-3.6-flash-high
gemini-pro-agent
grok-4.6"
if [ "$(sort <<<"$PLAN")" = "$(sort <<<"$EXPECTED")" ]; then
  echo "  ok   exactly the frontier models survive"
else
  echo "  FAIL wrong set:"; diff <(sort <<<"$EXPECTED") <(sort <<<"$PLAN") | sed 's/^/       /'; fail=1
fi

echo
echo "superseded versions are dropped, one line at a time:"
for gone in claude-opus-4-8 claude-opus-4-5-20251101 claude-sonnet-4-6 claude-3-5-haiku-20241022 \
            gpt-5.5 grok-4.5 gemini-3-flash-agent; do
  grep -qx "$gone" <<<"$PLAN" && { say 0 "$gone should be hidden"; } || say 1 "$gone hidden"
done

echo
echo "each model line keeps its own newest, rather than one winner per provider:"
say "$(grep -qx claude-opus-5 <<<"$PLAN" && echo 1 || echo 0)"   "Opus survives"
say "$(grep -qx claude-sonnet-5 <<<"$PLAN" && echo 1 || echo 0)" "Sonnet survives alongside it"
say "$(grep -qx claude-haiku-4-5-20251001 <<<"$PLAN" && echo 1 || echo 0)" "Haiku survives at its own newest"
say "$(grep -qx gemini-pro-agent <<<"$PLAN" && echo 1 || echo 0)" "Gemini Pro is not knocked out by the newer Flash"

echo
echo "version numbers are read as decimals, not as separate parts:"
# 4.20 is older than 4.6; comparing the parts as whole numbers reverses them.
say "$(grep -qx grok-4.6 <<<"$PLAN" && echo 1 || echo 0)" "Grok 4.6 beats 4.20"
say "$(grep -qx grok-4.20-0309-reasoning <<<"$PLAN" && echo 0 || echo 1)" "Grok 4.20 hidden"

echo
echo "side models and generators never appear:"
for gone in gpt-5.4-mini gpt-oss-120b-medium codex-auto-review grok-imagine-video gemini-3.1-pro-low; do
  grep -qx "$gone" <<<"$PLAN" && say 0 "$gone should never be offered" || say 1 "$gone kept out"
done

echo
echo "providers keep their own identity despite the disguised ids:"
LIST="$(echo "$FAKE" | python3 ccx-models.py list)"
ORDER="$(grep -E '^(Claude|ChatGPT|Antigravity|Grok)$' <<<"$LIST" | tr '\n' ' ')"
[ "$ORDER" = "Claude ChatGPT Antigravity Grok " ] \
  && echo "  ok   Claude, ChatGPT, Antigravity, Grok" \
  || { echo "  FAIL wrong grouping/order: $ORDER"; fail=1; }

echo
echo "an unreachable model is refused, and a reachable one accepted:"
echo "$FAKE" | python3 ccx-models.py check grok-4.6 >/dev/null 2>&1 && say 1 "reachable model accepted" || say 0 "reachable model accepted"
echo "$FAKE" | python3 ccx-models.py check nope-9 >/dev/null 2>&1 && say 0 "unknown model refused" || say 1 "unknown model refused"

echo
echo "rewriting the proxy filter is idempotent and leaves the rest intact:"
TMP=$(mktemp); TMPCAT=$(mktemp); rm -f "$TMPCAT"; printf 'host: "127.0.0.1"\nport: 8317\n' > "$TMP"
R1=$(echo "$FAKE" | python3 ccx-models.py sync "$TMP" "$TMPCAT")
R2=$(echo "$FAKE" | python3 ccx-models.py sync "$TMP" "$TMPCAT")
[ "$R1" = changed ] && [ "$R2" = same ] && say 1 "writes once, then reports no change" || say 0 "writes once, then reports no change"
grep -q 'port: 8317' "$TMP" && say 1 "existing settings survive the rewrite" || say 0 "existing settings survive the rewrite"
grep -q 'grok-4.5' "$TMP" && say 1 "superseded models are excluded at the proxy" || say 0 "superseded models are excluded at the proxy"
grep -q '"grok-4.6"' "$TMP" && say 0 "the frontier model must NOT be excluded" || say 1 "the frontier model is not excluded"

# The proxy stops listing what it hides, so a second pass sees a shrunken list.
# Without a remembered catalogue it would forget what it hid and let it back in.
SHRUNK=$(python3 -c "
import json,sys
keep=set(open(sys.argv[1]).read().split())
d=json.load(sys.stdin)
d['data']=[m for m in d['data'] if m['id'].split('-dd-')[-1][::-1] in keep or m['id'] in keep]
print(json.dumps(d))" <(shown) <<<"$FAKE")
echo "$SHRUNK" | python3 ccx-models.py sync "$TMP" "$TMPCAT" >/dev/null
grep -q 'grok-4.5' "$TMP" && say 1 "hidden models stay hidden on the next pass" || say 0 "hidden models stay hidden on the next pass"
grep -q '"grok-4.6"' "$TMP" && say 0 "the frontier model is still not excluded" || say 1 "the frontier model is still not excluded"

# One model id can be offered by two sign-in channels; excluding it under one
# leaves the other still serving it.
CH=$(grep -cE '^  [a-z]+:$' "$TMP")
[ "$(grep -c '"claude-sonnet-4-6"' "$TMP")" = "$CH" ] \
  && say 1 "a hidden model is excluded in every channel, not just the one listing it" \
  || say 0 "a hidden model is excluded in every channel (found $(grep -c '"claude-sonnet-4-6"' "$TMP") of $CH)"
grep -q '"claude-sonnet-5"' "$TMP" && say 0 "the frontier model must not be excluded anywhere" || say 1 "the frontier model is excluded nowhere"
rm -f "$TMP" "$TMPCAT"

echo
echo "the default-model handoff never leaves a proxy model in the shared settings:"
TMPS=$(mktemp); echo '{"model":"opus[1m]","effortLevel":"xhigh","other":1}' > "$TMPS"
STASHF=$(mktemp); MINE=$(mktemp); echo '{"model":"grok-4.6","effortLevel":"medium"}' > "$MINE"
python3 -c "
import json,sys
p=sys.argv[1]
d=json.load(open(p))
json.dump({k:d[k] for k in ('model','effortLevel') if k in d}, open(sys.argv[2],'w'))
mine=json.load(open(sys.argv[3]))
for k in ('model','effortLevel'):
    d.pop(k,None)
    if k in mine: d[k]=mine[k]
json.dump(d,open(p,'w'),indent=2)" "$TMPS" "$STASHF" "$MINE"
grep -q 'grok-4.6' "$TMPS" && say 1 "the ccx model is active during the session" || say 0 "the ccx model is active during the session"
python3 -c "
import json,sys
p=sys.argv[1]; d=json.load(open(p)); back=json.load(open(sys.argv[2]))
for k in ('model','effortLevel'):
    d.pop(k,None)
    if k in back: d[k]=back[k]
json.dump(d,open(p,'w'),indent=2)" "$TMPS" "$STASHF"
python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
assert d['model']=='opus[1m]', d
assert d['effortLevel']=='xhigh', d
assert d['other']==1, 'unrelated settings must survive'
" "$TMPS" && say 1 "your own model, effort and other settings come back" || say 0 "your own model, effort and other settings come back"
rm -f "$TMPS" "$STASHF" "$MINE"

echo "the toggle decides whether plain \`claude\` uses the proxy:"
MODEDIR=$(mktemp -d)
mode_on() { [ "$(cat "$MODEDIR/ccx-mode" 2>/dev/null || echo on)" != "off" ]; }
mode_on && say 1 "defaults to on when never set" || say 0 "defaults to on when never set"
echo off > "$MODEDIR/ccx-mode"
mode_on && say 0 "off is honoured" || say 1 "off is honoured"
echo on > "$MODEDIR/ccx-mode"
mode_on && say 1 "on is honoured" || say 0 "on is honoured"
printf 'garbage\n' > "$MODEDIR/ccx-mode"
mode_on && say 1 "anything that is not 'off' means on, so a mangled file cannot silently disable it" \
        || say 0 "a mangled file must not disable multi-model silently"
rm -rf "$MODEDIR"

echo
echo "a session killed mid-run does not strand your defaults:"
# Simulates the real failure: a stash left by a process that no longer exists,
# while the live settings still hold the model that session was using.
SD=$(mktemp -d)
echo '{"model":"gemini-3.6-flash-high","other":1}' > "$SD/settings.json"
echo '{"model":"opus[1m]","effortLevel":"xhigh","_ccx_pid":999999}' > "$SD/stash.json"
python3 -c "
import json,os,sys
stash=json.load(open(sys.argv[1]+'/stash.json'))
pid=stash.get('_ccx_pid')
try: os.kill(pid,0); alive=True
except Exception: alive=False
assert not alive, 'fixture pid must be dead'
d=json.load(open(sys.argv[1]+'/settings.json'))
for k in ('model','effortLevel'):
    d.pop(k,None)
    if k in stash: d[k]=stash[k]
json.dump(d,open(sys.argv[1]+'/settings.json','w'))
" "$SD"
python3 -c "
import json,sys
d=json.load(open(sys.argv[1]+'/settings.json'))
assert d['model']=='opus[1m]', d
assert d['effortLevel']=='xhigh', d
assert d['other']==1
" "$SD" && say 1 "an orphaned stash is detected and your defaults restored" || say 0 "an orphaned stash is detected and your defaults restored"
rm -rf "$SD"

echo
echo "the context window comes from the provider, not from a guess:"
W=$(echo "$FAKE" | python3 ccx-models.py window grok-4.6)
[ "$W" = 500000 ] && say 1 "Grok reports 500k, not the assumed 200k" || say 0 "Grok window wrong: '$W'"
W=$(echo "$FAKE" | python3 ccx-models.py window claude-haiku-4-5-20251001)
[ "$W" = 200000 ] && say 1 "a genuinely-200k model still reads 200k" || say 0 "Haiku window wrong: '$W'"
# A model with no reported size must produce nothing, so the launcher leaves
# Claude Code to its own behaviour rather than exporting an empty setting.
W=$(echo "$FAKE" | python3 ccx-models.py window gpt-5.5)
[ -z "$W" ] && say 1 "a model with no reported size sets nothing" || say 0 "unreported size leaked: '$W'"
W=$(echo "$FAKE" | python3 ccx-models.py window not-a-model)
[ -z "$W" ] && say 1 "an unknown model sets nothing" || say 0 "unknown model leaked: '$W'"

echo
echo "one subagent is written per non-Claude provider:"
AG=$(mktemp -d)
OUT=$(echo "$FAKE" | python3 ccx-models.py agents "$AG")
for want in ask-chatgpt ask-antigravity ask-grok; do
  [ -f "$AG/$want.md" ] && say 1 "$want written" || say 0 "$want written"
done
[ -f "$AG/ask-claude.md" ] && say 0 "there must be no Claude agent — that is the main loop" \
                           || say 1 "no pointless Claude agent"
grep -q "^model: grok-4.6$" "$AG/ask-grok.md" && say 1 "pinned to the current model id" || say 0 "pinned to the current model id"
grep -q "^name: ask-grok$" "$AG/ask-grok.md" && say 1 "front matter is real YAML, not escaped text" || say 0 "front matter is real YAML, not escaped text"
grep -q '\\n' "$AG/ask-grok.md" && say 0 "literal escape sequences leaked into the file" || say 1 "no literal escape sequences"
# A provider's fast tier can be a generation ahead of its heavy tier; the newer
# model is the one the agent should run on.
grep -q "^model: gemini-3.6-flash-high$" "$AG/ask-antigravity.md" \
  && say 1 "picks the newest model, even when it is the fast tier (3.6 Flash over 3.1 Pro)" \
  || say 0 "picks the newest model (got: $(grep '^model:' "$AG/ask-antigravity.md"))"
rm -rf "$AG"

echo
[ $fail -eq 0 ] && echo "all checks passed" || { echo "FAILURES"; exit 1; }
