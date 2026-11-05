import re, datetime
try:
    from zoneinfo import ZoneInfo
    _now = datetime.datetime.now(ZoneInfo("Europe/London"))
except Exception:
    _now = datetime.datetime.utcnow()
STAMP = _now.strftime("%-d %b %Y, %H:%M")
SLUG = _now.strftime("%Y%m%d%H%M")
# stamp the source files so the web version, the single file and the cache all agree
_i = open('index.html', encoding='utf-8').read()
_i = re.sub(r'(<b id="verTxt">)[^<]*(</b>)', lambda m: m.group(1) + STAMP + m.group(2), _i)
open('index.html', 'w', encoding='utf-8').write(_i)
_s = open('sw.js', encoding='utf-8').read()
_s = re.sub(r"const CACHE = '[^']*';", "const CACHE = 'pitchside-" + SLUG + "';", _s)
open('sw.js', 'w', encoding='utf-8').write(_s)
print("version:", STAMP)
r=lambda p: open(p,encoding='utf-8').read()
def names(src):
    out=[]
    for m_ in re.finditer(r'^export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z0-9_$]+)', src, flags=re.M): out.append(m_.group(1))
    return out
def wrap(path):
    src=r(path); ns=names(src)
    body=re.sub(r'^import .*$\n','',re.sub(r'^export ','',src,flags=re.M),flags=re.M)
    return "const {"+",".join(ns)+"}=(()=>{\n"+body+"\nreturn {"+",".join(ns)+"};})();\n"
# order matters: a module may only use modules above it
js="const DB=(()=>{\n"+re.sub(r'^export ','',r('js/db.js'),flags=re.M)+"\nreturn {allMatches,getMatch,saveMatch,deleteMatch,newId};})();\n"
js+="".join(wrap(p) for p in ['js/export.js','js/fuse.js','js/gemini.js','js/ball.js','js/audio.js','js/sound.js','js/speech.js','js/analysis.js'])
js+=re.sub(r"^import .*$\n",'',r('js/app.js'),flags=re.M)
js=js.replace("</script>","<\\/script>")
h=r('index.html')
h=re.sub(r'<link rel="manifest"[^>]*>\n?','',h)
h=re.sub(r'<link rel="apple-touch-icon"[^>]*>\n?','',h)
h=re.sub(r'<link rel="icon"[^>]*>\n?','',h)
h=h.replace('<link rel="stylesheet" href="css/app.css">','<style>\n'+r('css/app.css')+'\n</style>')
h=h.replace('<script type="module" src="js/app.js"></script>','<script>\n'+js+'\n</script>')
open('Pitchside.html','w',encoding='utf-8').write(h)
print(len(h))
