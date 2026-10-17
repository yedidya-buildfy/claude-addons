#!/bin/bash
# Render-test every screen + variant of an app map. Usage: bash check.sh <design-dir> [scratch-dir]
# Inlines the screen scripts (file:// hides real errors as "Script error") and prints "OK <screens>" or the errors.
D=${1:?design dir}; T=${2:-${TMPDIR:-/tmp}/app-map-check}; rm -rf $T && mkdir -p $T && cp -R $D/. $T/
python3 -I - $T <<'PY'
import re,sys,os
t=sys.argv[1];p=os.path.join(t,'app-map.html');s=open(p).read()
s=re.sub(r'<script src="(screens[\w-]*\.js)"></script>',lambda m:'<script>'+open(os.path.join(t,m.group(1))).read()+'\n</script>',s)
s=s.replace('<head>','<head><script>window.onerror=(m,s,l)=>{document.title="ERR "+m+" @line "+l};</script>',1)
s=s.replace('</body>','<script>setTimeout(()=>{if(!document.title.startsWith("ERR"))document.title="OK "+document.querySelectorAll(".node").length;S.list.forEach(n=>n.variants.forEach(v=>{try{v.html()}catch(e){document.title+=" | "+n.id+": "+e.message}}))},600)</script></body>')
open(p,'w').write(s)
PY
"${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" --headless=new --disable-gpu --virtual-time-budget=3000 --dump-dom "file://$T/app-map.html" 2>/dev/null | grep -o "<title>[^<]*" | sed 's/<title>//'
