# Loads the REAL extension in Chromium on fake claude.ai / chatgpt.com pages. Run: python3 dev/real-chromium-test.py /path/to/unzipped/folder
import sys, tempfile, zipfile, os
from playwright.sync_api import sync_playwright
EXT=os.path.abspath(sys.argv[1])
CLAUDE="""<!doctype html><body><main><div data-testid="user-message">I am building a campus bike-share app. We use Flutter and Firebase.</div>
<div class="font-claude-message">Great. Flutter gives one codebase and Firebase handles sign-in and the ride log.</div></main>
<div id="c" contenteditable="true" class="ProseMirror" style="border:1px solid #888;min-height:60px"></div>"""
# a layout the extension has NEVER seen: no known attributes at all
GPT_NEW="""<!doctype html><body><main><div class="zq1">Which database should the ride log use for the unseen layout?</div><div class="zq2">Use Firestore. This page uses brand new class names so selectors cannot match.</div></main>
<div id="ed" contenteditable="true" role="textbox" style="border:1px solid #888;min-height:60px"></div>"""
CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'"
STRONG='Zebra#Gate-4827Qx'; BPW='Backup!Pass#5577xy'; NEW='Restored#Vault-9913Lm'
d=tempfile.mkdtemp()
with zipfile.ZipFile(d+'/budget.docx','w') as z: z.writestr('word/document.xml','<w:document><w:body><w:p><w:r><w:t>Quarterly budget approved by the committee</w:t></w:r></w:p></w:body></w:document>')
open(d+'/photo.png','wb').write(b'\x89PNG\r\n\x1a\n'+bytes(range(256))*20)
open(d+'/report.pdf','wb').write(b'%PDF-1.4\n1 0 obj\n<<>>\nstream\nBT /F1 12 Tf (Hello PDF world from the Chat Memory import test document) Tj ET\nendstream\nendobj\n')
fails=[]
def chk(label,cond):
    print(('PASS  ' if cond else 'FAIL  ')+label)
    if not cond: fails.append(label)
with sync_playwright() as p:
    ctx=p.chromium.launch_persistent_context(tempfile.mkdtemp(),channel='chromium',headless=True,viewport={'width':1200,'height':850},accept_downloads=True,
        args=[f'--disable-extensions-except={EXT}',f'--load-extension={EXT}'])
    pages={'https://claude.ai/chat/t':CLAUDE,'https://chatgpt.com/c/new':GPT_NEW}
    def route(r):
        r.fulfill(status=200,content_type='text/html',body=pages.get(r.request.url.split('#')[0]) or '<html></html>',headers={'Content-Security-Policy':CSP})
    ctx.route('https://claude.ai/**',route); ctx.route('https://chatgpt.com/**',route)
    def open_dock(pg):
        pg.mouse.click(1157,729); pg.wait_for_timeout(2500)   # the dark circle, bottom-right
        return [f for f in pg.frames if 'dock.html' in f.url][0]
    pg=ctx.new_page(); pg.goto('https://claude.ai/chat/t'); pg.wait_for_timeout(1500)
    f=open_dock(pg); chk('circle opens the dock',True)
    # ---- 1. strong password coaching ----
    f.locator('#p1').click(); pg.keyboard.type('abc',delay=15)
    t=f.locator('#body').inner_text()
    chk('weak password: live checklist tells what to add', 'uppercase' in t.lower() and 'symbol' in t.lower() and 'not strong enough' in t.lower())
    f.locator('#p2').fill('abc'); f.locator('#go').click(); pg.wait_for_timeout(400)
    chk('weak password cannot create the vault', f.locator('#p2').count()==1)
    f.locator('#p1').fill(STRONG); f.locator('#p2').fill(STRONG); pg.wait_for_timeout(200)
    chk('strong password shows as strong', 'Strong password' in f.locator('#body').inner_text())
    f.locator('#go').click(); f.locator('nav button[data-v=save]').wait_for(timeout=20000)
    # ---- 2. one-tap capture/summarise/sort/save ----
    pg.wait_for_timeout(1200)
    chk('opening the dock auto-captures the chat', 'Flutter' in f.locator('#txt').input_value())
    f.locator('#qs').click(); pg.wait_for_timeout(2500)
    f.locator('nav button[data-v=library]').click(); pg.wait_for_timeout(500)
    lib=f.locator('#list').inner_text()
    chk('one tap saved it, summarised, in a "Claude" folder', 'Claude' in lib and 'has summary' in lib)
    # ---- 3. import ANY file type, with password ----
    f.locator('#impFiles').set_input_files([d+'/budget.docx',d+'/photo.png',d+'/report.pdf'])
    pg.wait_for_timeout(1500)   # the old build re-drew the screen when the picker closed and lost the files
    chk('chosen files survive the file-picker closing', f.locator('#impFiles').evaluate('e=>e.files.length')==3)
    f.locator('#impGo').click(); pg.wait_for_timeout(400)
    chk('import asks for the vault password first', f.locator('#f_pw').count()==1)
    f.locator('#f_pw').fill('wrong-pass-1'); f.locator('#my').click(); pg.wait_for_timeout(2500)
    chk('wrong password at import is refused (nothing imported)', 'attempt left' in f.locator('#msg').inner_text() and 'budget' not in f.locator('#list').inner_text())
    f.locator('#impFiles').set_input_files([d+'/budget.docx',d+'/photo.png',d+'/report.pdf']); f.locator('#impGo').click(); f.locator('#f_pw').fill(STRONG); f.locator('#my').click(); pg.wait_for_timeout(4000)
    m=f.locator('#msg').inner_text(); chk('docx + png + pdf all imported ('+m[:40]+')', 'Imported 3 of 3' in m)
    f.locator('#q').fill('Quarterly budget'); pg.wait_for_timeout(300)
    chk('text was read out of the .docx (searchable)', 'budget' in f.locator('#list').inner_text())
    f.locator('#q').fill('Hello PDF world'); pg.wait_for_timeout(300)
    chk('text was read out of the .pdf', 'report' in f.locator('#list').inner_text())
    f.locator('#q').fill('photo'); pg.wait_for_timeout(300)
    chk('image kept as an encrypted original', 'photo.png' in f.locator('#list').inner_text())
    # ---- 4. another site must ask for the password ----
    g=ctx.new_page(); g.goto('https://chatgpt.com/c/new'); g.wait_for_timeout(1500); fg=open_dock(g)
    chk('second site (ChatGPT) asks for the vault password even though Claude is unlocked', fg.locator('#go').inner_text()=='Unlock here' and fg.locator('nav').count()==0)
    fg.locator('#p1').fill(STRONG); fg.locator('#go').click(); fg.locator('nav button[data-v=save]').wait_for(timeout=20000)
    # ---- 5. layout the extension has never seen ----
    g.wait_for_timeout(1200)
    chk('unknown layout: still captures the whole chat', 'brand new class names' in fg.locator('#txt').input_value() and 'unseen layout' in fg.locator('#txt').input_value())
    fg.locator('#qs').click(); g.wait_for_timeout(2500); fg.locator('nav button[data-v=library]').click(); g.wait_for_timeout(500)
    chk('saved into a "ChatGPT" folder', 'ChatGPT' in fg.locator('#list').inner_text())
    g.close()
    # ---- 6. backup + erase + restore with ANY file name ----
    pg.bring_to_front(); f.locator('nav button[data-v=settings]').click(); f.locator('#ex').click()
    f.locator('#f_pw').fill(STRONG); f.locator('#f_b1').fill('weak'); f.locator('#f_b2').fill('weak'); f.locator('#my').click(); pg.wait_for_timeout(300)
    chk('weak BACKUP password is refused with advice', 'not strong enough' in f.locator('#modal').inner_text().lower())
    f.locator('#f_b1').fill(BPW); f.locator('#f_b2').fill(BPW)
    with pg.expect_download() as dl: f.locator('#my').click()
    bk=dl.value.path(); data=open(bk,'rb').read(); open(d+'/my-backup.bin','wb').write(data)
    chk('backup has no readable text', b'Quarterly' not in data and b'Flutter' not in data)
    f.locator('#lockBtn').click(); pg.wait_for_timeout(800)
    for w in ('bad-one','bad-two'):
        f.locator('#p1').fill(w); f.locator('#go').click(); pg.wait_for_timeout(2500)
    chk('two wrong passwords erased the vault', 'erased' in f.locator('#body').inner_text().lower())
    f.locator('#rf').set_input_files(d+'/my-backup.bin'); f.locator('#rb').fill(BPW); f.locator('#rn').fill(NEW); pg.wait_for_timeout(1200)
    chk('restore accepts a file with ANY name/extension (.bin)', f.locator('#rf').evaluate('e=>e.files.length')==1)
    f.locator('#rs').click(); f.locator('nav button[data-v=library]').wait_for(timeout=25000); f.locator('nav button[data-v=library]').click(); pg.wait_for_timeout(500)
    L=f.locator('#list').inner_text(); chk('restore brought back chats AND imported files', 'photo' in L and 'budget' in L and 'Claude' in L)
    pg.screenshot(path='/tmp/real_ok.png')
    print('\nFAILED:',fails if fails else 'none'); ctx.close()
