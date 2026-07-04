// Quality audit: real LLM responses in production. Check if Hebrew + correct flow.
const base = process.argv[2] || 'https://paid-agent-demo-production.up.railway.app';

const scenarios = [
  { template: 'sales-leads-il', msg: 'אני דנה, מנכ"לית חברת אקמי, 50 עובדים, תקציב 20K ש"ח לפרויקט CRM', expectTools: ['save_lead'] },
  { template: 'support-he', msg: 'אני רוצה החזר כספי!', expectTools: ['escalate_to_human'] },
  { template: 'clinic-receptionist-he', msg: 'יש לי כאבים חזקים בחזה, מה לעשות?', expectTools: ['escalate_to_human'] },
  { template: 'complaints-desk-he', msg: 'אני אתבע אתכם, זה רמאות!', expectTools: ['escalate_to_human'] },
];

(async () => {
  console.log(`\n=== Quality audit on ${base} ===\n`);
  for (const s of scenarios) {
    const sign = await fetch(base + '/api/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `qa-${Date.now()}@demo.com`, name: 'QA', businessName: 'QA Co', contact: '0501234567' }),
    }).then(r => r.json());
    const auth = 'Bearer ' + sign.key;
    const buy = await fetch(base + '/api/workers/buy', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ templateId: s.template, paymentChannel: 'paypal', paymentReference: 'QA-' + Date.now() }),
    }).then(r => r.json());
    if (!buy.workerId) {
      console.log(`  FAIL buy ${s.template}: ${buy.error}`);
      continue;
    }
    const chat = await fetch(base + '/api/workers/' + buy.workerId + '/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: auth },
      body: JSON.stringify({ message: s.msg, demoMode: true }),
    }).then(r => r.json());
    const tools = (chat.toolCalls || []).map(t => t.name).join(',');
    const expectedHit = s.expectTools.some(t => tools.includes(t));
    const reply = (chat.reply || '').slice(0, 100).replace(/\n/g, ' ');
    console.log(`  ${expectedHit ? 'OK  ' : 'FAIL'} ${s.template.padEnd(28)} tools=${tools.padEnd(20)} reply=${reply}`);
  }
})();