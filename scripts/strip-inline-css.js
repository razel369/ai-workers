import fs from 'fs';
import path from 'path';

const p = path.join(process.cwd(), 'workers-ui.html');
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  /<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Rubik[^"]+" rel="stylesheet">\s*<link rel="stylesheet" href="\/assets\/material3-theme\.css[^"]*">/,
  `<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Hebrew:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Secular+One&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/material3-theme.css?v=nightdesk2">`,
);
s = s.replace(
  /<style>[\s\S]*?<\/style>/,
  '<style>.icon-spin{animation:spin 1s linear infinite;color:var(--lamp)}@keyframes spin{to{transform:rotate(360deg)}}</style>',
);
s = s.replace('<body>', '<body class="night-desk">');
fs.writeFileSync(p, s, 'utf8');
console.log('done', { secular: s.includes('Secular'), nightDesk: s.includes('night-desk'), noRubik: !s.includes('Rubik') });
