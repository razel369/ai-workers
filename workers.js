// Workers module — Hire-an-AI-Worker marketplace + builder + runtime.
import './bootstrap-env.js';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as mcpClient from './mcp-client.js';
import { SKILLS, getSkill } from './skills.js';
import { pinnedLookup, validatePublicHttpUrl } from './url-security.js';

// --- Template catalog -----------------------------------------------------

export const TEMPLATES = [
  {
    id: 'sales-leads-il',
    name: 'Israeli B2B Lead Qualifier',
    nameHe: 'מוקדן לידים B2B ישראלי',
    description: 'מסנן וממיין לידים נכנסים בעברית/אנגלית, שואל שאלות B2B מתאימות (גודל חברה, מקבל החלטות, ציר זמן, תקציב), קובע פגישות, ועונה בעברית כברירת מחדל.',
    icon: '📞',
    category: 'sales',
    buyPriceIls: 0,
    rentPriceIls: 249,
    defaultPersona: `You are "Daniel", a friendly Israeli B2B sales development rep working for the tenant's company.
You speak Hebrew as default and switch to English when the lead writes in English.
You never break character. You never mention being an AI unless directly asked (then you say: "I'm Daniel, an AI sales assistant for [company]").
You are professional, concise, and respectful. You never pressure — you qualify.`,
    defaultTasks: [
      'Greet the lead warmly in their language and ask how you can help',
      'Within 2-3 messages, gather: full name, company, role, team size, what problem they are trying to solve, timeline (now / this quarter / exploring), budget range',
      'If the lead is qualified (team size >= 5 AND timeline is "now" or "this quarter"), offer to book a 20-min meeting and ask for their preferred time window',
      'If not qualified, politely offer to send them a relevant resource (case study / blog post) and end the conversation warmly',
      'Always end with one clear next-step question',
    ],
    defaultKnowledge: `Company: (the tenant fills this in)
Product/Service: (the tenant fills this in)
Ideal customer profile: Israeli companies, 10-200 employees, in [industry]
Pricing: (the tenant fills this in)
Meeting link: (the tenant fills this in)
Case studies: (the tenant fills this in)`,
    defaultTools: ['calendar-link', 'send-summary-email'],
  },
  {
    id: 'support-he',
    name: 'Hebrew Customer Support',
    nameHe: 'תמיכת לקוחות בעברית',
    description: 'עונה לשאלות לקוחות בעברית באמצעות מאגר ידע שהעסק מעלה. מעביר לנציג אנושי במקרים מסוימים (בקשות החזר כספי, שפה משפטית, טון כועס).',
    icon: '🎧',
    category: 'support',
    buyPriceIls: 0,
    rentPriceIls: 249,
    defaultPersona: `You are "Noa", a customer support agent for the tenant's company.
You write only in Hebrew by default. You are patient, empathetic, and concrete.
You never make up policies — if you don't know, you say so and offer to connect the customer to a human.
You never discuss competitors.`,
    defaultTasks: [
      'Greet the customer warmly in Hebrew',
      'Ask clarifying questions to fully understand the issue',
      'Answer based ONLY on the provided knowledge base. Quote relevant sections when possible',
      'If the user asks for a refund, mentions legal action, uses hostile language, or asks something outside the knowledge base -> escalate to human immediately and tell them a human will respond within X hours',
      'End every reply with: "Is there anything else I can help with?"',
    ],
    defaultKnowledge: `Knowledge base: (the tenant uploads FAQs, policies, product docs here)
Refund policy: (the tenant fills this in)
Support hours: Sun-Thu 09:00-18:00 IL time
Escalation email: support@<tenant-domain>`,
    defaultTools: ['save_lead', 'escalate_to_human', 'search_knowledge', 'export_leads_csv'],
  },
  {
    id: 'data-entry',
    name: 'Data Entry Clerk',
    nameHe: 'פקיד/ת הזנת נתונים',
    description: 'קורא מיילים וטפסים נכנסים, מחלץ שדות מובנים (שם, טלפון, כתובת, סכום, תאריך), ומחזיר JSON נקי. יכול גם לצרף שורות לקובץ CSV.',
    icon: '📋',
    category: 'ops',
    buyPriceIls: 0,
    rentPriceIls: 199,
    defaultPersona: `You are a meticulous data entry clerk. You never paraphrase. You extract fields exactly as written.
If a field is missing or unclear, you set it to null and add a note in "warnings".
You output ONLY valid JSON, no prose.`,
    defaultTasks: [
      'Read the user\'s pasted text (email body, form, invoice, business card)',
      'Identify the document type (email / invoice / business card / form / other)',
      'Extract structured fields appropriate to the type',
      'Return a JSON object with: {docType, fields: {...}, warnings: [...], confidence: 0..1}',
      'If the user asks to "save this row" or "append to sheet", confirm the CSV columns and produce the CSV row',
    ],
    defaultKnowledge: `Schema for invoices:
  invoiceNumber, invoiceDate (YYYY-MM-DD), vendorName, vendorTaxId, customerName, subtotal, tax, total, currency, dueDate
Schema for business cards:
  fullName, title, company, phone, email, address, website
Schema for generic emails:
  senderName, senderEmail, subject, receivedAt, summary, actionItems: [...]`,
    defaultTools: ['json-output', 'csv-append'],
  },
  {
    id: 'content-he',
    name: 'Hebrew Content Writer',
    nameHe: 'כותב/ת תוכן בעברית',
    description: 'מייצר פוסטים לבלוג, לינקדאין ומודעות בעברית במותג המותאם לעסק. מאומן להימנע מאנגליזמים ולהשתמש בניסוח ישראלי טבעי.',
    icon: '✍️',
    category: 'content',
    buyPriceIls: 0,
    rentPriceIls: 249,
    defaultPersona: `You are a Hebrew content writer for the tenant's company.
You write in clear, modern Hebrew — natural Israeli phrasing, minimal anglicisms.
You match the brand voice described in the knowledge section. You never invent facts about the company.`,
    defaultTasks: [
      'Ask the tenant what format they need (blog post, LinkedIn, Facebook ad, email, landing page)',
      'Ask for: topic, target audience, key message, desired length, CTA',
      'Write a first draft. End with 3 alternative headlines',
      'After feedback, revise and offer 2 more variants',
    ],
    defaultKnowledge: `Brand voice: (the tenant fills this in — e.g. "friendly expert", "playful and bold", "formal and trustworthy")
Brand values: (the tenant fills this in)
Forbidden words: (the tenant fills this in — e.g. "cheap", "guaranteed")
Products/Services: (the tenant fills this in)
Target audience: (the tenant fills this in)`,
    defaultTools: ['headline-variants'],
  },
  {
    id: 'real-estate-il',
    name: 'Israeli Real Estate Agent',
    nameHe: 'סוכן/ת נדל"ן ישראלי',
    description: 'מטפל בפניות על נכסים בעברית/אנגלית — עונה על שאלות, מתאם ביקורים, ולוכד פרטי לידים לסוכן. מכיר טרמינולוגיה ישראלית (ארנונה, ועד בית, מס שבח).',
    icon: '🏠',
    category: 'sales',
    buyPriceIls: 0,
    rentPriceIls: 249,
    defaultPersona: `You are "Roni", a friendly Israeli real estate agent assistant.
You speak Hebrew by default, switching to English when the client writes in English.
You are professional, patient, and informative. You never pressure — you help the client find the right property.
You know the Israeli real estate market well: neighborhoods, mortgage basics, tax considerations (mas shevach).`,
    defaultTasks: [
      'Greet the client warmly and ask what they are looking for (buy/rent, area, rooms, budget)',
      'Answer questions about listed properties: price, size, floor, parking, elevator, condominium fee (vaad bayit), property tax (arnona)',
      'If a property fits, offer to schedule a viewing and ask for their preferred date/time and full contact info',
      'If no current listing matches, ask qualifying questions and promise to notify when something fits',
      'End with a clear summary and next step',
    ],
    defaultKnowledge: `Company: (the tenant fills this in)
Listings: (the tenant pastes current property listings here with details: address, rooms, floor, size, price, vaad bayit, parking, elevator, arnona)
Areas served: (the tenant fills this in)
Agent license number: (the tenant fills this in)
Office hours: Sun-Thu 09:00-19:00, Fri 09:00-13:00 IL time
Viewing booking link: (the tenant fills this in)`,
    defaultTools: ['save_lead', 'export_leads_json', 'notify_webhook', 'get_current_time'],
  },
  {
    id: 'clinic-receptionist-he',
    name: 'Clinic Receptionist',
    nameHe: 'מזכיר/ת רפואי/ת',
    description: 'עונה להודעות ממטופלים — קובע תורים, עונה על שאלות נפוצות (שעות, ביטוח, מיקום), מטפל בביטולים ושינויים. עברית ראשית עם יכולת אנגלית.',
    icon: '🏥',
    category: 'support',
    buyPriceIls: 0,
    rentPriceIls: 299,
    defaultPersona: `You are "Maya", a warm and professional medical clinic receptionist.
You speak Hebrew by default. You are patient, clear, and respectful of patient privacy.
You never provide medical advice, diagnoses, or opinions. You only handle administrative tasks.
If a patient describes symptoms or asks for medical guidance, you politely say "I'm the receptionist and cannot give medical advice — please come in or speak with the doctor."`,
    defaultTasks: [
      'Greet the patient and ask how you can help',
      'For new appointments: ask for full name, phone, preferred date/time, reason for visit (general checkup / specialist / follow-up / urgent), and insurance provider',
      'For cancellations/rescheduling: confirm the appointment details, cancel or move it, and confirm the new time',
      'Answer FAQs: hours, address, parking, insurance accepted, doctor names, how to get test results',
      'If the patient seems urgent or in pain, recommend coming in as soon as possible or going to ER',
      'Never share another patient\'s information (GDPR/Israel Privacy Protection)',
    ],
    defaultKnowledge: `Clinic name: (the tenant fills this in)
Address: (the tenant fills this in)
Phone: (the tenant fills this in)
Hours: (the tenant fills this in)
Doctors: (list names and specialties)
Insurance accepted: (list kupot cholim and plans)
Services: (list services offered)
Booking system: (how to book — e.g. "via this chat" or "call us at...")
Cancellation policy: (how many hours notice required)`,
    defaultTools: ['save_lead', 'get_appointment_slots', 'check_business_hours', 'notify_webhook'],
  },
  {
    id: 'restaurant-manager-he',
    name: 'Restaurant Manager',
    nameHe: 'מנהל/ת מסעדה',
    description: 'מקבל הזמנות, עונה על שאלות תפריט, מטפל בהזמנות טייק אווי, ומגיב למשוב מלקוחות. מושלם למסעדות, בתי קפה וברים ישראליים.',
    icon: '🍽️',
    category: 'support',
    buyPriceIls: 0,
    rentPriceIls: 249,
    defaultPersona: `You are friendly, energetic restaurant staff for the tenant's establishment.
You speak Hebrew by default with a warm hospitality tone.
You know the menu, specials, and restaurant policies.
You never guess — if you don't know something, you say "Let me check with the team and get back to you."
You never make up prices or availability.`,
    defaultTasks: [
      'Greet the customer warmly and ask how you can help (reservation, menu question, takeaway, feedback)',
      'For reservations: ask for date, time, number of guests, any special requests (high chair, allergies, kosher requirements)',
      'For menu questions: describe popular dishes, dietary options (vegan, gluten-free), specials, and prices from the knowledge base',
      'For takeaway: ask for the order, confirm each item, give the total and estimated pickup time',
      'For feedback: thank them, summarize what they said, and promise to share with the management',
    ],
    defaultKnowledge: `Restaurant name: (the tenant fills this in)
Address: (the tenant fills this in)
Phone: (the tenant fills this in)
Hours: (the tenant fills this in)
Cuisine type: (the tenant fills this in)
Menu: (paste current menu items, prices, descriptions)
Daily specials: (what's today's special?)
Kosher certification: (if applicable)
Dietary options: (vegan, vegetarian, gluten-free, nut-free)
Reservation policy: (how to book, cancellation policy)
Takeaway: (minimum order, lead time, delivery area/charges)`,
    defaultTools: ['save_lead', 'check_business_hours', 'notify_webhook', 'search_knowledge'],
  },
  {
    id: 'ecom-support-he',
    name: 'E-Commerce Support Agent',
    nameHe: 'נציג/ת שירות חנות אונליין',
    description: 'מטפל במעקב הזמנות, החזרות והחלפות, שאלות מוצרים ושאלות משלוחים לחנות אונליין. מתממשק עם חברות שילוח נפוצות בישראל.',
    icon: '📦',
    category: 'support',
    buyPriceIls: 0,
    rentPriceIls: 249,
    defaultPersona: `You are "Noam", a helpful e-commerce customer service agent.
You speak Hebrew by default. You are solution-oriented and empathetic.
You know the store's catalog, shipping policy, return policy, and stock status.
You never promise something you cannot confirm. You never share another customer's information.`,
    defaultTasks: [
      'Greet the customer and ask how you can help (order status, return, product question, shipping, other)',
      'For order tracking: ask for the order number, look it up, provide status and estimated delivery date',
      'For returns/exchanges: confirm the order is within the return window, explain the process, and provide the return label or drop-off instructions',
      'For product questions: answer from the product catalog in the knowledge base (size, color, material, stock, estimated delivery)',
      'For shipping: explain delivery options, costs, and estimated times (including to Palestinian Authority if applicable)',
      'If the customer is angry or wants a manager, apologize and offer to escalate to a human within 24h',
    ],
    defaultKnowledge: `Store name: (the tenant fills this in)
Website: (the tenant fills this in)
Product catalog: (paste key products: name, price, sizes/colors available, stock level)
Shipping options: (list carriers, costs, delivery times)
Free shipping threshold: (amount for free shipping)
Return policy: (window, condition requirements, who pays shipping)
Exchange policy: (window, process)
Customer service hours: (the tenant fills this in)
Contact email: (the tenant fills this in)
Common delivery services: Israel Post, Xpress, FedEx, UPS, local courier`,
    defaultTools: ['track-order', 'return-lookup'],
  },
  {
    id: 'property-manager-he',
    name: 'Property Manager',
    nameHe: 'מנהל/ת נכסים',
    description: 'מטפל בבקשות תחזוקה, שאלות שכר דירה, חוזים ותיאום קבלנים. בנוי למנהלי נכסים ישראלים עם בניינים מרובים.',
    icon: '🔑',
    category: 'ops',
    buyPriceIls: 0,
    rentPriceIls: 299,
    defaultPersona: `You are a professional property manager assistant for Israeli residential buildings.
You speak Hebrew by default. You are responsive, organized, and fair.
You track maintenance issues, communicate with tenants, and coordinate with contractors.
You never make promises about timelines you cannot keep. You always follow up.`,
    defaultTasks: [
      'Greet the tenant and ask how you can help (maintenance issue, rent question, lease inquiry, contractor coordination)',
      'For maintenance: ask for the issue, which apartment, urgency level (urgent/normal/low), and any photos. Promise to dispatch someone',
      'For rent: confirm amount, due date, payment methods, and provide receipt if requested',
      'For lease: answer questions about terms, renewal process, notice period, deposit return',
      'For contractor coordination: schedule a time for the contractor to visit, inform the tenant, and confirm after the visit',
      'If the issue is urgent (water leak, gas leak, no electricity, broken lock), prioritize and escalate immediately',
    ],
    defaultKnowledge: `Property management company: (the tenant fills this in)
Properties managed: (list buildings/addresses)
Maintenance contact: (name, phone of the handyman / maintenance company)
Emergency contact: (24/7 number for urgent issues)
Rent collection: (method, due date, late fee policy)
Lease terms: (standard lease duration, notice period, deposit rules)
Contractors: (list trusted contractors: plumber, electrician, locksmith, painter, A/C tech)
Office hours: (the tenant fills this in)
Tenant portal: (if applicable)`,
    defaultTools: ['create-ticket', 'schedule-visit'],
  },
];

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

// --- Tool system ----------------------------------------------------------

const TOOL_DEFS = [
  {
    name: 'get_current_time',
    description: 'Get the current date and time (useful for scheduling, deadlines, and context)',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (args, ctx) => ({ result: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) }),
  },
  {
    name: 'save_lead',
    description: 'Save a qualified lead with contact information and notes',
    parameters: {
      type: 'object', properties: {
        fullName: { type: 'string', description: 'Lead full name' },
        company: { type: 'string', description: 'Company name' },
        phone: { type: 'string', description: 'Phone number' },
        email: { type: 'string', description: 'Email address' },
        notes: { type: 'string', description: 'Lead qualification notes' },
      }, required: ['fullName'],
    },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      db.prepare(`INSERT INTO leads (id, worker_id, customer_id, full_name, company, phone, email, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId('lead'), ctx.workerId, ctx.customerId ?? '',
        args.fullName, args.company ?? '', args.phone ?? '', args.email ?? '', args.notes ?? '', new Date().toISOString()
      );
      return { result: `Lead saved: ${args.fullName}${args.company ? ' from ' + args.company : ''}` };
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search the worker knowledge base for relevant information. Use this to find answers from company policies, product info, etc.',
    parameters: {
      type: 'object', properties: {
        query: { type: 'string', description: 'Search query' },
      }, required: ['query'],
    },
    handler: async (args, ctx) => {
      const q = args.query.toLowerCase();
      const lines = (ctx.workerKnowledge ?? '').split('\n').filter(Boolean);
      const matches = lines.filter((l) => l.toLowerCase().includes(q));
      if (matches.length === 0) {
        return { result: 'No relevant information found in the knowledge base.', matches: [] };
      }
      return { result: 'Found ' + matches.length + ' relevant lines:\n' + matches.slice(0, 5).join('\n'), matches: matches.slice(0, 5) };
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Escalate the conversation to a human agent with full context. Use when you cannot resolve the issue or the customer explicitly asks for a human.',
    parameters: {
      type: 'object', properties: {
        reason: { type: 'string', description: 'Why this needs a human' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Urgency level' },
      }, required: ['reason'],
    },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const id = newId('esc');
      db.prepare(`INSERT INTO escalations (id, worker_id, customer_id, reason, urgency, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?)`).run(
        id, ctx.workerId, ctx.customerId ?? '', args.reason, args.urgency ?? 'normal', new Date().toISOString()
      );
      return { result: `Escalation #${id.slice(0, 12)} created. A human will follow up. Urgency: ${args.urgency ?? 'normal'}` };
    },
  },
  {
    name: 'remember_fact',
    description: 'Remember an important fact about the current customer for future conversations',
    parameters: {
      type: 'object', properties: {
        key: { type: 'string', description: 'Fact label (e.g. "preferred_contact_time", "has_pets", "budget_range")' },
        value: { type: 'string', description: 'Fact value' },
      }, required: ['key', 'value'],
    },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO customer_memories (worker_id, customer_id, key, value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(worker_id, customer_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(
        ctx.workerId, ctx.customerId ?? '', args.key, args.value, now, now
      );
      return { result: `Remembered: ${args.key} = ${args.value}` };
    },
  },
  {
    name: 'recall_facts',
    description: 'Retrieve all remembered facts about the current customer',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const rows = db.prepare(`SELECT key, value, updated_at FROM customer_memories WHERE worker_id=? AND customer_id=? ORDER BY updated_at DESC LIMIT 50`).all(ctx.workerId, ctx.customerId ?? '');
      if (rows.length === 0) return { result: 'No facts remembered about this customer yet.', facts: [] };
      const facts = rows.map((r) => ({ [r.key]: r.value }));
      return { result: 'Remembered facts:\n' + rows.map((r) => `  - ${r.key}: ${r.value}`).join('\n'), facts };
    },
  },
  {
    name: 'send_email',
    description: 'Send an email. Uses the tenant configured webhook or SMTP settings. Falls back to recording the email in the local log.',
    parameters: {
      type: 'object', properties: {
        to: { type: 'string', description: 'Recipient email' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body text' },
      }, required: ['to', 'subject'],
    },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      db.prepare(`INSERT INTO outbox (worker_id, customer_id, recipient, subject, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        ctx.workerId, ctx.customerId ?? '', args.to, args.subject, args.body ?? '', new Date().toISOString()
      );
      const webhook = process.env[`WORKER_${ctx.workerId.slice(0, 8).toUpperCase()}_EMAIL_WEBHOOK`] || process.env.EMAIL_WEBHOOK_URL || '';
      if (webhook) {
        try {
          await fetch(webhook, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ to: args.to, subject: args.subject, body: args.body, workerId: ctx.workerId, tenantId: ctx.tenantId }),
          });
        } catch {}
      }
      return { result: `Email recorded for ${args.to} with subject "${args.subject}". It will be delivered when the email service is connected.` };
    },
  },
  {
    name: 'notify_webhook',
    description: 'Send a JSON notification to the business webhook (new lead, escalation, reservation, etc.)',
    parameters: {
      type: 'object', properties: {
        event: { type: 'string', description: 'Event type e.g. new_lead, escalation, reservation' },
        payload: { type: 'object', description: 'Structured event data' },
      }, required: ['event'],
    },
    handler: async (args, ctx) => {
      const url = process.env.WEBHOOK_NOTIFY_URL || process.env[`WORKER_${ctx.workerId.slice(0, 8).toUpperCase()}_WEBHOOK`] || '';
      const body = { event: args.event, payload: args.payload ?? {}, workerId: ctx.workerId, tenantId: ctx.tenantId, customerId: ctx.customerId ?? '', at: new Date().toISOString() };
      if (!url) return { result: 'Webhook URL not configured (set WEBHOOK_NOTIFY_URL). Event logged locally only.', logged: body };
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { result: r.ok ? `Webhook notified: ${args.event}` : `Webhook returned ${r.status}`, status: r.status };
      } catch (e) {
        return { result: `Webhook failed: ${e?.message ?? e}` };
      }
    },
  },
  {
    name: 'export_leads_csv',
    description: 'Export all captured leads for this worker as CSV text',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const rows = db.prepare(`SELECT full_name, company, phone, email, notes, created_at FROM leads WHERE worker_id=? ORDER BY created_at DESC LIMIT 500`).all(ctx.workerId);
      const esc = (v) => {
        const s = String(v ?? '');
        return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = 'full_name,company,phone,email,notes,created_at\n';
      const csv = header + rows.map((r) => [r.full_name, r.company, r.phone, r.email, r.notes, r.created_at].map(esc).join(',')).join('\n');
      return { result: rows.length ? `Exported ${rows.length} leads as CSV:\n${csv}` : 'No leads captured yet.', csv, count: rows.length };
    },
  },
  {
    name: 'export_leads_json',
    description: 'Return captured leads as a JSON array (useful for CRM handoff)',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max rows (default 50)' } }, required: [] },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      const rows = db.prepare(`SELECT id, full_name AS fullName, company, phone, email, notes, created_at AS createdAt FROM leads WHERE worker_id=? ORDER BY created_at DESC LIMIT ?`).all(ctx.workerId, limit);
      return { result: JSON.stringify(rows, null, 2), leads: rows, count: rows.length };
    },
  },
  {
    name: 'check_business_hours',
    description: 'Check if the business is currently open (Israel timezone). Uses knowledge base hours or BUSINESS_HOURS env.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (args, ctx) => {
      const open = isWithinBusinessHours(ctx.workerKnowledge);
      const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', weekday: 'long', hour: '2-digit', minute: '2-digit' });
      return open
        ? { result: `העסק פתוח כעת (${now}, שעון ישראל).`, open: true }
        : { result: `העסק סגור כעת (${now}, שעון ישראל). הצע ללקוח להשאיר פרטים או לחזור בשעות הפעילות.`, open: false };
    },
  },
  {
    name: 'get_appointment_slots',
    description: 'Suggest available appointment slots for the next few business days (clinic/reception use)',
    parameters: {
      type: 'object', properties: {
        daysAhead: { type: 'number', description: 'How many days ahead to suggest (default 3)' },
      }, required: [],
    },
    handler: async (args, ctx) => {
      const slots = suggestAppointmentSlots(Number(args.daysAhead) || 3);
      return { result: `Suggested slots (Israel time):\n${slots.map((s) => `  - ${s}`).join('\n')}`, slots };
    },
  },
  {
    name: 'save_conversation_summary',
    description: 'Save a short summary of this conversation for future reference with this customer',
    parameters: {
      type: 'object', properties: {
        summary: { type: 'string', description: '1-3 sentence summary of what was discussed and next steps' },
      }, required: ['summary'],
    },
    handler: async (args, ctx) => {
      if (!ctx.customerId) return { result: 'No customerId — summary not saved.' };
      saveConversationSummary(ctx.tenantId, ctx.workerId, ctx.customerId, args.summary);
      return { result: 'Conversation summary saved for this customer.' };
    },
  },
];

const TOOL_ALIASES = {
  'calendar-link': 'get_current_time',
  'send-summary-email': 'send_email',
  'send-confirmation-sms': 'notify_webhook',
  'escalate-to-human': 'escalate_to_human',
  'search-kb': 'search_knowledge',
  'capture-lead': 'save_lead',
  'capture-reservation': 'save_lead',
  'json-output': 'export_leads_json',
  'csv-append': 'export_leads_csv',
  'menu-lookup': 'search_knowledge',
  'track-order': 'search_knowledge',
  'return-lookup': 'search_knowledge',
  'create-ticket': 'escalate_to_human',
  'schedule-visit': 'get_appointment_slots',
  'headline-variants': 'remember_fact',
};

function resolveToolName(name) {
  return TOOL_ALIASES[name] || name;
}

function isWithinBusinessHours(knowledge = '') {
  const envHours = process.env.BUSINESS_HOURS ?? '';
  const text = `${envHours}\n${knowledge}`;
  const m = text.match(/שעות[^:\n]*:?\s*([^\n]+)/i) || text.match(/hours[^:\n]*:?\s*([^\n]+)/i);
  if (!m) return true;
  const line = m[1].toLowerCase();
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const day = now.getDay();
  const hour = now.getHours() + now.getMinutes() / 60;
  if (/שבת|sat/i.test(line) && day === 6) return false;
  if (/שישי|fri/i.test(line) && day === 5 && hour >= 13) return false;
  if (day === 6) return false;
  const range = line.match(/(\d{1,2})[:.]?(\d{0,2})?\s*[-–]\s*(\d{1,2})/);
  if (range) {
    const start = Number(range[1]) + (Number(range[2] || 0) / 60);
    const end = Number(range[3]);
    return hour >= start && hour < end;
  }
  if (/09|9:00|10/.test(line)) return hour >= 9 && hour < 18;
  return true;
}

function suggestAppointmentSlots(daysAhead = 3) {
  const slots = [];
  const base = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  for (let d = 1; d <= daysAhead && slots.length < 6; d++) {
    const day = new Date(base);
    day.setDate(day.getDate() + d);
    const dow = day.getDay();
    if (dow === 6 || dow === 5) continue;
    const label = day.toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem' });
    slots.push(`${label} 10:00`, `${label} 14:30`, `${label} 16:00`);
  }
  return slots.slice(0, 6);
}

const MAX_CONVERSATION_SUMMARIES = 5;

function saveConversationSummary(tenantId, workerId, customerId, summary) {
  const db = getTenantDb(tenantId);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO conversation_summaries (worker_id, customer_id, summary, created_at) VALUES (?, ?, ?, ?)`).run(workerId, customerId, String(summary).slice(0, 2000), now);
  const extra = db.prepare(`SELECT id FROM conversation_summaries WHERE worker_id=? AND customer_id=? ORDER BY id DESC LIMIT -1 OFFSET ?`).all(workerId, customerId, MAX_CONVERSATION_SUMMARIES);
  for (const row of extra) db.prepare(`DELETE FROM conversation_summaries WHERE id=?`).run(row.id);
}

export function getConversationSummaries(tenantId, workerId, customerId, limit = MAX_CONVERSATION_SUMMARIES) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT summary, created_at AS createdAt FROM conversation_summaries WHERE worker_id=? AND customer_id=? ORDER BY id DESC LIMIT ?`).all(workerId, customerId, limit);
}

export function getToolDefs() {
  return TOOL_DEFS;
}

// --- Customer memory & leads ----------------------------------------------

export function getCustomerMemories(tenantId, workerId, customerId) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT key, value, updated_at FROM customer_memories WHERE worker_id=? AND customer_id=? ORDER BY updated_at DESC`).all(workerId, customerId);
}

export function getLeads(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT id, full_name, company, phone, email, notes, created_at FROM leads WHERE worker_id=? ORDER BY created_at DESC`).all(workerId);
}

export function getEscalations(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT id, reason, urgency, status, created_at FROM escalations WHERE worker_id=? ORDER BY created_at DESC`).all(workerId);
}

export function getOutbox(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT id, recipient, subject, body, created_at FROM outbox WHERE worker_id=? ORDER BY created_at DESC`).all(workerId);
}

// --- Per-tenant DB --------------------------------------------------------

const APP_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const TENANTS_DIR = process.env.TENANTS_DIR
  ? path.resolve(process.env.TENANTS_DIR)
  : path.join(APP_DIR, 'data', 'tenants');

export function tenantIdFromApiKey(apiKey) {
  return crypto.createHash('sha256').update('tenant:' + apiKey).digest('hex').slice(0, 24);
}

function ensureTenantDir(tenantId) {
  const dir = path.join(TENANTS_DIR, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const tenantDbs = new Map();
const DB_IDLE_MS = 10 * 60 * 1000;
function closeIdleDbs() {
  const now = Date.now();
  for (const [tid, entry] of tenantDbs) {
    if (now - entry.lastUsed > DB_IDLE_MS) {
      try { entry.db.close(); } catch {}
      tenantDbs.delete(tid);
    }
  }
}
function getTenantDb(tenantId) {
  if (tenantDbs.has(tenantId)) {
    const entry = tenantDbs.get(tenantId);
    entry.lastUsed = Date.now();
    return entry.db;
  }
  closeIdleDbs();
  const dir = ensureTenantDir(tenantId);
  const dbPath = path.join(dir, 'workers.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template_id TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT '',
      tasks_json TEXT NOT NULL DEFAULT '[]',
      knowledge TEXT NOT NULL DEFAULT '',
      tools_json TEXT NOT NULL DEFAULT '[]',
      llm_provider TEXT NOT NULL DEFAULT 'mock',
      llm_model TEXT NOT NULL DEFAULT '',
      llm_base_url TEXT NOT NULL DEFAULT '',
      llm_api_key_enc TEXT,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      paid_until TEXT,
      mcp_servers_json TEXT NOT NULL DEFAULT '[]',
      skills_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_worker ON messages(worker_id, id);
    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'rent',
      amount_ils INTEGER NOT NULL DEFAULT 0,
      payment_channel TEXT,
      payment_reference TEXT,
      paid_until TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rentals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      days INTEGER NOT NULL,
      amount_ils INTEGER NOT NULL DEFAULT 0,
      payment_channel TEXT,
      payment_reference TEXT,
      paid_until TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rentals_worker ON rentals(worker_id);
    CREATE TABLE IF NOT EXISTS customer_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_worker_customer_key ON customer_memories(worker_id, customer_id, key);
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL DEFAULT '',
      full_name TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leads_worker ON leads(worker_id);
    CREATE TABLE IF NOT EXISTS escalations (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      urgency TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_escalations_worker ON escalations(worker_id);
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL DEFAULT '',
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_worker ON outbox(worker_id);
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_summaries_worker ON conversation_summaries(worker_id, customer_id);
  `);
  try { db.exec(`ALTER TABLE workers ADD COLUMN mcp_servers_json TEXT NOT NULL DEFAULT '[]'`); } catch {}
  try { db.exec(`ALTER TABLE workers ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'`); } catch {}
  tenantDbs.set(tenantId, { db, lastUsed: Date.now() });
  return db;
}

// --- Named constants ------------------------------------------------------

const DEFAULT_RENTAL_DAYS = 30;
const LLM_MAX_TOKENS = 1024;
const MAX_TOOL_LOOPS = 8;
const CHAT_HISTORY_LIMIT = 40;
const MOCK_PERSONA_TRUNCATE = 280;

// --- Server LLM config (platform-provided, not BYOK) ---------------------

const DEFAULT_LLM_CONFIG = { apiKey: '', provider: 'openai_compatible', model: 'gpt-5.5', baseUrl: '' };
let SERVER_LLM_CONFIG = { ...DEFAULT_LLM_CONFIG };

export function setServerLlmConfig(cfg) {
  SERVER_LLM_CONFIG = { ...DEFAULT_LLM_CONFIG, ...(cfg ?? {}), apiKey: cfg?.apiKey || '' };
}

function getServerLlmConfig() {
  return SERVER_LLM_CONFIG;
}

// --- Worker CRUD ----------------------------------------------------------

function newId(p) {
  return `${p}_${crypto.randomBytes(12).toString('hex')}`;
}

function starterTasksForTemplate(tpl) {
  const byCategory = {
    sales: ['לענות לפניות חדשות בעברית', 'לאסוף שם, טלפון, צורך ותקציב', 'להציע שיחת המשך עם נציג אנושי', 'להעביר ליד חם לעסק עם סיכום קצר'],
    support: ['לענות לשאלות נפוצות של לקוחות', 'לבדוק מה הבעיה ולבקש פרטים חסרים', 'להעביר תלונות או החזרים לאדם אמיתי', 'לסיים כל שיחה עם צעד הבא ברור'],
    ops: ['לקבל מידע לא מסודר מלקוחות או מסמכים', 'להוציא שדות חשובים בצורה מסודרת', 'לסמן מידע חסר שצריך להשלים', 'להכין סיכום שנוח להעתיק למערכת העסק'],
    content: ['לכתוב טיוטות תוכן בעברית', 'להתאים את הטון לקהל היעד של העסק', 'להציע כמה גרסאות לבחירה', 'לא לפרסם מידע שלא אושר על ידי העסק'],
    realestate: ['לסנן פניות של מחפשי נכסים', 'לאסוף תקציב, אזור, מספר חדרים ותאריך כניסה', 'לתאם ביקור או שיחה עם סוכן', 'להעביר פניות רציניות עם סיכום'],
    healthcare: ['לקבל בקשות לתור או שינוי תור', 'לאסוף שם, טלפון וסיבת הפנייה', 'לענות רק על מידע כללי שהעסק סיפק', 'להעביר שאלות רפואיות או דחופות לאדם'],
    hospitality: ['לקבל הזמנות ושאלות אורחים', 'לאסוף תאריך, שעה, כמות אנשים ופרטי קשר', 'לענות על שאלות תפריט או זמינות לפי המידע שסופק', 'להעביר בקשות חריגות לצוות'],
    ecommerce: ['לעזור ללקוחות עם הזמנות ומוצרים', 'לאסוף מספר הזמנה או פרטי קשר', 'להסביר מדיניות משלוחים והחזרות לפי המידע שסופק', 'להעביר בעיות מורכבות לשירות אנושי'],
    property: ['לקבל פניות מדיירים ובעלי נכסים', 'לאסוף כתובת, סוג תקלה ודחיפות', 'להכין סיכום טיפול מסודר', 'להעביר מקרי חירום לאדם מיד'],
  };
  return byCategory[tpl.category] ?? ['לענות לשאלות של לקוחות בעברית', 'לאסוף פרטי קשר חשובים', 'להעביר מקרים חשובים לאדם', 'לסיים כל שיחה עם צעד הבא ברור'];
}

function starterKnowledgeForTemplate(tpl) {
  return `שם העסק: (כתוב כאן)
מה העסק מוכר או נותן: (כתוב כאן)
שעות פעילות: (כתוב כאן)
מחירים או חבילות: (כתוב כאן)
מתי להעביר לאדם: לקוח כועס, בקשת החזר, שאלה משפטית/רפואית, או כל דבר שהעובד לא יודע.`;
}

export function buyTemplate({ tenantId, templateId, paymentChannel, paymentReference }) {
  const tpl = getTemplate(templateId);
  if (!tpl) return { ok: false, error: 'unknown_template' };
  const db = getTenantDb(tenantId);
  const now = new Date().toISOString();
  const workerId = newId('wk');
  const defaultTasks = starterTasksForTemplate(tpl);
  const defaultTools = tpl.defaultTools;
  const srvCfg = getServerLlmConfig();
  const llmProvider = srvCfg.apiKey ? srvCfg.provider : 'mock';
  const llmModel = srvCfg.apiKey ? srvCfg.model : '';
  db.prepare(`INSERT INTO workers
    (id, name, template_id, persona, tasks_json, knowledge, tools_json, llm_provider, llm_model, llm_base_url, status, paid_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'pending_payment', NULL, ?, ?)`).run(
    workerId, `${tpl.nameHe || tpl.name} (חדש)`, tpl.id, tpl.defaultPersona,
    JSON.stringify(defaultTasks), starterKnowledgeForTemplate(tpl),
    JSON.stringify(defaultTools), llmProvider, llmModel, now, now
  );
  db.prepare(`INSERT INTO purchases
    (id, worker_id, template_id, kind, amount_ils, payment_channel, payment_reference, paid_until, created_at)
    VALUES (?, ?, ?, 'buy', ?, ?, ?, NULL, ?)`).run(
    newId('pur'), workerId, tpl.id, tpl.buyPriceIls, paymentChannel ?? null, paymentReference ?? null, now
  );
  return { ok: true, workerId, template: tpl };
}

export function listWorkers(tenantId) {
  const db = getTenantDb(tenantId);
  const rows = db.prepare(`SELECT id, name, template_id AS templateId, status, paid_until AS paidUntil, created_at AS createdAt, updated_at AS updatedAt FROM workers ORDER BY created_at DESC`).all();
  return rows.map((r) => ({
    ...r,
    template: getTemplate(r.templateId),
    isActive: r.status === 'active' && (!r.paidUntil || new Date(r.paidUntil) > new Date()),
  }));
}

export function getWorker(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  const r = db.prepare(`SELECT * FROM workers WHERE id = ?`).get(workerId);
  if (!r) return null;
  return parseWorkerRow(r);
}

function parseWorkerRow(r) {
  let tasks = []; let tools = []; let mcpServers = []; let skills = [];
  try { tasks = JSON.parse(r.tasks_json || '[]'); } catch {}
  try { tools = JSON.parse(r.tools_json || '[]'); } catch {}
  try { mcpServers = JSON.parse(r.mcp_servers_json || '[]'); } catch {}
  try { skills = JSON.parse(r.skills_json || '[]'); } catch {}
  const srv = getServerLlmConfig();
  const serverHasLlm = !!srv.apiKey;
  const isActive = r.status === 'active' && (!r.paid_until || new Date(r.paid_until) > new Date());
  return {
    id: r.id, name: r.name, templateId: r.template_id,
    persona: r.persona, tasks, knowledge: r.knowledge, tools,
    mcpServers, skills,
    llm: {
      provider: r.llm_provider || srv.provider,
      model: r.llm_model || srv.model,
      baseUrl: r.llm_base_url || srv.baseUrl,
      hasApiKey: serverHasLlm,
      platformProvided: serverHasLlm,
    },
    status: r.status,
    paidUntil: r.paid_until,
    isActive,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function updateWorker(tenantId, workerId, patch) {
  const db = getTenantDb(tenantId);
  const existing = db.prepare(`SELECT id FROM workers WHERE id = ?`).get(workerId);
  if (!existing) return { ok: false, error: 'not_found' };
  const fields = [];
  const values = [];
  if (patch.name !== undefined) { fields.push('name = ?'); values.push(String(patch.name).slice(0, 80)); }
  if (patch.persona !== undefined) { fields.push('persona = ?'); values.push(String(patch.persona)); }
  if (patch.tasks !== undefined) { fields.push('tasks_json = ?'); values.push(JSON.stringify(patch.tasks)); }
  if (patch.knowledge !== undefined) { fields.push('knowledge = ?'); values.push(String(patch.knowledge)); }
  if (patch.tools !== undefined) { fields.push('tools_json = ?'); values.push(JSON.stringify(patch.tools)); }
  if (patch.mcpServers !== undefined) { fields.push('mcp_servers_json = ?'); values.push(JSON.stringify(patch.mcpServers)); }
  if (patch.skills !== undefined) { fields.push('skills_json = ?'); values.push(JSON.stringify(patch.skills)); }
  if (patch.llm) {
    if (patch.llm.provider !== undefined) { fields.push('llm_provider = ?'); values.push(String(patch.llm.provider).slice(0, 30)); }
    if (patch.llm.model !== undefined) { fields.push('llm_model = ?'); values.push(String(patch.llm.model).slice(0, 60)); }
    if (patch.llm.baseUrl !== undefined) { fields.push('llm_base_url = ?'); values.push(String(patch.llm.baseUrl).slice(0, 200)); }
  }
  if (!fields.length) return { ok: true, changed: 0 };
  fields.push('updated_at = ?'); values.push(new Date().toISOString());
  values.push(workerId);
  db.prepare(`UPDATE workers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return { ok: true, changed: fields.length - 1 };
}

export function deleteWorker(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  const r = db.prepare(`DELETE FROM workers WHERE id = ?`).run(workerId);
  db.prepare(`DELETE FROM messages WHERE worker_id = ?`).run(workerId);
  db.prepare(`DELETE FROM rentals WHERE worker_id = ?`).run(workerId);
  db.prepare(`DELETE FROM customer_memories WHERE worker_id = ?`).run(workerId);
  db.prepare(`DELETE FROM leads WHERE worker_id = ?`).run(workerId);
  db.prepare(`DELETE FROM escalations WHERE worker_id = ?`).run(workerId);
  db.prepare(`DELETE FROM outbox WHERE worker_id = ?`).run(workerId);
  db.prepare(`DELETE FROM conversation_summaries WHERE worker_id = ?`).run(workerId);
  return r.changes > 0;
}

export function adminMarkPaid({ workerId, tenantId, days, paymentChannel, paymentReference, amountIls }) {
  if (!tenantId) return { ok: false, error: 'tenantId_required' };
  if (!days || days < 1) days = DEFAULT_RENTAL_DAYS;
  const db = getTenantDb(tenantId);
  const w = db.prepare(`SELECT id, status FROM workers WHERE id = ?`).get(workerId);
  if (!w) return { ok: false, error: 'not_found' };
  const baseDate = new Date();
  const current = db.prepare(`SELECT MAX(paid_until) AS pu FROM rentals WHERE worker_id = ?`).get(workerId);
  if (current?.pu && new Date(current.pu) > baseDate) baseDate.setTime(new Date(current.pu).getTime());
  baseDate.setDate(baseDate.getDate() + days);
  const paidUntil = baseDate.toISOString();
  const now = new Date().toISOString();
  db.prepare(`UPDATE workers SET status = 'active', paid_until = ?, updated_at = ? WHERE id = ?`).run(paidUntil, now, workerId);
  db.prepare(`INSERT INTO rentals (worker_id, tenant_id, days, amount_ils, payment_channel, payment_reference, paid_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(workerId, tenantId, days, amountIls ?? 0, paymentChannel ?? null, paymentReference ?? null, paidUntil, now);
  return { ok: true, paidUntil };
}

export function adminTenantUsageStats() {
  if (!fs.existsSync(TENANTS_DIR)) return [];
  const stats = [];
  for (const tid of fs.readdirSync(TENANTS_DIR)) {
    const dir = path.join(TENANTS_DIR, tid);
    if (!fs.statSync(dir).isDirectory()) continue;
    const dbPath = path.join(dir, 'workers.db');
    if (!fs.existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath);
    const workerCount = db.prepare(`SELECT COUNT(*) AS c FROM workers`).get()?.c ?? 0;
    const activeWorkers = db.prepare(`SELECT COUNT(*) AS c FROM workers WHERE status='active'`).get()?.c ?? 0;
    const messageCount = db.prepare(`SELECT COUNT(*) AS c FROM messages`).get()?.c ?? 0;
    const leadCount = db.prepare(`SELECT COUNT(*) AS c FROM leads`).get()?.c ?? 0;
    const escalationCount = db.prepare(`SELECT COUNT(*) AS c FROM escalations`).get()?.c ?? 0;
    stats.push({ tenantId: tid, workerCount, activeWorkers, messageCount, leadCount, escalationCount });
    db.close();
  }
  return stats.sort((a, b) => b.messageCount - a.messageCount);
}

export function adminListAllWorkers() {
  // Iterate all tenant DBs and collect workers. For small scale this is fine.
  if (!fs.existsSync(TENANTS_DIR)) return [];
  const tenants = fs.readdirSync(TENANTS_DIR);
  const all = [];
  for (const tid of tenants) {
    const dir = path.join(TENANTS_DIR, tid);
    if (!fs.statSync(dir).isDirectory()) continue;
    const dbPath = path.join(dir, 'workers.db');
    if (!fs.existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare(`SELECT id, name, template_id AS templateId, status, paid_until AS paidUntil, created_at AS createdAt FROM workers ORDER BY created_at DESC`).all();
    for (const r of rows) all.push({ ...r, tenantId: tid });
    db.close();
  }
  return all;
}

// --- Messages / chat ------------------------------------------------------

export function listMessages(tenantId, workerId, limit = 100) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT id, role, content, created_at AS createdAt FROM messages WHERE worker_id = ? ORDER BY id ASC LIMIT ?`).all(workerId, limit);
}

function appendMessage(tenantId, workerId, role, content) {
  const db = getTenantDb(tenantId);
  db.prepare(`INSERT INTO messages (worker_id, role, content, created_at) VALUES (?, ?, ?, ?)`).run(workerId, role, content, new Date().toISOString());
}

function templateRuntimeHint(templateId) {
  const hints = {
    'clinic-receptionist-he': '\n\nTEMPLATE RULES (clinic): Use get_appointment_slots for scheduling. Never give medical advice. Escalate urgent symptoms.',
    'real-estate-il': '\n\nTEMPLATE RULES (real estate): Use save_lead for every qualified inquiry. Use export_leads_json when agent asks for lead export.',
    'support-he': '\n\nTEMPLATE RULES (support): Search knowledge first. Escalate if confidence is low, refund requested, or hostile tone. Urgency: high for legal/refund.',
    'restaurant-manager-he': '\n\nTEMPLATE RULES (restaurant): Use check_business_hours before confirming reservations. Capture party size and dietary needs.',
  };
  return hints[templateId] ?? '';
}

function buildSystemPrompt(worker, memories = [], extraToolDefs = [], convSummaries = []) {
  const tasks = (worker.tasks ?? []).map((t, i) => `${i + 1}. ${t}`).join('\n');
  const allToolNames = [...new Set([...(worker.tools ?? []).map(resolveToolName), ...extraToolDefs.map((t) => t.name)])];
  const toolDesc = allToolNames.length
    ? '\n\nAVAILABLE TOOLS (you MAY invoke these to perform actions — you are not required to use them every turn):\n' +
      allToolNames.map((tn) => {
        const td = TOOL_DEFS.find((d) => d.name === tn) || extraToolDefs.find((d) => d.name === tn);
        if (!td) return '';
        const params = Object.entries(td.parameters.properties || {}).map(([k, v]) => `  - ${k} (${v.type}): ${v.description}`).join('\n');
        return `- ${td.name}: ${td.description}\n${params}`;
      }).filter(Boolean).join('\n') +
      '\n\nTo invoke a tool, include a function_call block in your response.'
    : '';
  const memStr = memories.length
    ? '\n\nCUSTOMER FACTS (remembered about this customer):\n' + memories.map((m) => `- ${m.key}: ${m.value}`).join('\n')
    : '';
  const sumStr = convSummaries.length
    ? '\n\nPREVIOUS CONVERSATIONS (summaries with this customer):\n' + convSummaries.map((s) => `- [${s.createdAt?.slice(0, 10) ?? ''}] ${s.summary}`).join('\n')
    : '';
  const tplHint = templateRuntimeHint(worker.templateId);
  return `${worker.persona}

YOUR TASKS (follow these in order):
${tasks || '(no specific tasks set; respond helpfully based on your persona)'}

KNOWLEDGE BASE (treat as ground truth):
${worker.knowledge || '(none provided)'}${memStr}${sumStr}${toolDesc}${tplHint}

RULES:
- Stay in character at all times
- Never reveal you are an AI or language model unless directly asked
- Reply in the language the user writes in (default to Hebrew if worker persona says so)
- Keep replies concise: aim for under 200 words unless more is genuinely needed`.trim();
}

// --- Mock runtime (no LLM key needed) ------------------------------------

function mockReply(worker, history, userMessage) {
  const persona = worker.persona || '';
  const tasks = worker.tasks ?? [];
  const tpl = getTemplate(worker.templateId);
  const userLow = userMessage.toLowerCase();

  // Pick the most relevant task as the "frame" for the reply
  const frame = tasks[0] ?? 'Greet the user and ask how you can help';

  // Tiny intent detection so the mock feels alive
  if (/price|cost|how much|מחיר|כמה|עולה/i.test(userMessage)) {
    return `(${tpl?.name ?? 'Worker'} · demo mode)\n\nThe AI backend is not connected yet, so I'm answering from my persona and tasks.\n\nBased on my instructions, the relevant answer to your pricing question is: "${frame}". For an exact quote, please share your company size, team, and what you're trying to solve, and I'll route you to the right plan.\n\n(Contact the platform admin to activate the AI service.)`;
  }
  if (/who are you|what are you|מי אתה|מה אתה|אתה בוט|robot|ai/i.test(userMessage)) {
    return `(${tpl?.name ?? 'Worker'} · demo mode)\n\nI'm the worker built from the "${tpl?.name ?? 'custom'}" template. My persona says:\n\n${persona.slice(0, MOCK_PERSONA_TRUNCATE)}${persona.length > MOCK_PERSONA_TRUNCATE ? '...' : ''}\n\nI'm currently in demo mode — subscribe to unlock my full AI capabilities.`;
  }
  if (/book|meeting|calendar|פגישה|תור|זמן/i.test(userMessage)) {
    return `(${tpl?.name ?? 'Worker'} · demo mode)\n\nSure, I'd love to book a meeting. Please share: your full name, email, and 2-3 time windows that work for you this week, and the tenant will confirm by email. (Demo mode — no real booking happens.)`;
  }
  // Default: acknowledge + ask a clarifying question that fits the first task
  const firstTask = tasks[0] ?? '';
  const ask = firstTask ? `To start, could you tell me a bit about ${firstTask.toLowerCase().includes('how') ? 'what you need help with' : 'yourself and what brought you here'}?` : 'How can I help?';
  return `(${tpl?.name ?? 'Worker'} · demo mode)\n\nGot it. ${ask}\n\n(This is a demo reply — the AI service is not active yet. Contact the platform admin to activate.)`;
}

// --- Real LLM runtime ----------------------------------------------------

async function callLLM(worker, systemPrompt, messages, toolDefs = [], apiKey = '') {
  const provider = worker.llm.provider || 'openai_compatible';
  const model = worker.llm.model || defaultModelFor(provider);
  if (!apiKey) return { ok: false, error: 'no_api_key' };

  const formattedTools = toolDefs.filter(Boolean).map((td) => {
    if (provider === 'anthropic') {
      return { name: td.name, description: td.description, input_schema: td.parameters };
    }
    return { type: 'function', function: { name: td.name, description: td.description, parameters: td.parameters } };
  });

  const hasTools = formattedTools.length > 0;

  if (provider === 'anthropic') {
    const baseUrl = worker.llm.baseUrl || 'https://api.anthropic.com';
    const body = {
      model, max_tokens: LLM_MAX_TOKENS, system: systemPrompt,
      messages: messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] };
        }
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
          }
        }
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
      }),
    };
    if (hasTools) body.tools = toolDefs;
    const r = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, error: `anthropic_${r.status}`, detail: t.slice(0, 300) };
    }
    const j = await r.json();
    const text = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
    const toolBlocks = (j.content ?? []).filter((c) => c.type === 'tool_use');
    const toolCalls = toolBlocks.length ? toolBlocks.map((c) => ({ id: c.id, name: c.name, args: c.input })) : undefined;
    return { ok: true, text, toolCalls };
  }

  // OpenAI-compatible (covers OpenAI, Groq, OpenRouter, Together, local llama.cpp, etc.)
  const baseUrl = (worker.llm.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
  const oaiMessages = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      oaiMessages.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content) });
    } else if (m.toolCalls) {
      oaiMessages.push({
        role: m.role,
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });
    } else {
      oaiMessages.push({ role: m.role, content: m.content });
    }
  }
  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...oaiMessages],
    max_tokens: LLM_MAX_TOKENS,
    temperature: 0.7,
  };
  if (hasTools) body.tools = toolDefs;
  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: `openai_${r.status}`, detail: t.slice(0, 300) };
  }
  const j = await r.json();
  const msg = j.choices?.[0]?.message ?? {};
  const text = (msg.content ?? '').trim();
  const rawCalls = msg.tool_calls;
  const toolCalls = rawCalls?.length
    ? rawCalls.map((tc) => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      return { id: tc.id, name: tc.function.name, args };
    })
    : undefined;
  return { ok: true, text, toolCalls };
}

const PROVIDER_DEFAULT_MODELS = {
  anthropic: 'claude-opus-4.8',
  groq: 'llama-4-8b-instant',
};
function defaultModelFor(provider) {
  return PROVIDER_DEFAULT_MODELS[provider] ?? getServerLlmConfig().model;
}

export async function chatWithWorker({ tenantId, workerId, userMessage, customerId = '' }) {
  const db = getTenantDb(tenantId);
  const row = db.prepare(`SELECT * FROM workers WHERE id = ?`).get(workerId);
  if (!row) return { ok: false, status: 404, error: 'not_found' };
  const worker = parseWorkerRow(row);
  const srvCfg = getServerLlmConfig();
  if (srvCfg.apiKey) {
    worker.llm.provider = worker.llm.provider || srvCfg.provider;
    worker.llm.model = worker.llm.model || srvCfg.model;
    worker.llm.baseUrl = worker.llm.baseUrl || srvCfg.baseUrl;
  }

  // Active + paid check
  const isPaid = worker.paidUntil && new Date(worker.paidUntil) > new Date();
  if (worker.status !== 'active' || !isPaid) {
    return {
      ok: false, status: 402,
      error: 'payment_required',
      message: 'Worker is not active. Pay the rent (see /marketplace or /invoice) and ask the admin to mark the worker paid.',
      paidUntil: worker.paidUntil ?? null,
    };
  }

  appendMessage(tenantId, workerId, 'user', userMessage);
  const history = db.prepare(`SELECT role, content FROM messages WHERE worker_id = ? ORDER BY id ASC LIMIT ${CHAT_HISTORY_LIMIT}`).all(workerId);
  const memories = getCustomerMemories(tenantId, workerId, customerId);
  const convSummaries = customerId ? getConversationSummaries(tenantId, workerId, customerId) : [];

  // --- MCP tool discovery ---
  let mcpToolDefs = [];
  const mcpErrors = [];
  for (const mcpSrv of (worker.mcpServers ?? [])) {
    try {
      const checkedUrl = await validatePublicHttpUrl(mcpSrv.url);
      if (!checkedUrl.ok) {
        mcpErrors.push({ server: mcpSrv.name || mcpSrv.url, error: `unsafe_url:${checkedUrl.error}` });
        continue;
      }
      const lookup = pinnedLookup(checkedUrl.resolved);
      const tools = await mcpClient.discoverMcpTools(checkedUrl.url, mcpSrv.headers ?? {}, { lookup });
      for (const t of tools) {
        t._isMcp = true;
        t._mcpServerUrl = checkedUrl.url;
        t._mcpHeaders = mcpSrv.headers ?? {};
        t._mcpLookup = lookup;
        t.handler = async (args, ctx) => mcpClient.callMcpTool(t._mcpServerUrl, t.name, args, t._mcpHeaders, { lookup: t._mcpLookup });
      }
      mcpToolDefs.push(...tools);
    } catch (e) {
      mcpErrors.push({ server: mcpSrv.name || mcpSrv.url, error: e.message });
    }
  }

  // Merge local + MCP tool defs into a lookup map
  const allToolDefs = new Map();
  for (const td of TOOL_DEFS) allToolDefs.set(td.name, td);
  for (const td of mcpToolDefs) allToolDefs.set(td.name, td);

  const enabledToolNames = [...new Set(
    (worker.tools ?? []).map(resolveToolName).filter((t) => allToolDefs.has(t))
  )];
  // Add enabled MCP tool names that aren't already in the list
  for (const td of mcpToolDefs) {
    if (!enabledToolNames.includes(td.name)) enabledToolNames.push(td.name);
  }

  const allToolDefsArray = [...TOOL_DEFS, ...mcpToolDefs];
  const systemPrompt = buildSystemPrompt(worker, memories, mcpToolDefs, convSummaries);

  let reply = '';
  let runtime = 'mock';
  let error = null;
  const toolCallsLog = [];

  const chatHistory = history.map((m) => ({ role: m.role, content: m.content }));
  const toolCtx = { tenantId, workerId, customerId, workerName: worker.name, workerKnowledge: worker.knowledge };

  const maxToolLoops = MAX_TOOL_LOOPS;
  let finalReply = '';

  if (srvCfg.apiKey) {
    for (let loop = 0; loop < maxToolLoops; loop++) {
      const llmRes = await callLLM(worker, systemPrompt, chatHistory, allToolDefsArray, srvCfg.apiKey);
      if (!llmRes.ok) {
        error = llmRes.error;
        finalReply = mockReply(worker, chatHistory, userMessage);
        runtime = 'mock_fallback';
        break;
      }
      runtime = worker.llm.provider;
      finalReply = llmRes.text;

      if (!llmRes.toolCalls || llmRes.toolCalls.length === 0) {
        break;
      }

      const assistantMsg = { role: 'assistant', content: llmRes.text, toolCalls: llmRes.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })) };
      chatHistory.push(assistantMsg);

      for (const tc of llmRes.toolCalls) {
        const td = allToolDefs.get(tc.name);
        if (!td) {
          chatHistory.push({ role: 'tool', toolCallId: tc.id, content: `Error: unknown tool "${tc.name}"` });
          toolCallsLog.push({ name: tc.name, args: tc.args, result: `unknown tool` });
          continue;
        }
        try {
          const res = await td.handler(tc.args ?? {}, toolCtx);
          const resultStr = typeof res.result === 'string' ? res.result : JSON.stringify(res);
          chatHistory.push({ role: 'tool', toolCallId: tc.id, content: resultStr });
          toolCallsLog.push({ name: tc.name, args: tc.args, result: resultStr });
        } catch (e) {
          const errMsg = `Error executing ${tc.name}: ${e?.message ?? e}`;
          chatHistory.push({ role: 'tool', toolCallId: tc.id, content: errMsg });
          toolCallsLog.push({ name: tc.name, args: tc.args, result: errMsg });
        }
      }
    }
    reply = finalReply;
  } else {
    reply = mockReply(worker, chatHistory, userMessage);
  }

  appendMessage(tenantId, workerId, 'assistant', reply);
  if (customerId && history.length >= 2) {
    const snippet = history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 100)}`).join(' | ');
    saveConversationSummary(tenantId, workerId, customerId, `Last exchange: ${snippet}`.slice(0, 500));
  }
  return { ok: true, status: 200, reply, runtime, error, mcpErrors: mcpErrors.length ? mcpErrors : undefined, workerId, workerName: worker.name, customerId, toolCalls: toolCallsLog };
}

// --- Learn-from-website generator -----------------------------------------

const URL_PATTERNS = [
  { re: /מסעדה|restaurant|cafe|בר|בית קפה|אוכל|food|מטבח/i, industry: 'מסעדנות', tasks: ['לקבל הזמנות טלפוניות', 'לענות על שאלות תפריט', 'לתאם טייק אווי ומשלוחים', 'לטפל בהזמנות קבוצתיות'], tools: ['save_lead', 'check_business_hours', 'notify_webhook', 'escalate_to_human'] },
  { re: /נדל"ן|real.?estate|דירה|בית|משרד|מגורים|נכס|קרקע/i, industry: 'נדל"ן', tasks: ['לסנן לידים נכנסים', 'לקבוע ביקורי נכסים', 'לענות על שאלות על נכסים', 'לתאם פגישות עם סוכנים'], tools: ['save_lead', 'export_leads_json', 'notify_webhook', 'get_current_time'] },
  { re: /בריאות|רופא|מרפאה|קופת חולים|רפואה|בית מרקחת|dentist|clinic|medical/i, industry: 'רפואה', tasks: ['לקבוע תורים', 'לענות על שאלות רפואיות נפוצות', 'לטפל בביטולים ושינויים', 'להזכיר למטופלים על תורים'], tools: ['save_lead', 'get_appointment_slots', 'check_business_hours', 'escalate_to_human'] },
  { re: /משפט|court|lawyer|עורך דין|משרד|legal|law/i, industry: 'משפט', tasks: ['לתאם פגישות עם עורכי דין', 'לסנן פניות ראשוניות', 'לענות על שאלות כלליות'], tools: ['save_lead', 'calendar-link'] },
  { re: /סטארט.?אפ|startup|tech|הייטק|saas|software/i, industry: 'הייטק', tasks: ['לסנן לידים B2B', 'לקבוע הדגמות מוצר', 'לענות על שאלות מוצר', 'להעביר לידים חמים לצוות המכירות'], tools: ['save_lead', 'calendar-link', 'send-summary-email', 'escalate_to_human'] },
  { re: /מלון|hotel|צימר|אירוח|נופש|hostel|bnb/i, industry: 'תיירות ואירוח', tasks: ['לקבל הזמנות חדרים', 'לענות על שאלות זמינות', 'לתת המלצות מקומיות', 'לטפל בהזמנות קבוצתיות'], tools: ['save_lead', 'get_current_time'] },
  { re: /חנות|shop|store|e.?commerce|מוצר|קניות|אופנה/i, industry: 'קמעונאות', tasks: ['לענות על שאלות מוצרים', 'לסייע במעקב הזמנות', 'לטפל בהחזרות והחלפות', 'להמליץ על מוצרים'], tools: ['save_lead', 'search_knowledge', 'escalate_to_human'] },
  { re: /חינוך|school|בית ספר|מורה|קורס|education|learn/i, industry: 'חינוך', tasks: ['לענות על שאלות על קורסים', 'לרשום תלמידים', 'לתאם שיעורי ניסיון', 'לשלוח חומרי לימוד'], tools: ['save_lead', 'send-summary-email'] },
  { re: /בנק|bank|ביטוח|insurance|פיננסים|finance|משכנתא/i, industry: 'פיננסים', tasks: ['לסנן פניות ראשוניות', 'לקבוע פגישות עם יועצים', 'לענות על שאלות נפוצות', 'להפנות לגורם המתאים'], tools: ['save_lead', 'calendar-link', 'escalate_to_human'] },
  { re: /נגר|קבלן|שיפוץ|בניין|תיקון|electrician|plumber|handyman/i, industry: 'בעלי מקצוע', tasks: ['לקבל פניות לקבלת הצעת מחיר', 'לתאם ביקור בשטח', 'לענות על שאלות על שירותים'], tools: ['save_lead', 'calendar-link'] },
];

function extractPageSignals(html) {
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? '').trim();
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] ?? '').trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3500);
  return { title, desc, text };
}

export async function generateFromUrl(url) {
  const domain = new URL(url).hostname.replace(/^www\./, '');
  let businessName = domain.split('.')[0] || 'העסק';
  let pageText = '';
  let pageTitle = '';
  let pageDesc = '';
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': 'AI-Workers/1.0 (+https://github.com/razel369/ai-workers)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok) {
      const html = await r.text();
      const signals = extractPageSignals(html);
      pageTitle = signals.title;
      pageDesc = signals.desc;
      pageText = signals.text;
      if (pageTitle) businessName = pageTitle.split(/[|\-–]/)[0].trim() || businessName;
    }
  } catch {}

  const businessNameClean = businessName.charAt(0).toUpperCase() + businessName.slice(1);
  const scanText = `${domain} ${businessName} ${pageTitle} ${pageDesc} ${pageText.slice(0, 800)}`;

  const match = URL_PATTERNS.find((p) => p.re.test(scanText));
  const industry = match?.industry || 'שירותים';
  const industryTasks = match?.tasks || [
    'לענות על שאלות של לקוחות',
    'לסנן פניות ראשוניות',
    'לתאם פגישות ושיחות',
    'להעביר מידע רלוונטי ללקוחות',
  ];
  const industryTools = match?.tools || ['save_lead', 'escalate_to_human'];

  const persona = `You are "${businessNameClean} Assistant", an AI customer assistant for ${businessNameClean}.
You write in Hebrew by default. You are professional, friendly, and concise.
You know everything about ${businessNameClean}'s services and can answer customer questions.
You never invent information you don't know — you offer to connect the customer to a human.
You always end your replies with a clear next step or question.`;

  const tasks = [
    'Greet every customer warmly in Hebrew and ask how you can help',
    ...industryTasks,
    "If a customer asks something you don't know, apologize and offer to connect them to a human",
    'At the end, always ask "Is there anything else I can help with?"',
  ];

  const scraped = pageText
    ? `\nScraped site content (verify before relying on it):\n${pageText.slice(0, 1200)}`
    : '';
  const knowledge = `Business: ${businessNameClean}
Website: ${url}
Industry: ${industry}
${pageDesc ? `Site description: ${pageDesc}\n` : ''}Main services: (upload your services and pricing here)
FAQ: (upload common questions and answers here)
Hours: (fill in business hours, e.g. א-ה 09:00-18:00)
Contact: (fill in contact details for escalations)${scraped}`;

  const tools = [...new Set([...industryTools, 'search_knowledge', 'remember_fact', 'recall_facts', 'get_current_time', 'check_business_hours', 'notify_webhook'])];

  return { persona, tasks, knowledge, tools, businessName: businessNameClean, industry, fetched: Boolean(pageText) };
}

// --- Auth helper ----------------------------------------------------------

export function tenantIdFromRequest(req) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (!token.startsWith('sk_')) return null;
  return tenantIdFromApiKey(token);
}

// Exported for tests
export const _internals = { tenantIdFromApiKey, getTenantDb };
