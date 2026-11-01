#!/bin/sh
# 用 headless Chrome 跑 names.html，对照 expect.txt 检查资源名推测
D=$(cd "$(dirname "$0")/.." && pwd)
H="$D/test/harness.html"
sed 's#</body>#<script src="../content.js"></script><script>const s=__lodestone.scan();document.body.textContent="RESULT"+JSON.stringify(s.map(h=>[parseInt(h.key.replace(/^f+/,""),16),h.source,h.name]));</script></body>#' "$D/test/names.html" > "$H"
OUT=$("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --dump-dom "file://$H" 2>/dev/null | grep -o 'RESULT.*' | sed 's/<.*//; s/^RESULT//')
rm -f "$H"
python3 -c '
import json,sys,html
out=json.loads(html.unescape(sys.argv[1])); exp=dict(l.split(" ",1) for l in open(sys.argv[2]).read().strip().split("\n"))
got={str(k):(s,n) for k,s,n in out}; ok=0
for k,v in exp.items():
    s,n=got.get(k,("-","缺失")); ok+=n==v
    print("OK " if n==v else "BAD", k, s, repr(n))
print(ok,"/",len(exp))' "$OUT" "$D/test/expect.txt"
