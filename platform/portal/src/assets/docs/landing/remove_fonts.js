const fs = require('fs');
const path = require('path');

const p = path.join('d:/SERVER-automation/platform/docs/landing/index.html');
let html = fs.readFileSync(p, 'utf8');

// Remove external fonts
html = html.replace(/<link rel="preconnect"[^>]*>/g, '');
html = html.replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/g, '<style>@font-face{font-family:"Inter";src:local("Arial");}@font-face{font-family:"JetBrains Mono";src:local("Consolas");}</style>');

// We actually NEED three.js for the 3D hero. If we remove the CDN script, the 3D canvas will be blank unless we download it locally.
// Let's NOT remove three.js, it's fine to load from CDN. 

fs.writeFileSync(p, html);
