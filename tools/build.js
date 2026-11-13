const fs = require('fs'), path = require('path'), r = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const html = r('src/page.html').replace('<script id="ml-engine"></script>', () => '<script id="ml-engine">\n' + r('src/engine.js') + '</script>');
fs.writeFileSync(path.join(__dirname, '..', 'index.html'), html); console.log('index.html', html.length, 'bytes');
