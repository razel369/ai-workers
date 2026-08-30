import { runAction } from './runner.js';
import {
  getFirstIntegrationConfig,
  getIntegrationsByType,
  getWebhookUrlForTenant,
  listConnectedTypes,
} from './store.js';
import { toolsForConnectedTypes } from './registry.js';

const CRM_TYPES = ['crm_hubspot', 'crm_pipedrive', 'crm_monday'];
const ECOMM_TYPES = ['shopify', 'woocommerce'];

function firstCrmType(tenantId) {
  for (const t of CRM_TYPES) {
    if (getIntegrationsByType(tenantId, t).length) return t;
  }
  return null;
}

function firstEcommType(tenantId) {
  for (const t of ECOMM_TYPES) {
    if (getIntegrationsByType(tenantId, t).length) return t;
  }
  return null;
}

export function getAutoToolNamesForTenant(tenantId) {
  return toolsForConnectedTypes(listConnectedTypes(tenantId));
}

export function registerIntegrationTools(TOOL_DEFS, deps = {}) {
  const defs = [
    {
      name: 'sync_lead_to_crm',
      description: 'Sync a qualified lead to the connected CRM (HubSpot, Pipedrive, or Monday.com)',
      parameters: {
        type: 'object',
        properties: {
          fullName: { type: 'string', description: 'Lead full name' },
          company: { type: 'string', description: 'Company name' },
          phone: { type: 'string', description: 'Phone number' },
          email: { type: 'string', description: 'Email address' },
          notes: { type: 'string', description: 'Qualification notes' },
          score: { type: 'number', description: 'Lead score 1-10' },
        },
        required: ['fullName'],
      },
      handler: async (args, ctx) => {
        const crmType = firstCrmType(ctx.tenantId);
        if (!crmType) return { ok: false, error: 'crm_not_connected', result: 'No CRM is connected; the lead was not synced.' };
        const config = getFirstIntegrationConfig(ctx.tenantId, crmType);
        const res = await runAction(crmType, 'sync_lead', args, config, ctx);
        return {
          result: res.ok ? res.message : `CRM sync failed: ${res.error || res.message}`,
          crmType,
          ...res,
        };
      },
    },
    {
      name: 'check_availability',
      description: 'Check available appointment slots using the connected calendar integration',
      parameters: {
        type: 'object',
        properties: {
          daysAhead: { type: 'number', description: 'Days ahead to check (default 3)' },
        },
        required: [],
      },
      handler: async (args, ctx) => {
        const config = getFirstIntegrationConfig(ctx.tenantId, 'google_calendar') || {};
        const res = await runAction('google_calendar', 'check_availability', args, config, ctx);
        if (!res.ok) return { ...res, result: res.message || 'Live calendar availability is not configured.', slots: [] };
        const lines = (res.slots ?? []).map((s) => `  - ${s}`).join('\n');
        return {
          result: res.slots?.length
            ? `Suggested slots (Israel time):\n${lines}${res.bookingLink ? `\nBooking link: ${res.bookingLink}` : ''}`
            : res.bookingLink
              ? `Live availability was not checked. The customer must choose and confirm a slot at: ${res.bookingLink}`
              : 'Live availability was not checked.',
          slots: res.slots,
          bookingLink: res.bookingLink,
        };
      },
    },
    {
      name: 'book_appointment',
      description: 'Book or propose an appointment using calendar integration (booking link or collected preferences)',
      parameters: {
        type: 'object',
        properties: {
          leadName: { type: 'string', description: 'Customer name' },
          phone: { type: 'string', description: 'Phone number' },
          preferredTime: { type: 'string', description: 'Preferred date/time window' },
          reason: { type: 'string', description: 'Reason for visit' },
        },
        required: ['leadName'],
      },
      handler: async (args, ctx) => {
        const config = getFirstIntegrationConfig(ctx.tenantId, 'google_calendar') || {};
        const res = await runAction('google_calendar', 'book_appointment', {
          leadName: args.leadName,
          fullName: args.leadName,
          preferredWindow: args.preferredTime,
          phone: args.phone,
          reason: args.reason,
        }, config, ctx);
        return {
          result: res.message || (res.ok ? 'Appointment booked.' : 'Appointment was not booked.'),
          ...res,
        };
      },
    },
    {
      name: 'lookup_order',
      description: 'Look up an e-commerce order only after the customer supplies both the order number and matching email (Shopify / WooCommerce)',
      parameters: {
        type: 'object',
        properties: {
          orderNumber: { type: 'string', description: 'Order number e.g. #1234' },
          email: { type: 'string', description: 'Customer email' },
        },
        required: ['orderNumber', 'email'],
      },
      handler: async (args, ctx) => {
        const orderNumber = String(args.orderNumber || '').trim();
        const email = String(args.email || '').trim().toLowerCase();
        if (!orderNumber || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return {
            ok: false,
            error: 'order_number_and_valid_email_required',
            result: 'כדי להגן על פרטיות הלקוח נדרשים גם מספר הזמנה וגם כתובת האימייל ששימשה בהזמנה.',
            orders: [],
          };
        }
        const shopType = firstEcommType(ctx.tenantId);
        if (!shopType) return { ok: false, error: 'store_not_connected', result: 'No e-commerce store is connected; no order lookup was performed.', orders: [] };
        const config = getFirstIntegrationConfig(ctx.tenantId, shopType);
        const res = await runAction(shopType, 'lookup_order', { ...args, orderNumber, email }, config, ctx);
        if (!res.ok) return { result: `Order lookup failed: ${res.error}`, orders: [] };
        return {
          result: res.message + (res.orders?.length ? '\n' + JSON.stringify(res.orders, null, 2) : ''),
          orders: res.orders ?? [],
        };
      },
    },
    {
      name: 'send_whatsapp_message',
      description: 'Send an outbound WhatsApp message to a customer (requires WhatsApp Business integration)',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Phone in E.164 e.g. 972501234567' },
          text: { type: 'string', description: 'Message text' },
        },
        required: ['to', 'text'],
      },
      handler: async (args, ctx) => {
        const config = getFirstIntegrationConfig(ctx.tenantId, 'whatsapp') || {};
        if (!config.provider) return { ok: false, error: 'whatsapp_not_connected', result: 'WhatsApp is not connected; no message was sent.' };
        const res = await runAction('whatsapp', 'send', args, config, ctx);
        return {
          ...res,
          result: res.ok
            ? (res.message || 'WhatsApp message sent.')
            : (res.message || `WhatsApp message was not sent: ${res.error || 'send_failed'}`),
        };
      },
    },
  ];

  for (const d of defs) TOOL_DEFS.push(d);

  // Patch notify_webhook to prefer tenant integration URL
  const notifyDef = TOOL_DEFS.find((t) => t.name === 'notify_webhook');
  if (notifyDef && !notifyDef._integrationPatched) {
    const origHandler = notifyDef.handler;
    notifyDef.handler = async (args, ctx) => {
      const url = getWebhookUrlForTenant(ctx.tenantId)
        || process.env.WEBHOOK_NOTIFY_URL
        || process.env[`WORKER_${ctx.workerId?.slice(0, 8).toUpperCase()}_WEBHOOK`]
        || '';
      if (!url) return origHandler(args, ctx);
      const body = {
        event: args.event,
        payload: args.payload ?? {},
        workerId: ctx.workerId,
        tenantId: ctx.tenantId,
        customerId: ctx.customerId ?? '',
        at: new Date().toISOString(),
      };
      try {
        const delivery = await runAction('webhook', 'send', { payload: body }, { url }, ctx);
        return delivery.ok
          ? { ok: true, result: `Webhook notified: ${args.event}`, status: delivery.status }
          : {
              ok: false,
              error: delivery.error || 'webhook_delivery_failed',
              reason: delivery.error,
              status: delivery.status || 0,
              result: `Webhook was not sent: ${delivery.error || 'delivery_failed'}`,
            };
      } catch (e) {
        return { ok: false, error: 'webhook_delivery_failed', result: `Webhook failed: ${e?.message ?? e}` };
      }
    };
    notifyDef._integrationPatched = true;
  }

  return defs.map((d) => d.name);
}
