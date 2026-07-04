const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const svgPath = path.join(__dirname, '..', 'brand', 'og-nightdesk.svg');
const pngPath = path.join(__dirname, '..', 'brand', 'og-nightdesk.png');

const svg = fs.readFileSync(svgPath, 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 1200 },
  background: '#080b10',
});
const png = resvg.render().asPng();
fs.writeFileSync(pngPath, png);
console.log('Wrote', pngPath, png.length, 'bytes');