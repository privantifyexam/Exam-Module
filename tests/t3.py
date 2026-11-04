from playwright.sync_api import sync_playwright
import os
F='file://'+os.path.abspath('dist/index.html'); stub=open('tests/stub.js').read()
with sync_playwright() as p:
    b=p.chromium.launch(); errs=[]
    c=b.new_context(viewport={'width':390,'height':844}); c.add_init_script(stub)
    pg=c.new_page(); pg.on('pageerror',lambda e: errs.append(str(e))); pg.goto(F); pg.wait_for_timeout(600)
    pg.evaluate("async()=>{exam.codeHash=await hashCode('K7PQ2M',String(exam.startedAt));}")
    pg.fill('#fName','Anitha Menon'); pg.fill('#fPhone','9847012345'); pg.select_option('#fPos','Pharmacist'); pg.click('#loginBtn'); pg.wait_for_timeout(300)
    print('screen', pg.evaluate("['sLogin','sCode','sReady'].filter(s=>!$(s).hidden)"))
    pg.fill('#fCode','abc12'); pg.click('#codeBtn'); pg.wait_for_timeout(200); print(pg.text_content('#fCodeErr'))
    pg.fill('#fCode','zzzz99'); pg.click('#codeBtn'); pg.wait_for_timeout(300); print(pg.text_content('#fCodeErr')); pg.screenshot(path='c1.png')
    pg.fill('#fCode','k7pq2m'); pg.click('#codeBtn'); pg.wait_for_timeout(300)
    print('screen', pg.evaluate("['sLogin','sCode','sReady'].filter(s=>!$(s).hidden)"))
    pg.click('#beginBtn'); pg.wait_for_timeout(300); print('quiz', not pg.evaluate("$('sQuiz').hidden"))
    a=b.new_context(viewport={'width':1280,'height':900}); a.add_init_script('window.__admin=true;'+stub)
    pa=a.new_page(); pa.on('pageerror',lambda e: errs.append(str(e))); pa.goto(F+'#pharmacist'); pa.wait_for_timeout(600)
    pa.click('#aEnd'); pa.click('#aEndYes'); pa.wait_for_timeout(300); pa.click('#aStart'); pa.wait_for_timeout(500)
    print('code', pa.text_content('#aCode'), pa.text_content('#aMsgT'))
    pa.click('#aCodeNew'); pa.wait_for_timeout(500); print('new', pa.text_content('#aCode'))
    pa.locator('.grid2').screenshot(path='c2.png')
    print(errs); b.close()
