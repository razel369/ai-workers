// Integration type catalog — metadata, required fields, Hebrew labels.

export const INTEGRATION_CATEGORIES = {
  webhook: { id: 'webhook', labelHe: 'Webhooks', icon: '🔗' },
  mcp: { id: 'mcp', labelHe: 'MCP', icon: '🔌' },
  calendar: { id: 'calendar', labelHe: 'יומן', icon: '📅' },
  messaging: { id: 'messaging', labelHe: 'הודעות', icon: '💬' },
  email: { id: 'email', labelHe: 'אימייל', icon: '✉️' },
  crm: { id: 'crm', labelHe: 'CRM', icon: '📊' },
  ecommerce: { id: 'ecommerce', labelHe: 'מסחר אלקטרוני', icon: '🛒' },
  israeli: { id: 'israeli', labelHe: 'ישראלי', icon: '🇮🇱' },
};

/** @type {Record<string, import('./types.js').IntegrationTypeDef>} */
export const INTEGRATION_TYPES = {
  webhook: {
    id: 'webhook',
    category: 'webhook',
    labelHe: 'Webhook יוצא',
    descriptionHe: 'שליחת אירועים (לידים, הסלמות, הזמנות) לכתובת URL של העסק — Zapier, Make, n8n וכו׳',
    scaffold: false,
    fields: [
      { key: 'url', labelHe: 'כתובת Webhook', type: 'url', required: true, placeholder: 'https://hooks.zapier.com/...' },
      { key: 'secret', labelHe: 'סוד חתימה (אופציונלי)', type: 'secret', required: false },
    ],
    workerTools: ['notify_webhook'],
    envHints: ['WEBHOOK_NOTIFY_URL'],
  },
  mcp: {
    id: 'mcp',
    category: 'mcp',
    labelHe: 'שרת MCP',
    descriptionHe: 'חיבור לשרת MCP של העסק — כלים חיצוניים לסוכן',
    scaffold: false,
    fields: [
      { key: 'url', labelHe: 'כתובת שרת MCP', type: 'url', required: true, placeholder: 'https://mcp.example.com/mcp' },
      { key: 'name', labelHe: 'שם (לתצוגה)', type: 'text', required: false },
      { key: 'authHeader', labelHe: 'Authorization (אופציונלי)', type: 'secret', required: false },
    ],
    workerTools: [],
    envHints: [],
  },
  google_calendar: {
    id: 'google_calendar',
    category: 'calendar',
    labelHe: 'Google Calendar / Cal.com',
    descriptionHe: 'בדיקת זמינות וקביעת תורים — קישור Cal.com או מפתח API',
    scaffold: 'partial',
    fields: [
      { key: 'mode', labelHe: 'מצב', type: 'select', required: false, options: [
        { value: 'link', labelHe: 'קישור Cal.com / Google Calendar' },
        { value: 'api', labelHe: 'מפתח API / Service Account (מתקדם)' },
      ] },
      { key: 'bookingLink', labelHe: 'קישור לקביעת תור', type: 'url', required: false, placeholder: 'https://cal.com/your-business' },
      { key: 'calendarId', labelHe: 'Calendar ID', type: 'text', required: false },
      { key: 'apiKey', labelHe: 'מפתח API', type: 'secret', required: false },
    ],
    workerTools: ['check_availability', 'book_appointment'],
    envHints: ['MEETING_BOOKING_URL'],
  },
  whatsapp: {
    id: 'whatsapp',
    category: 'messaging',
    labelHe: 'WhatsApp Business',
    descriptionHe: 'שליחת הודעות WhatsApp דרך Meta Cloud API או Twilio',
    scaffold: 'partial',
    fields: [
      { key: 'provider', labelHe: 'ספק', type: 'select', required: true, options: [
        { value: 'meta', labelHe: 'Meta Cloud API' },
        { value: 'twilio', labelHe: 'Twilio' },
      ] },
      { key: 'phoneNumberId', labelHe: 'Phone Number ID (Meta)', type: 'text', required: false },
      { key: 'accessToken', labelHe: 'Access Token', type: 'secret', required: false },
      { key: 'twilioFrom', labelHe: 'מספר Twilio (whatsapp:+972...)', type: 'text', required: false },
    ],
    workerTools: ['send_whatsapp_message'],
    envHints: ['WHATSAPP_PROVIDER', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'],
  },
  email_sendgrid: {
    id: 'email_sendgrid',
    category: 'email',
    labelHe: 'SendGrid',
    descriptionHe: 'שליחת אימיילים דרך SendGrid API',
    scaffold: 'partial',
    fields: [
      { key: 'apiKey', labelHe: 'API Key', type: 'secret', required: true },
      { key: 'fromEmail', labelHe: 'כתובת שולח', type: 'email', required: true },
      { key: 'fromName', labelHe: 'שם שולח', type: 'text', required: false },
    ],
    workerTools: ['send_email'],
    envHints: ['EMAIL_WEBHOOK_URL'],
  },
  email_smtp: {
    id: 'email_smtp',
    category: 'email',
    labelHe: 'SMTP',
    descriptionHe: 'שליחת אימייל דרך שרת SMTP (Gmail, Outlook, ספק מקומי)',
    scaffold: true,
    fields: [
      { key: 'host', labelHe: 'שרת SMTP', type: 'text', required: true },
      { key: 'port', labelHe: 'פורט', type: 'number', required: true, placeholder: '587' },
      { key: 'user', labelHe: 'משתמש', type: 'text', required: true },
      { key: 'password', labelHe: 'סיסמה', type: 'secret', required: true },
      { key: 'fromEmail', labelHe: 'כתובת שולח', type: 'email', required: true },
    ],
    workerTools: ['send_email'],
    envHints: [],
  },
  crm_hubspot: {
    id: 'crm_hubspot',
    category: 'crm',
    labelHe: 'HubSpot',
    descriptionHe: 'סנכרון לידים והערות ל-HubSpot CRM',
    scaffold: 'working',
    fields: [
      { key: 'apiKey', labelHe: 'Private App Token / API Key', type: 'secret', required: true },
    ],
    workerTools: ['sync_lead_to_crm', 'create_crm_note'],
    envHints: [],
  },
  crm_pipedrive: {
    id: 'crm_pipedrive',
    category: 'crm',
    labelHe: 'Pipedrive',
    descriptionHe: 'סנכרון לידים ל-Pipedrive',
    scaffold: true,
    fields: [
      { key: 'apiToken', labelHe: 'API Token', type: 'secret', required: true },
      { key: 'companyDomain', labelHe: 'דומיין חברה', type: 'text', required: true, placeholder: 'yourcompany' },
    ],
    workerTools: ['sync_lead_to_crm'],
    envHints: [],
  },
  crm_monday: {
    id: 'crm_monday',
    category: 'crm',
    labelHe: 'Monday.com',
    descriptionHe: 'יצירת פריטים בלוח Monday',
    scaffold: true,
    fields: [
      { key: 'apiToken', labelHe: 'API Token', type: 'secret', required: true },
      { key: 'boardId', labelHe: 'Board ID', type: 'text', required: true },
    ],
    workerTools: ['sync_lead_to_crm'],
    envHints: [],
  },
  shopify: {
    id: 'shopify',
    category: 'ecommerce',
    labelHe: 'Shopify',
    descriptionHe: 'חיפוש הזמנות וסטטוס משלוח בחנות Shopify',
    scaffold: 'partial',
    fields: [
      { key: 'shopDomain', labelHe: 'דומיין חנות', type: 'text', required: true, placeholder: 'mystore.myshopify.com' },
      { key: 'accessToken', labelHe: 'Admin API Access Token', type: 'secret', required: true },
    ],
    workerTools: ['lookup_order'],
    envHints: [],
  },
  woocommerce: {
    id: 'woocommerce',
    category: 'ecommerce',
    labelHe: 'WooCommerce',
    descriptionHe: 'חיפוש הזמנות בחנות WooCommerce',
    scaffold: true,
    fields: [
      { key: 'siteUrl', labelHe: 'כתובת האתר', type: 'url', required: true },
      { key: 'consumerKey', labelHe: 'Consumer Key', type: 'secret', required: true },
      { key: 'consumerSecret', labelHe: 'Consumer Secret', type: 'secret', required: true },
    ],
    workerTools: ['lookup_order'],
    envHints: [],
  },
  bit_notify: {
    id: 'bit_notify',
    category: 'israeli',
    labelHe: 'Bit — התראת תשלום',
    descriptionHe: 'Webhook להתראה על תשלום Bit (מקבל אירוע ומעדכן את העסק)',
    scaffold: true,
    fields: [
      { key: 'notifyUrl', labelHe: 'Webhook לקבלת אירועי תשלום', type: 'url', required: false },
      { key: 'bitPhone', labelHe: 'מספר Bit (972...)', type: 'text', required: false },
    ],
    workerTools: ['notify_webhook'],
    envHints: ['BIT_PHONE'],
  },
  google_sheets: {
    id: 'google_sheets',
    category: 'israeli',
    labelHe: 'Google Sheets',
    descriptionHe: 'ייצוא לידים לגיליון Google (או CSV כגיבוי)',
    scaffold: true,
    fields: [
      { key: 'spreadsheetId', labelHe: 'Spreadsheet ID', type: 'text', required: false },
      { key: 'apiKey', labelHe: 'API Key / Service Account JSON', type: 'secret', required: false },
    ],
    workerTools: ['export_leads_csv'],
    envHints: [],
  },
};

export function getIntegrationType(typeId) {
  return INTEGRATION_TYPES[typeId] ?? null;
}

export function listCatalog() {
  return Object.values(INTEGRATION_TYPES).map((t) => ({
    id: t.id,
    type: t.id,
    category: t.category,
    categoryHe: INTEGRATION_CATEGORIES[t.category]?.labelHe ?? t.category,
    labelHe: t.labelHe,
    descriptionHe: t.descriptionHe,
    scaffold: t.scaffold === true ? 'scaffold' : t.scaffold === 'partial' ? 'partial' : 'working',
    // Legacy fields kept for server-side validation; UI uses userFields from connect-flows
    fields: t.fields.map((f) => ({
      key: f.key,
      labelHe: f.labelHe,
      type: f.type,
      required: !!f.required,
      placeholder: f.placeholder ?? '',
      options: f.options ?? undefined,
    })),
    workerTools: t.workerTools,
    envHints: t.envHints,
  }));
}

export function validateConfig(typeId, config = {}) {
  const def = getIntegrationType(typeId);
  if (!def) return { ok: false, error: 'unknown_integration_type' };

  // OAuth / platform-generated configs skip manual field validation
  if (config.authMethod === 'oauth' || config.authMethod === 'generated' || config.authMethod === 'platform') {
    return { ok: true, config: { ...config } };
  }

  const clean = {};
  for (const field of def.fields) {
    const val = config[field.key];
    if (field.required && (val === undefined || val === null || String(val).trim() === '')) {
      // webhook: inbound hookUrl satisfies connection without outbound url
      if (typeId === 'webhook' && field.key === 'url' && config.hookUrl) continue;
      return { ok: false, error: 'missing_field', field: field.key, labelHe: field.labelHe };
    }
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      clean[field.key] = String(val).trim();
    }
  }
  if (typeId === 'webhook' && config.hookUrl) clean.hookUrl = config.hookUrl;
  if (typeId === 'webhook' && config.secret) clean.secret = config.secret;
  if (typeId === 'webhook' && config.mode) clean.mode = config.mode;
  if (typeId === 'webhook' && config.hookId) clean.hookId = config.hookId;
  if (typeId === 'whatsapp' && (config.ownerNotifyPhone || clean.ownerNotifyPhone)) {
    clean.ownerNotifyPhone = String(config.ownerNotifyPhone || clean.ownerNotifyPhone).trim();
    clean.provider = clean.provider || config.provider || 'meta';
    clean.authMethod = 'phone';
    return { ok: true, config: clean };
  }
  if (typeId === 'google_calendar' && clean.bookingLink) {
    clean.mode = 'link';
    clean.authMethod = clean.authMethod || 'link';
  }
  return { ok: true, config: clean };
}

/** Featured types shown as connect cards in the builder UI */
export const BUILDER_FEATURED_TYPES = ['whatsapp', 'google_calendar', 'crm_hubspot', 'webhook', 'mcp'];

const SECRET_FIELD_RE = /key|token|secret|password|auth/i;

export function redactConfig(config = {}) {
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (SECRET_FIELD_RE.test(k)) {
      out[k] = '••••••••';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function validateConnectPayload(typeId, config = {}) {
  return validateConfig(typeId, config);
}

const AUTO_TOOL_MAP = {
  webhook: ['notify_webhook'],
  google_calendar: ['check_availability', 'book_appointment'],
  whatsapp: ['send_whatsapp_message'],
  crm_hubspot: ['sync_lead_to_crm', 'create_crm_note'],
  crm_pipedrive: ['sync_lead_to_crm'],
  crm_monday: ['sync_lead_to_crm'],
  shopify: ['lookup_order'],
  woocommerce: ['lookup_order'],
  bit_notify: ['notify_webhook'],
  google_sheets: ['export_leads_csv'],
};

export function toolsForConnectedTypes(typeIds = []) {
  const names = new Set();
  for (const typeId of typeIds) {
    const def = getIntegrationType(typeId);
    for (const t of def?.workerTools ?? []) names.add(t);
    for (const t of AUTO_TOOL_MAP[typeId] ?? []) names.add(t);
  }
  return [...names];
}
