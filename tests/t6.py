from playwright.sync_api import sync_playwright
import os
F='file://'+os.path.abspath('dist/index.html'); stub=open('tests/stub.js').read()
with sync_playwright() as p:
    b=p.chromium.launch(); errs=[]
    a=b.new_context(viewport={'width':390,'height':844}); a.add_init_script('window.__admin=true;'+stub)
    pa=a.new_page(); pa.on('pageerror',lambda e: errs.append(str(e))); pa.goto(F+'#pharmacist'); pa.wait_for_timeout(700)
    pa.click('#aEnd'); pa.click('#aEndYes'); pa.wait_for_timeout(300); pa.click('#aStart'); pa.wait_for_timeout(600)
    real=pa.text_content('#aCode')
    pa.click('#aTry'); pa.wait_for_timeout(300); pa.click('#loginBtn'); pa.wait_for_timeout(300)
    print(pa.text_content('#fCodeHelp'))
    pa.fill('#fCode',real); pa.click('#codeBtn'); pa.wait_for_timeout(400)
    print('real code ->', pa.evaluate("['sCode','sReady'].filter(s=>!$(s).hidden)"))
    pa.click('#pvRestart'); pa.wait_for_timeout(300); pa.click('#loginBtn'); pa.wait_for_timeout(300)
    pa.fill('#fCode',pa.text_content('#pvCode')); pa.click('#codeBtn'); pa.wait_for_timeout(400)
    print('demo code ->', pa.evaluate("['sCode','sReady'].filter(s=>!$(s).hidden)"), errs)
    b.close()
