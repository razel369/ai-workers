import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  processWhatsAppInbound,
  registerWhatsAppRoute,
  resolveWhatsAppRoute,
} from './whatsapp-router.js';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE whatsapp_routes (
    phone_key TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'meta',
    created_at TEXT NOT NULL
  );
`);

try {
  const first = registerWhatsAppRoute(db, {
    phoneNumberId: 'meta-owned-1001',
    tenantId: 'ten_owner',
    workerId: 'wk_owner',
    provider: 'meta',
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);

  const repeated = registerWhatsAppRoute(db, {
    phoneNumberId: 'meta-owned-1001',
    tenantId: 'ten_owner',
    workerId: 'wk_owner',
    provider: 'meta',
  });
  assert.deepEqual(
    { ok: repeated.ok, created: repeated.created, idempotent: repeated.idempotent },
    { ok: true, created: false, idempotent: true },
  );

  const crossTenant = registerWhatsAppRoute(db, {
    phoneNumberId: 'meta-owned-1001',
    tenantId: 'ten_attacker',
    workerId: 'wk_attacker',
    provider: 'meta',
  });
  assert.equal(crossTenant.ok, false);
  assert.equal(crossTenant.error, 'route_already_claimed');
  assert.equal(crossTenant.status, 409);

  const crossWorker = registerWhatsAppRoute(db, {
    phoneNumberId: 'meta-owned-1001',
    tenantId: 'ten_owner',
    workerId: 'wk_other',
    provider: 'meta',
  });
  assert.equal(crossWorker.ok, false);
  assert.equal(crossWorker.error, 'route_already_claimed');

  assert.deepEqual(
    { ...resolveWhatsAppRoute(db, { phoneNumberId: 'meta-owned-1001', provider: 'meta' }) },
    { tenantId: 'ten_owner', workerId: 'wk_owner', provider: 'meta' },
  );

  const twilioFirst = registerWhatsAppRoute(db, {
    twilioTo: 'whatsapp:+972-50-555-0101',
    tenantId: 'ten_twilio_owner',
    workerId: 'wk_twilio_owner',
    provider: 'twilio',
  });
  assert.equal(twilioFirst.ok, true);
  const twilioTakeover = registerWhatsAppRoute(db, {
    twilioTo: '+972505550101',
    tenantId: 'ten_twilio_attacker',
    workerId: 'wk_twilio_attacker',
    provider: 'twilio',
  });
  assert.equal(twilioTakeover.ok, false);
  assert.equal(twilioTakeover.status, 409);

  const previousDefaults = {
    phoneId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    tenantId: process.env.WHATSAPP_DEFAULT_TENANT_ID,
    workerId: process.env.WHATSAPP_DEFAULT_WORKER_ID,
  };
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'global-default-phone';
  process.env.WHATSAPP_DEFAULT_TENANT_ID = 'ten_global_default';
  process.env.WHATSAPP_DEFAULT_WORKER_ID = 'wk_global_default';
  try {
    assert.equal(
      resolveWhatsAppRoute(db, { phoneNumberId: 'global-default-phone', provider: 'meta' }),
      null,
      'an environment default must never act as an inbound tenant route',
    );
    const implicitRegistration = registerWhatsAppRoute(db, {
      tenantId: 'ten_global_default',
      workerId: 'wk_global_default',
      provider: 'meta',
    });
    assert.equal(implicitRegistration.ok, false);
    assert.equal(implicitRegistration.error, 'route_fields_required');

    let chatCalled = false;
    const inbound = await processWhatsAppInbound(db, {
      chatWithWorker: async () => {
        chatCalled = true;
        return { ok: true, reply: 'must not run' };
      },
      getWorker: () => ({ isActive: true }),
    }, {
      provider: 'meta',
      phoneNumberId: 'global-default-phone',
      from: '972501234567',
      text: 'hello',
    });
    assert.equal(inbound.ok, false);
    assert.equal(inbound.error, 'no_route');
    assert.equal(inbound.status, 404);
    assert.equal(chatCalled, false);
  } finally {
    if (previousDefaults.phoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = previousDefaults.phoneId;
    if (previousDefaults.tenantId === undefined) delete process.env.WHATSAPP_DEFAULT_TENANT_ID;
    else process.env.WHATSAPP_DEFAULT_TENANT_ID = previousDefaults.tenantId;
    if (previousDefaults.workerId === undefined) delete process.env.WHATSAPP_DEFAULT_WORKER_ID;
    else process.env.WHATSAPP_DEFAULT_WORKER_ID = previousDefaults.workerId;
  }

  registerWhatsAppRoute(db, {
    phoneNumberId: 'meta-retry-2002',
    tenantId: 'ten_retry_owner',
    workerId: 'wk_retry_owner',
    provider: 'meta',
  });
  let chatCalls = 0;
  let sendCalls = 0;
  let cachedOutcome = null;
  const deps = {
    getWorker: () => ({ isActive: true }),
    chatWithWorker: async (params) => {
      chatCalls++;
      assert.equal(params.requestId, 'wa:meta:wamid.retry-1');
      return { ok: true, reply: 'תשובה שנוצרה פעם אחת', runtime: 'mock', toolCalls: [{ name: 'save_lead' }] };
    },
    logAgentActions: () => {},
    persistInboundOutcome: (inbound, outcome) => {
      assert.equal(inbound.messageId, 'wamid.retry-1');
      cachedOutcome = outcome;
    },
    sendReply: async () => {
      sendCalls++;
      return sendCalls === 1 ? { ok: false, error: 'temporary_send_failure' } : { ok: true, messageId: 'outbound-1' };
    },
  };
  const baseInbound = {
    provider: 'meta',
    phoneNumberId: 'meta-retry-2002',
    from: '972501234567',
    messageId: 'wamid.retry-1',
    text: 'שלום',
    claim: { mode: 'process' },
  };
  const firstSend = await processWhatsAppInbound(db, deps, baseInbound);
  assert.equal(firstSend.ok, false);
  assert.equal(firstSend.error, 'send_failed');
  assert.equal(firstSend.outcomeCached, true);
  assert.ok(cachedOutcome?.replyText);

  const retrySend = await processWhatsAppInbound(db, deps, {
    ...baseInbound,
    claim: { mode: 'send', cached: cachedOutcome },
  });
  assert.equal(retrySend.ok, true);
  assert.equal(retrySend.resumed, true);
  assert.equal(chatCalls, 1, 'send retry must not invoke the LLM/tools twice');
  assert.equal(sendCalls, 2);

  console.log('WhatsApp route ownership tests passed.');
} finally {
  db.close();
}
