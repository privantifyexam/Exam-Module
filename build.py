"""Build dist/index.html (single self-contained page) from src/. Run: python3 build.py"""
import re, base64, pathlib
S = pathlib.Path(__file__).parent / 'src'
tok = (S / 'assets/tokens-light.css').read_text()
light = re.search(r':root \{.*?\n\}\n', tok, re.S).group(0)
dark = re.search(r':root\[data-theme="dark"\] \{(.*?)\n\}\n', tok, re.S).group(1)
tokens = (light + '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){' + dark + '\n  color-scheme:dark;}}\n'
          ':root[data-theme="dark"]{' + dark + '\n  color-scheme:dark;}\n')
logo = 'data:image/svg+xml;base64,' + base64.b64encode((S / 'assets/sugarcare-logo.svg').read_bytes()).decode()
head = ('<title>SugarCARE Assessment</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n'
        '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">\n')
js = (S / 'app.js').read_text().replace('__QS__', (S / 'questions_pharmacist.js').read_text())
out = (head + '<style>\n' + tokens + (S / 'style.css').read_text() + '</style>\n'
       + (S / 'body.html').read_text().replace('__LOGO__', logo) + '<script>\n' + js + '</script>\n')
(pathlib.Path(__file__).parent / 'dist').mkdir(exist_ok=True)
(pathlib.Path(__file__).parent / 'dist/index.html').write_text(out)
print('dist/index.html', len(out), 'bytes')
