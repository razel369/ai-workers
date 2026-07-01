import fs from 'node:fs';

const rent = {
  'sales-leads-il': 249,
  'support-he': 249,
  'data-entry': 199,
  'content-he': 249,
  'real-estate-il': 249,
  'clinic-receptionist-he': 299,
  'restaurant-manager-he': 249,
  'ecom-support-he': 249,
  'property-manager-he': 299,
};

let s = fs.readFileSync('workers.js', 'utf8');
for (const [id, r] of Object.entries(rent)) {
  const block = new RegExp(`(id: '${id}'[\\s\\S]*?buyPriceIls: )\\d+,\\n(\\s*rentPriceIls: )\\d+,`);
  s = s.replace(block, `$1${0},\n$2${r},`);
}
fs.writeFileSync('workers.js', s);
console.log('SaaS pricing applied');
