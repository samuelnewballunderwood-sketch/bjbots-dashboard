const fs = require('fs');

const html = fs.readFileSync('dashboard.html', 'utf8');
const htmlEscaped = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const worker = fs.readFileSync('worker.js', 'utf8');
const bundle = 'const DASHBOARD_HTML = `' + htmlEscaped + '`;\n\n' + worker;
fs.writeFileSync('worker-bundle.js', bundle);
console.log('Bundle built:', bundle.length, 'bytes');
