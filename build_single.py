import re
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
