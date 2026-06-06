const fs = require('fs');
const { execSync } = require('child_process');

let gitSha = 'unknown';
try { gitSha = execSync('git rev-parse --short HEAD').toString().trim(); } catch(_) {}

const buildTime = new Date().toISOString();
const versionStamp = `const BUILD_VERSION = ${JSON.stringify(gitSha)};\nconst BUILD_TIME = ${JSON.stringify(buildTime)};\n`;

const html = fs.readFileSync('dashboard.html', 'utf8');
const htmlEscaped = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const worker = fs.readFileSync('worker.js', 'utf8');
const bundle = versionStamp + 'const DASHBOARD_HTML = `' + htmlEscaped + '`;\n\n' + worker;
fs.writeFileSync('worker-bundle.js', bundle);
console.log('Bundle built:', bundle.length, 'bytes  | version:', gitSha, '| built:', buildTime);
