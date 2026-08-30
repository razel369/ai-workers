import assert from 'node:assert/strict';
import { csvCell, csvRow } from './csv-security.js';

const malicious = [
  '=HYPERLINK("https://attacker.invalid","click")',
  '+SUM(1,1)',
  '-2+3',
  '@IMPORTXML("https://attacker.invalid")',
  '  =cmd|\' /C calc\'!A0',
  '\t@SUM(1,1)',
  '\u200b=1+1',
  '\ufeff-10+20',
];

for (const value of malicious) {
  const cell = csvCell(value);
  const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
  assert.ok(unquoted.startsWith("'"), `formula prefix was not neutralized: ${JSON.stringify(value)} -> ${JSON.stringify(cell)}`);
}

assert.equal(csvCell('Dana Levi'), 'Dana Levi');
assert.equal(csvCell('hello, world'), '"hello, world"');
assert.equal(csvCell('a"b'), '"a""b"');
assert.equal(csvRow(['name', '=1+1']), "name,'=1+1");

console.log('OK    CSV cells neutralize formula prefixes including hidden whitespace/control characters');
