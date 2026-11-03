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
db=re.sub(r'^export ','',r('js/db.js'),flags=re.M)
an=re.sub(r'^export ','',r('js/analysis.js'),flags=re.M)
ex=re.sub(r'^export ','',r('js/export.js'),flags=re.M)
app=re.sub(r"^import .*$\n",'',r('js/app.js'),flags=re.M)
js=("const DB=(()=>{\n"+db+"\nreturn {allMatches,getMatch,saveMatch,deleteMatch,newId};})();\n"
    "const {makeHighlightsVideo,pickMime}=(()=>{\n"+ex+"\nreturn {makeHighlightsVideo,pickMime};})();\n"
    "const {scanVideo,probeVideo,processSignals,findGoals,findScoreChanges,snapToRoar,trainGoalModel}=(()=>{\n"+an+"\nreturn {DEFAULTS,percentile,processSignals,probeVideo,scanVideo,findGoals,findScoreChanges,snapToRoar,trainGoalModel};})();\n"+app)
js=js.replace("</script>","<\\/script>")
h=r('index.html')
h=re.sub(r'<link rel="manifest"[^>]*>\n?','',h)
h=re.sub(r'<link rel="apple-touch-icon"[^>]*>\n?','',h)
h=re.sub(r'<link rel="icon"[^>]*>\n?','',h)
h=h.replace('<link rel="stylesheet" href="css/app.css">','<style>\n'+r('css/app.css')+'\n</style>')
h=h.replace('<script type="module" src="js/app.js"></script>','<script>\n'+js+'\n</script>')
open('Pitchside.html','w',encoding='utf-8').write(h)
print(len(h))
