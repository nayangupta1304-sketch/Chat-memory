# v3.1 real-Chromium checks: export formats, import under any file name, plain-file import, multi-chunk file, storage meter.
# Run: python3 dev/real-chromium-test2.py /path/to/unzipped/folder [screenshot_dir]
import sys, tempfile, os, hashlib
from playwright.sync_api import sync_playwright
EXT=os.path.abspath(sys.argv[1]); SHOTS=sys.argv[2] if len(sys.argv)>2 else None
CLAUDE="""<!doctype html><body><main><div data-testid="user-message">I am building a campus bike-share app. We use Flutter and Firebase.</div>
<div class="font-claude-message">Great. Flutter gives one codebase and Firebase handles sign-in and the ride log.</div></main>
<div id="c" contenteditable="true" class="ProseMirror" style="border:1px solid #888;min-height:60px"></div>"""
CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'"
STRONG='Zebra#Gate-4827Qx'; BPW='Backup!Pass#5577xy'
d=tempfile.mkdtemp(); big=os.urandom(6*1024*1024+77); open(d+'/big.dat','wb').write(big); open(d+'/weird.xyz','wb').write(b'plain notes in a strange format\n'*5)
fails=[]
def chk(l,c):
    print(('PASS  ' if c else 'FAIL  ')+l)
    if not c: fails.append(l)
def shot(pg,name):
    if SHOTS: pg.screenshot(path=os.path.join(SHOTS,name))
with sync_playwright() as p:
    ctx=p.chromium.launch_persistent_context(tempfile.mkdtemp(),channel='chromium',headless=True,viewport={'width':1200,'height':850},accept_downloads=True,
        args=[f'--disable-extensions-except={EXT}',f'--load-extension={EXT}'])
    ctx.route('https://claude.ai/**',lambda r:r.fulfill(status=200,content_type='text/html',body=CLAUDE,headers={'Content-Security-Policy':CSP}))
    pg=ctx.new_page(); pg.goto('https://claude.ai/chat/t'); pg.wait_for_timeout(1500)
    pg.mouse.click(1157,729); pg.wait_for_timeout(2500); f=[x for x in pg.frames if 'dock.html' in x.url][0]
    # strength bar + label + show/hide
    f.locator('#p1').click(); pg.keyboard.type('Hello12',delay=10); pg.wait_for_timeout(200); shot(pg,'01_weak.png')
    chk('meter labels a weak password', f.locator('#lab_p1').inner_text() in ('Too weak','Weak'))
    f.locator('#p1').fill('Zebra#Gate-4827'); pg.wait_for_timeout(200); chk('meter shows Fair/Strong while rules are missing or met', f.locator('#lab_p1').inner_text() in ('Fair','Strong','Very strong','Weak'))
    f.locator('#p1').fill(STRONG); f.locator('#p2').fill(STRONG); pg.wait_for_timeout(600); shot(pg,'02_strong.png')
    chk('strong password: label Strong/Very strong', f.locator('#lab_p1').inner_text() in ('Strong','Very strong'))
    f.locator('#show_p1').check(); chk('show-password toggle works', f.locator('#p1').get_attribute('type')=='text')
    f.locator('#go').click(); f.locator('nav button[data-v=save]').wait_for(timeout=20000); pg.wait_for_timeout(1200)
    f.locator('#qs').click(); pg.wait_for_timeout(2500)
    # multi-chunk file (6 MB => 4 chunks)
    f.locator('nav button[data-v=library]').click(); f.locator('#impFiles').set_input_files(d+'/big.dat'); f.locator('#impGo').click()
    f.locator('#f_pw').fill(STRONG); f.locator('#my').click(); pg.wait_for_timeout(6000)
    chk('6 MB file imported in chunks', 'Imported 1 of 1' in f.locator('#msg').inner_text()); shot(pg,'03_library.png')
    f.locator('details summary:has-text("big.dat")').first.click(); 
    with pg.expect_download() as dl: f.locator('button[data-a=dl]').first.click()
    chk('chunked download returns the identical file', hashlib.sha256(open(dl.value.path(),'rb').read()).hexdigest()==hashlib.sha256(big).hexdigest())
    f.locator('nav button[data-v=settings]').click(); pg.wait_for_timeout(300)
    chk('storage meter shows usage of 25 GB', '25.00 GB' in f.locator('#v').inner_text() and 'used of' in f.locator('#v').inner_text()); shot(pg,'04_settings.png')
    # export formats
    def export(fmt):
        f.locator('#ex').click(); f.locator('#f_pw').fill(STRONG); f.locator('#f_fmt').select_option(fmt); f.locator('#f_b1').fill(BPW); f.locator('#f_b2').fill(BPW)
        if fmt=='json': pg.wait_for_timeout(500); shot(pg,'05_export_modal.png')
        with pg.expect_download() as dl: f.locator('#my').click()
        return dl.value
    def wipe_items():
        f.locator('nav button[data-v=library]').click(); pg.wait_for_timeout(300)
        while f.locator('button[data-a=del]').count():
            f.locator('details summary').first.click(); f.locator('button[data-a=del]').first.click(); f.locator('#my').click(); pg.wait_for_timeout(500)
        f.locator('nav button[data-v=settings]').click(); pg.wait_for_timeout(300)
    for fmt,ext,name in (('txt','.cmbackup.txt','notes.docx'),('json','.cmbackup.json','picture.png'),('cmbak','.cmbak','data.pdf')):
        dlf=export(fmt); chk(f'{fmt}: suggested name ends with {ext}', dlf.suggested_filename.endswith(ext))
        raw=open(dlf.path(),'rb').read(); chk(f'{fmt}: no readable text inside', b'Flutter' not in raw and b'Firebase' not in raw)
        os.rename(dlf.path(),d+'/'+name) if False else open(d+'/'+name,'wb').write(raw)
        wipe_items()
        f.locator('#fi').set_input_files(d+'/'+name); f.locator('#im').click(); f.locator('#f_bp').wait_for(timeout=15000)
        chk(f'{fmt}: saved as "{name}" is recognised as a backup and asks for the BACKUP password', 'BACKUP password' in f.locator('#modal').inner_text())
        f.locator('#f_bp').fill('Wrong#Pass9999xx'); f.locator('#f_pw').fill(STRONG); f.locator('#my').click()
        try: f.locator('#msg:has-text("Wrong backup password")').wait_for(timeout=15000)
        except Exception: pass
        chk(f'{fmt}: wrong backup password refused', 'Wrong backup password' in f.locator('#msg').inner_text())
        f.locator('#fi').set_input_files(d+'/'+name); f.locator('#im').click(); f.locator('#f_bp').wait_for(timeout=15000)
        f.locator('#f_bp').fill(BPW); f.locator('#f_pw').fill(STRONG); f.locator('#my').click(); pg.wait_for_timeout(5000)
        m=f.locator('#msg').inner_text(); chk(f'{fmt}: import restored the items ({m[:45]})', m.startswith('Imported 2 memories'))
    f.locator('nav button[data-v=library]').click(); pg.wait_for_timeout(500)
    chk('big file is back after the .cmbak import', 'big.dat' in f.locator('#list').inner_text())
    f.locator('details summary:has-text("big.dat")').first.click()
    with pg.expect_download() as dl: f.locator('button[data-a=dl]').first.click()
    chk('...and byte-identical', hashlib.sha256(open(dl.value.path(),'rb').read()).hexdigest()==hashlib.sha256(big).hexdigest())
    # any other format = plain file
    f.locator('nav button[data-v=settings]').click(); f.locator('#fi').set_input_files(d+'/weird.xyz'); f.locator('#im').click(); f.locator('#f_pw').wait_for(timeout=15000)
    chk('a non-backup file is accepted as an ordinary file', 'ordinary file' in f.locator('#modal').inner_text())
    f.locator('#f_pw').fill(STRONG); f.locator('#my').click(); pg.wait_for_timeout(2500)
    chk('plain file imported', 'File imported' in f.locator('#msg').inner_text())
    print('\nFAILED:',fails if fails else 'none'); ctx.close()
