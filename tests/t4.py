from playwright.sync_api import sync_playwright
import os
F='file://'+os.path.abspath('dist/index.html'); stub=open('tests/stub.js').read()
with sync_playwright() as p:
    b=p.chromium.launch(); errs=[]
    a=b.new_context(viewport={'width':1280,'height':900}); a.add_init_script('window.__admin=true;'+stub)
    pa=a.new_page(); pa.on('pageerror',lambda e: errs.append(str(e))); pa.goto(F); pa.wait_for_timeout(700)
    pa.screenshot(path='h1.png')
    pa.click('[data-open="pharmacist"]'); pa.wait_for_timeout(400)
    print('ph', pa.text_content('#aTitle'), pa.evaluate("document.querySelectorAll('#aBody tr').length"), pa.text_content('#thE'), pa.input_value('#aLink'))
    pa.click('#aHome'); pa.wait_for_timeout(300); pa.click('[data-open="dietitian"]'); pa.wait_for_timeout(400)
    print('di', pa.text_content('#aTitle'), pa.is_disabled('#aStart'), pa.is_visible('#aNoQs'), pa.text_content('#aBody'))
    pa.screenshot(path='h2.png')
    c=b.new_context(viewport={'width':390,'height':844}); c.add_init_script(stub)
    pg=c.new_page(); pg.on('pageerror',lambda e: errs.append(str(e))); pg.goto(F+'#dietitian'); pg.wait_for_timeout(700)
    print('part-di', pg.text_content('#topName'), pg.text_content('#loginErr'), pg.is_disabled('#loginBtn'), pg.evaluate("[...document.querySelectorAll('#fPos option')].map(o=>o.textContent).join('|')"))
    print(errs); b.close()
