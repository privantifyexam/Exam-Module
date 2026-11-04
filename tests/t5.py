from playwright.sync_api import sync_playwright
import os
F='file://'+os.path.abspath('dist/index.html'); stub=open('tests/stub.js').read()
with sync_playwright() as p:
    b=p.chromium.launch(); errs=[]
    a=b.new_context(viewport={'width':390,'height':844}); a.add_init_script('window.__admin=true;'+stub)
    pa=a.new_page(); pa.on('pageerror',lambda e: errs.append(str(e))); pa.goto(F+'#pharmacist'); pa.wait_for_timeout(700)
    before=pa.evaluate("results.length")
    pa.click('#aTry'); pa.wait_for_timeout(300); pa.click('#loginBtn'); pa.wait_for_timeout(300)
    code=pa.text_content('#pvCode'); pa.fill('#fCode',code); pa.click('#codeBtn'); pa.wait_for_timeout(300)
    pa.click('#beginBtn'); pa.wait_for_timeout(500); pa.screenshot(path='p1.png')
    for i in range(50): pa.evaluate("()=>{choose(1);qShownAt=0;advance()}")
    pa.wait_for_timeout(300); pa.screenshot(path='p2.png')
    print('score', pa.text_content('#dScore')); print('save', pa.text_content('#dSave'), pa.text_content('#doneBtn'))
    print('results unchanged', before, pa.evaluate("results.length"))
    pa.click('#doneBtn'); pa.wait_for_timeout(300); print('back', pa.evaluate("['sAdmin','sHome','sLogin'].filter(s=>!$(s).hidden)"), pa.is_hidden('#pvBar'))
    print(errs); b.close()
