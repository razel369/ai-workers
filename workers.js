// Workers module — Hire-an-AI-Worker marketplace + builder + runtime.
import './bootstrap-env.js';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as mcpClient from './mcp-client.js';
import { SKILLS, getSkill } from './skills.js';
import { pinnedLookup, validatePublicHttpUrl } from './url-security.js';
import { applyMediaTemplateEnhancements } from './templates-media.js';
import { registerMediaTools, resolveMediaFile as resolveMediaFilePath } from './media-tools.js';
import {
  initIntegrationStore,
  registerIntegrationTools,
  getAutoToolNamesForTenant,
  getIntegrationsByType,
  getWebhookUrlForTenant,
} from './integrations/index.js';

export function resolveMediaFile(tenantId, filename) {
  return resolveMediaFilePath(tenantId, filename, ensureTenantDir);
}

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
You are professional, concise, and respectful. You never pressure — you qualify.
You use tools proactively: save_lead with BANT score, book_meeting_link for hot leads, export_leads_csv when asked.`,
    defaultTasks: [
      'Greet the lead warmly in their language and ask how you can help',
      'Within 2-3 messages, gather BANT: full name, company, role, team size, problem, timeline (now/this quarter/exploring), budget range',
      'Score the lead 1-10 using save_lead (7+ = hot). Hot leads: offer book_meeting_link immediately',
      'If not qualified, politely offer a resource and flag_needs_followup for nurture',
      'Always end with one clear next-step question',
    ],
    defaultKnowledge: `Company: (the tenant fills this in)
Product/Service: (the tenant fills this in)
Ideal customer profile: Israeli companies, 10-200 employees, in [industry]
Pricing: (the tenant fills this in)
Meeting link: (the tenant fills this in)
Case studies: (the tenant fills this in)`,
    defaultTools: ['save_lead', 'book_meeting_link', 'export_leads_csv', 'create_crm_note', 'schedule_callback', 'notify_webhook', 'sync_lead_to_crm', 'check_availability', 'send_whatsapp_message'],
    agentCapabilitiesHe: 'מסנן לידים B2B, מדרג BANT (1-10), קובע פגישות, שומר לידים ב-CSV, ושולח webhook לצוות המכירות.',
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
You never make up policies — search_knowledge first, cite sources as [מקור 1].
If confidence is below 55% or refund/legal/hostile tone -> escalate_to_human immediately.
You state your confidence level at the end of each answer.`,
    defaultTasks: [
      'Greet the customer warmly in Hebrew',
      'search_knowledge before answering. Cite KB chunks in reply',
      'If confidence < 55%, say you are not sure and escalate_to_human',
      'If refund, legal, or hostile language -> escalate_to_human priority high',
      'create_crm_note for unresolved issues. End with: "יש עוד משהו שאוכל לעזור בו?"',
    ],
    defaultKnowledge: `Knowledge base: (the tenant uploads FAQs, policies, product docs here)
Refund policy: (the tenant fills this in)
Support hours: Sun-Thu 09:00-18:00 IL time
Escalation email: support@<tenant-domain>`,
    defaultTools: ['search_knowledge', 'escalate_to_human', 'save_conversation_summary', 'create_crm_note', 'flag_needs_followup'],
    agentCapabilitiesHe: 'מחפש במאגר ידע, מצטט מקורות, מחשב ציון ביטחון, ומסלים אוטומטית כשהביטחון נמוך או שיש בקשת החזר.',
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
You NEVER provide medical advice, diagnoses, or opinions — only administrative tasks.
DISCLAIMER (include when symptoms mentioned): "אני מזכיר/ה שאינני נותן/ת ייעוץ רפואי — אנא פנה/י לרופא או למיון במקרה דחוף."
Urgent symptoms (chest pain, severe bleeding, difficulty breathing) -> escalate_to_human priority critical + recommend ER.`,
    defaultTasks: [
      'Greet the patient and ask how you can help',
      'New appointments: get_appointment_slots, collect name, phone, preferred time, visit reason, insurance',
      'Triage urgency: routine vs urgent. Urgent -> escalate_to_human + ER recommendation',
      'Cancellations/rescheduling: confirm details, use schedule_callback if needed',
      'Answer FAQs from knowledge only. Never share other patients info (Privacy Protection Law)',
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
    defaultTools: ['save_lead', 'get_appointment_slots', 'check_availability', 'book_appointment', 'check_business_hours', 'escalate_to_human', 'schedule_callback', 'notify_webhook'],
    agentCapabilitiesHe: 'קובע תורים, מדרג דחיפות רפואית, מציע שעות פנויות, ומזכיר שאין ייעוץ רפואי — רק ניהול מנהלי.',
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
    defaultTools: ['lookup_order', 'track-order', 'return-lookup', 'notify_webhook', 'escalate_to_human'],
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
  {
    id: 'hr-recruiter-he',
    name: 'HR Recruiter Screener',
    nameHe: 'מגייס/ת שכירים',
    description: 'מסנן/ת מועמדים בשיחה בעברית — אוסף/ת ניסיון, זמינות וציפיות שכר, מדרג/ת 1–10, שומר/ת ליד ב-CRM וקובע/ת ראיון ללידים חמים.',
    icon: '👥',
    category: 'admin',
    buyPriceIls: 0,
    rentPriceIls: 279,
    defaultPersona: `You are "Shira", a professional Israeli HR recruiter assistant for the tenant's company.
You speak Hebrew by default and switch to English when the candidate writes in English.
You are warm but efficient — you respect candidates' time and never ask illegal screening questions (age, marital status, religion, pregnancy, military profile beyond job relevance).
You proactively use tools: save_lead with score after gathering basics, book_meeting_link for hot candidates (score 7+), sync_lead_to_crm when CRM is connected, notify_webhook on every qualified candidate.`,
    defaultTasks: [
      'Greet the candidate and ask which role they are applying for (or confirm the open position)',
      'Within 3-5 messages gather: full name, phone, email, years of experience, current employment status, availability to start, salary expectations (range), relevant skills',
      'Score the candidate 1-10 with save_lead (7+ = invite to interview). Notes must include role, experience summary, salary range, availability',
      'Hot candidates (7+): offer book_meeting_link immediately. Warm (4-6): flag_needs_followup. Low fit: thank politely and explain next steps if any',
      'Use remember_fact for role preference and salary range. End with clear next step',
    ],
    defaultKnowledge: `Company name: (the tenant fills this in)
Industry: (the tenant fills this in)
Open positions: (list roles, requirements, location — on-site/hybrid/remote)
Salary bands (internal, do not promise exact): (ranges per role)
Interview process: (e.g. phone screen → technical → HR → offer)
Interview booking link: (Cal.com or internal scheduler URL)
HR contact: (name, email)
Office hours for callbacks: Sun-Thu 09:00-18:00 IL time
Disqualifiers: (e.g. must have valid work permit, driver's license for field roles)`,
    defaultTools: ['save_lead', 'sync_lead_to_crm', 'book_meeting_link', 'export_leads_csv', 'remember_fact', 'notify_webhook', 'flag_needs_followup', 'schedule_callback'],
    agentCapabilitiesHe: 'מסנן מועמדים, מדרג 1–10, שומר לידים, מסנכרן ל-CRM, וקובע ראיונות ללידים חמים.',
  },
  {
    id: 'complaints-desk-he',
    name: 'Complaints & CSAT Desk',
    nameHe: 'מוקד תלונות ושביעות רצון',
    description: 'מקבל תלונות ומשוב בעברית — מתעד כל פנייה, מדרג דחיפות, שומר סיכום שיחה, מסלים לבעלים ושולח התראה ל-webhook.',
    icon: '📣',
    category: 'support',
    buyPriceIls: 0,
    rentPriceIls: 269,
    defaultPersona: `You are "Ruti", a calm and empathetic complaints handler for the tenant's business.
You speak Hebrew by default. You never argue, never dismiss feelings, and never promise refunds/compensation unless explicitly stated in the knowledge base.
You always: (1) acknowledge the issue, (2) collect facts, (3) document with tools, (4) set expectations.
Angry tone, legal threats, or refund demands over the stated policy -> escalate_to_human priority high immediately.
After documenting, use save_conversation_summary and create_crm_note with structured tags.`,
    defaultTasks: [
      'Greet warmly and ask what happened (complaint, praise, suggestion, order problem)',
      'Collect: customer name, phone/email, order/reference number if relevant, what went wrong, when it happened, desired resolution',
      'Classify urgency: low (feedback), normal (service issue), high (safety, repeated failure, legal tone, refund over limit)',
      'create_crm_note with subject, tags (complaint/praise/refund/shipping/product), and metadata. save_conversation_summary with 2-3 sentences',
      'high/critical: escalate_to_human + notify_webhook event complaint_escalated. Offer schedule_callback if customer wants a call back',
      'Close with empathy and realistic timeline from knowledge base (SLA). Never invent compensation',
    ],
    defaultKnowledge: `Business name: (the tenant fills this in)
Complaint SLA: we respond within 24 business hours; resolution target 3-5 business days
Refund policy: (what you can/can't approve in chat — usually escalate refunds)
Escalation contact: (manager name, email)
Common issues & approved responses: (paste FAQs)
Forbidden promises: no free products, no cash refunds in chat without manager approval
Praise handling: thank and ask permission to use as testimonial (optional)`,
    defaultTools: ['save_conversation_summary', 'create_crm_note', 'escalate_to_human', 'notify_webhook', 'remember_fact', 'flag_needs_followup', 'schedule_callback', 'save_lead'],
    agentCapabilitiesHe: 'מתעד תלונות ומשוב, יוצר הערות CRM, מסלים דחוף, שולח webhook ומציע callback.',
  },
  {
    id: 'legal-receptionist-he',
    name: 'Professional Office Receptionist',
    nameHe: 'מזכיר/ה למשרד מקצועי',
    description: 'מסנן פניות ראשוניות למשרדי עו"ד, רואי חשבון ויועצים — מזהה נושא, קובע פגישה, שומר ליד ומסלים דחוף. לא נותן ייעוץ מקצועי.',
    icon: '⚖️',
    category: 'admin',
    buyPriceIls: 0,
    rentPriceIls: 299,
    defaultPersona: `You are "Dana", a discreet and professional receptionist for a law / accounting / consulting office in Israel.
You speak Hebrew by default. You NEVER provide legal, tax, or financial advice — only intake and scheduling.
DISCLAIMER when legal/tax questions arise: "אני מזכיר/ה — אין כאן ייעוץ משפטי/חשבונאי. אפשר לקבוע פגישה עם איש מקצוע."
Urgent matters (court deadline tomorrow, tax authority notice, detention, violence) -> escalate_to_human priority critical.
You use save_lead for every new inquiry, check_availability / book_appointment for meetings, create_crm_note with matter type.`,
    defaultTasks: [
      'Greet professionally and ask the nature of the inquiry (legal, accounting, consulting, other)',
      'Gather: full name, phone, email, brief description (2-3 sentences max), urgency, whether they are an existing client',
      'Never advise on merits — only classify matter type and urgency. Existing vs new client affects routing',
      'Routine: check_availability or get_appointment_slots, then book_appointment or book_meeting_link. save_lead with score (urgency-based 1-10)',
      'create_crm_note with matter tags (family-law, civil, criminal, tax, audit, contract, other). critical/high urgency -> escalate_to_human',
      'Outside business hours: check_business_hours, offer schedule_callback',
    ],
    defaultKnowledge: `Office name: (the tenant fills this in)
Practice areas: (e.g. דיני עבודה, מיסים, גירושין, חוזים)
Attorneys / partners: (names and specialties — for routing only)
Consultation fee: (initial meeting fee if applicable — do not negotiate)
Booking link: (Cal.com / office scheduler)
Office address: (the tenant fills this in)
Hours: Sun-Thu 09:00-18:00, Fri 09:00-12:00 IL time
Existing client verification: (last 4 digits of ID / case number — optional)
Emergency line: (phone for urgent matters only)`,
    defaultTools: ['save_lead', 'book_appointment', 'check_availability', 'get_appointment_slots', 'book_meeting_link', 'create_crm_note', 'escalate_to_human', 'schedule_callback', 'check_business_hours', 'notify_webhook'],
    agentCapabilitiesHe: 'מסנן פניות למשרד מקצועי, קובע פגישות, שומר לידים והערות CRM, ומסלים דחוף — בלי ייעוץ משפטי.',
  },
];

applyMediaTemplateEnhancements(TEMPLATES);

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

// --- Tool system ----------------------------------------------------------

function chunkKnowledge(text = '') {
  return String(text)
    .split(/\n\s*\n+/)
    .map((c) => c.replace(/\s+/g, ' ').trim())
    .filter((c) => c.length > 20);
}

function scoreLeadFromNotes(notes = '', explicitScore) {
  if (explicitScore != null && Number.isFinite(Number(explicitScore))) {
    return Math.min(10, Math.max(1, Math.round(Number(explicitScore))));
  }
  const n = String(notes).toLowerCase();
  let score = 4;
  if (/budget|תקציב|₪|\d+\s*(שקל|ils)/i.test(n)) score += 2;
  if (/now|urgent|דחוף|הרבעון|רבעון|timeline|ציר זמן/i.test(n)) score += 2;
  if (/decision|מקבל החלטות|ceo|מנכ"ל|owner|בעלים/i.test(n)) score += 1;
  if (/team|עובדים|employees|\d+\s*(אנשים|עובד)/i.test(n)) score += 1;
  return Math.min(10, Math.max(1, score));
}

function urgencyFromArgs(args = {}) {
  return args.priority || args.urgency || 'normal';
}

async function fireWebhook(event, payload, ctx) {
  const body = { event, payload, workerId: ctx.workerId, tenantId: ctx.tenantId, customerId: ctx.customerId ?? '', at: new Date().toISOString() };
  const url = getWebhookUrlForTenant(ctx.tenantId)
    || process.env.WEBHOOK_NOTIFY_URL || process.env.SLACK_WEBHOOK_URL
    || process.env[`WORKER_${ctx.workerId.slice(0, 8).toUpperCase()}_WEBHOOK`] || '';
  if (!url) return { sent: false, logged: body };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { sent: r.ok, status: r.status };
  } catch (e) {
    return { sent: false, error: e?.message ?? String(e) };
  }
}

function upsertCustomerProfile(tenantId, workerId, customerId, patch = {}) {
  if (!customerId) return;
  const db = getTenantDb(tenantId);
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT preferences_json FROM customer_profiles WHERE worker_id=? AND customer_id=?`).get(workerId, customerId);
  let prefs = {};
  try { prefs = JSON.parse(existing?.preferences_json || '{}'); } catch {}
  if (patch.preferences) prefs = { ...prefs, ...patch.preferences };
  db.prepare(`INSERT INTO customer_profiles (worker_id, customer_id, name, phone, preferences_json, last_intent, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(worker_id, customer_id) DO UPDATE SET
      name=COALESCE(excluded.name, customer_profiles.name),
      phone=COALESCE(excluded.phone, customer_profiles.phone),
      preferences_json=excluded.preferences_json,
      last_intent=COALESCE(excluded.last_intent, customer_profiles.last_intent),
      updated_at=excluded.updated_at`).run(
    workerId, customerId,
    patch.name ?? null, patch.phone ?? null,
    JSON.stringify(prefs), patch.lastIntent ?? null, now
  );
}

const TOOL_DEFS = [
  {
    name: 'get_current_time',
    description: 'Get the current date and time (useful for scheduling, deadlines, and context)',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (args, ctx) => ({ result: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) }),
  },
  {
    name: 'save_lead',
    description: 'Save a qualified lead with contact information, BANT notes, and lead score 1-10',
    parameters: {
      type: 'object', properties: {
        fullName: { type: 'string', description: 'Lead full name' },
        company: { type: 'string', description: 'Company name' },
        phone: { type: 'string', description: 'Phone number' },
        email: { type: 'string', description: 'Email address' },
        notes: { type: 'string', description: 'Lead qualification notes (BANT: budget, authority, need, timeline)' },
        score: { type: 'number', description: 'Lead quality score 1-10 (auto-computed from notes if omitted)' },
      }, required: ['fullName'],
    },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const score = scoreLeadFromNotes(args.notes, args.score);
      const leadId = newId('lead');
      db.prepare(`INSERT INTO leads (id, worker_id, customer_id, full_name, company, phone, email, notes, score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        leadId, ctx.workerId, ctx.customerId ?? '',
        args.fullName, args.company ?? '', args.phone ?? '', args.email ?? '', args.notes ?? '', score, new Date().toISOString()
      );
      upsertCustomerProfile(ctx.tenantId, ctx.workerId, ctx.customerId, {
        name: args.fullName, phone: args.phone, lastIntent: 'lead_capture',
        preferences: { company: args.company, email: args.email, leadScore: score },
      });
      const webhook = await fireWebhook('new_lead', { leadId, fullName: args.fullName, company: args.company, phone: args.phone, email: args.email, score, notes: args.notes }, ctx);
      return {
        result: `Lead saved: ${args.fullName}${args.company ? ' from ' + args.company : ''} (score ${score}/10)${webhook.sent ? '. Webhook notified.' : ''}`,
        leadId, score,
      };
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search the worker knowledge base (chunked) for relevant information. Returns citations for replies.',
    parameters: {
      type: 'object', properties: {
        query: { type: 'string', description: 'Search query' },
        maxChunks: { type: 'number', description: 'Max chunks to return (default 3)' },
      }, required: ['query'],
    },
    handler: async (args, ctx) => {
      const q = String(args.query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const chunks = chunkKnowledge(ctx.workerKnowledge ?? '');
      const scored = chunks.map((chunk, i) => {
        const low = chunk.toLowerCase();
        const hits = q.reduce((n, term) => n + (low.includes(term) ? 1 : 0), 0);
        return { chunk, i, hits, score: hits / Math.max(q.length, 1) };
      }).filter((c) => c.hits > 0).sort((a, b) => b.score - a.score);
      const max = Math.min(Math.max(Number(args.maxChunks) || 3, 1), 5);
      const top = scored.slice(0, max);
      if (top.length === 0) {
        return { result: 'No relevant information found in the knowledge base.', matches: [], confidence: 0 };
      }
      const confidence = Math.min(0.95, 0.35 + top[0].score * 0.45);
      const citations = top.map((t, idx) => `[${idx + 1}] ${t.chunk.slice(0, 280)}${t.chunk.length > 280 ? '…' : ''}`);
      return {
        result: `Found ${top.length} relevant section(s) (confidence ${(confidence * 100).toFixed(0)}%):\n` + citations.join('\n'),
        matches: citations,
        confidence,
        citations,
      };
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Escalate to a human agent with priority. Notifies Slack/webhook when configured.',
    parameters: {
      type: 'object', properties: {
        reason: { type: 'string', description: 'Why this needs a human' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Urgency level' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Priority (alias for urgency)' },
      }, required: ['reason'],
    },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const id = newId('esc');
      const urgency = urgencyFromArgs(args);
      db.prepare(`INSERT INTO escalations (id, worker_id, customer_id, reason, urgency, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?)`).run(
        id, ctx.workerId, ctx.customerId ?? '', args.reason, urgency, new Date().toISOString()
      );
      upsertCustomerProfile(ctx.tenantId, ctx.workerId, ctx.customerId, { lastIntent: 'escalation' });
      const webhook = await fireWebhook('escalation', { escalationId: id, reason: args.reason, urgency }, ctx);
      return {
        result: `Escalation #${id.slice(0, 12)} created. Priority: ${urgency}. A human will follow up.${webhook.sent ? ' Webhook/Slack notified.' : ''}`,
        escalationId: id, urgency,
      };
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
      const rows = db.prepare(`SELECT full_name, company, phone, email, notes, score, created_at FROM leads WHERE worker_id=? ORDER BY created_at DESC LIMIT 500`).all(ctx.workerId);
      const esc = (v) => {
        const s = String(v ?? '');
        return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = 'full_name,company,phone,email,notes,score,created_at\n';
      const csv = header + rows.map((r) => [r.full_name, r.company, r.phone, r.email, r.notes, r.score, r.created_at].map(esc).join(',')).join('\n');
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
    name: 'schedule_callback',
    description: 'Schedule a callback for the customer. Stored in outbox for the business to action.',
    parameters: {
      type: 'object', properties: {
        phone: { type: 'string', description: 'Phone to call back' },
        preferredTime: { type: 'string', description: 'When to call (free text or ISO datetime)' },
        notes: { type: 'string', description: 'Context for the callback' },
      }, required: ['phone'],
    },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const id = newId('cb');
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO schedule_callbacks (id, worker_id, customer_id, phone, preferred_time, notes, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
        id, ctx.workerId, ctx.customerId ?? '', args.phone, args.preferredTime ?? '', args.notes ?? '', now
      );
      db.prepare(`INSERT INTO outbox (worker_id, customer_id, recipient, subject, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        ctx.workerId, ctx.customerId ?? '', args.phone,
        'Callback scheduled', `Call ${args.phone} at ${args.preferredTime || 'ASAP'}: ${args.notes || ''}`, now
      );
      upsertCustomerProfile(ctx.tenantId, ctx.workerId, ctx.customerId, { phone: args.phone, lastIntent: 'callback_scheduled' });
      await fireWebhook('schedule_callback', { callbackId: id, phone: args.phone, preferredTime: args.preferredTime, notes: args.notes }, ctx);
      return { result: `Callback scheduled for ${args.phone}${args.preferredTime ? ' at ' + args.preferredTime : ''}.`, callbackId: id };
    },
  },
  {
    name: 'create_crm_note',
    description: 'Create a structured CRM note (JSON) for handoff to CRM or spreadsheet',
    parameters: {
      type: 'object', properties: {
        subject: { type: 'string', description: 'Note subject' },
        body: { type: 'string', description: 'Note body' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags e.g. hot-lead, support' },
        metadata: { type: 'object', description: 'Extra structured fields' },
      }, required: ['subject'],
    },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const id = newId('crm');
      const note = {
        id, subject: args.subject, body: args.body ?? '', tags: args.tags ?? [],
        metadata: args.metadata ?? {}, customerId: ctx.customerId ?? '', workerId: ctx.workerId,
        createdAt: new Date().toISOString(),
      };
      db.prepare(`INSERT INTO crm_notes (id, worker_id, customer_id, note_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        id, ctx.workerId, ctx.customerId ?? '', JSON.stringify(note), note.createdAt
      );
      return { result: `CRM note created: ${args.subject}`, note, exportJson: JSON.stringify(note, null, 2) };
    },
  },
  {
    name: 'book_meeting_link',
    description: 'Return the meeting booking link from knowledge base and log the booking intent',
    parameters: {
      type: 'object', properties: {
        leadName: { type: 'string', description: 'Lead name' },
        preferredWindow: { type: 'string', description: 'Preferred time window' },
      }, required: [],
    },
    handler: async (args, ctx) => {
      const kb = ctx.workerKnowledge ?? '';
      const linkMatch = kb.match(/(?:meeting link|קישור לפגישה|לינק)[:\s]+(\S+)/i);
      const link = linkMatch?.[1] ?? process.env.MEETING_BOOKING_URL ?? '';
      if (args.leadName) {
        upsertCustomerProfile(ctx.tenantId, ctx.workerId, ctx.customerId, {
          name: args.leadName, lastIntent: 'meeting_booking',
          preferences: { preferredWindow: args.preferredWindow },
        });
      }
      if (!link) return { result: 'Meeting link not configured in knowledge base. Ask the customer for 2-3 time windows.', link: null };
      await fireWebhook('meeting_booking', { leadName: args.leadName, preferredWindow: args.preferredWindow, link }, ctx);
      return { result: `Share this booking link with the customer: ${link}`, link };
    },
  },
  {
    name: 'flag_needs_followup',
    description: 'Flag this customer conversation for proactive follow-up by the business',
    parameters: {
      type: 'object', properties: {
        reason: { type: 'string', description: 'Why follow-up is needed' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Follow-up priority' },
        scheduledFor: { type: 'string', description: 'When to follow up (optional ISO date)' },
      }, required: ['reason'],
    },
    handler: async (args, ctx) => {
      const db = getTenantDb(ctx.tenantId);
      const id = newId('fu');
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO followup_triggers (id, worker_id, customer_id, reason, priority, status, scheduled_for, created_at)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`).run(
        id, ctx.workerId, ctx.customerId ?? '', args.reason, args.priority ?? 'normal', args.scheduledFor ?? null, now
      );
      upsertCustomerProfile(ctx.tenantId, ctx.workerId, ctx.customerId, { lastIntent: 'needs_followup' });
      await fireWebhook('needs_followup', { followupId: id, reason: args.reason, priority: args.priority }, ctx);
      return { result: `Follow-up flagged: ${args.reason}`, followupId: id };
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
  'calendar-link': 'book_meeting_link',
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
  return db.prepare(`SELECT id, full_name, company, phone, email, notes, score, created_at FROM leads WHERE worker_id=? ORDER BY created_at DESC`).all(workerId);
}

export function getCustomerProfile(tenantId, workerId, customerId) {
  if (!customerId) return null;
  const db = getTenantDb(tenantId);
  const row = db.prepare(`SELECT name, phone, preferences_json, last_intent, updated_at FROM customer_profiles WHERE worker_id=? AND customer_id=?`).get(workerId, customerId);
  if (!row) return null;
  let preferences = {};
  try { preferences = JSON.parse(row.preferences_json || '{}'); } catch {}
  return { name: row.name, phone: row.phone, preferences, lastIntent: row.last_intent, updatedAt: row.updated_at };
}

export function getFollowups(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT id, customer_id AS customerId, reason, priority, status, scheduled_for AS scheduledFor, created_at AS createdAt FROM followup_triggers WHERE worker_id=? ORDER BY created_at DESC`).all(workerId);
}

export function getCrmNotes(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT id, customer_id AS customerId, note_json AS noteJson, created_at AS createdAt FROM crm_notes WHERE worker_id=? ORDER BY created_at DESC LIMIT 100`).all(workerId);
}

export function getToolCatalog() {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export function getEscalations(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT id, reason, urgency, status, created_at FROM escalations WHERE worker_id=? ORDER BY created_at DESC`).all(workerId);
}

export function getOutbox(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  return db.prepare(`SELECT id, recipient, subject, body, created_at FROM outbox WHERE worker_id=? ORDER BY created_at DESC`).all(workerId);
}

export function logAgentActions(tenantId, workerId, customerId, toolCalls = []) {
  if (!toolCalls?.length) return;
  const db = getTenantDb(tenantId);
  const stmt = db.prepare(
    `INSERT INTO agent_actions (worker_id, customer_id, tool_name, args_json, result_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  for (const tc of toolCalls) {
    stmt.run(
      workerId,
      customerId ?? '',
      tc.name ?? 'unknown',
      JSON.stringify(tc.args ?? {}),
      String(tc.result ?? '').slice(0, 500),
      now
    );
  }
}

export function getAgentActions(tenantId, workerId, limit = 30) {
  const db = getTenantDb(tenantId);
  return db.prepare(
    `SELECT id, customer_id AS customerId, tool_name AS toolName, args_json AS argsJson,
            result_summary AS resultSummary, created_at AS createdAt
     FROM agent_actions WHERE worker_id=? ORDER BY id DESC LIMIT ?`
  ).all(workerId, limit);
}

export function getWorkerInsights(tenantId, workerId) {
  const db = getTenantDb(tenantId);
  const row = db.prepare(`SELECT id, name, status, paid_until, template_id FROM workers WHERE id=?`).get(workerId);
  if (!row) return null;
  const isActive = row.status === 'active' && (!row.paid_until || new Date(row.paid_until) > new Date());
  const counts = {
    leads: db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE worker_id=?`).get(workerId).c,
    openEscalations: db.prepare(`SELECT COUNT(*) AS c FROM escalations WHERE worker_id=? AND status='open'`).get(workerId).c,
    messages: db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE worker_id=?`).get(workerId).c,
    outbox: db.prepare(`SELECT COUNT(*) AS c FROM outbox WHERE worker_id=?`).get(workerId).c,
    agentActions: db.prepare(`SELECT COUNT(*) AS c FROM agent_actions WHERE worker_id=?`).get(workerId).c,
  };
  const recentLeads = db.prepare(
    `SELECT id, full_name AS fullName, phone, email, score, notes, created_at AS createdAt
     FROM leads WHERE worker_id=? ORDER BY created_at DESC LIMIT 8`
  ).all(workerId);
  const recentEscalations = db.prepare(
    `SELECT id, reason, urgency, status, created_at AS createdAt
     FROM escalations WHERE worker_id=? ORDER BY created_at DESC LIMIT 8`
  ).all(workerId);
  const recentActions = getAgentActions(tenantId, workerId, 12);
  const recentOutbox = db.prepare(
    `SELECT id, recipient, subject, body, created_at AS createdAt
     FROM outbox WHERE worker_id=? ORDER BY created_at DESC LIMIT 6`
  ).all(workerId);
  return {
    worker: {
      id: row.id,
      name: row.name,
      templateId: row.template_id,
      status: row.status,
      paidUntil: row.paid_until,
      isActive,
    },
    counts,
    recentLeads,
    recentEscalations,
    recentActions,
    recentOutbox,
  };
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
    CREATE TABLE IF NOT EXISTS customer_profiles (
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      preferences_json TEXT NOT NULL DEFAULT '{}',
      last_intent TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (worker_id, customer_id)
    );
    CREATE TABLE IF NOT EXISTS schedule_callbacks (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL,
      preferred_time TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_callbacks_worker ON schedule_callbacks(worker_id);
    CREATE TABLE IF NOT EXISTS followup_triggers (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      scheduled_for TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_followups_worker ON followup_triggers(worker_id);
    CREATE TABLE IF NOT EXISTS crm_notes (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL DEFAULT '',
      note_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_notes_worker ON crm_notes(worker_id);
    CREATE TABLE IF NOT EXISTS agent_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      customer_id TEXT NOT NULL DEFAULT '',
      tool_name TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '{}',
      result_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_actions_worker ON agent_actions(worker_id, id DESC);
  `);
  try { db.exec(`ALTER TABLE workers ADD COLUMN mcp_servers_json TEXT NOT NULL DEFAULT '[]'`); } catch {}
  try { db.exec(`ALTER TABLE workers ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'`); } catch {}
  try { db.exec(`ALTER TABLE workers ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'agent'`); } catch {}
  try { db.exec(`ALTER TABLE leads ADD COLUMN score INTEGER`); } catch {}
  tenantDbs.set(tenantId, { db, lastUsed: Date.now() });
  return db;
}

// --- Named constants ------------------------------------------------------

const DEFAULT_RENTAL_DAYS = 30;
const LLM_MAX_TOKENS = 1024;
const MAX_AGENT_STEPS = 5;
const AGENT_LOOP_TIMEOUT_MS = 45_000;
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

export const TEMPLATE_SUGGESTIONS = {
  'clinic-receptionist-he': ['קביעת תור', 'שעות פתיחה', 'ביטוחים מכוסים'],
  'restaurant-manager-he': ['הזמנת שולחן', 'מה בתפריט?', 'טייק אווי'],
  'sales-leads-il': ['ספרו לי על השירות', 'רוצה פגישה', 'מה המחיר?'],
  'support-he': ['שעות פעילות', 'מדיניות החזרות', 'דברו עם נציג'],
  'real-estate-il': ['יש דירות פנויות?', 'לקבוע ביקור', 'מה התקציב המינימלי?'],
  'ecom-support-he': ['איפה ההזמנה שלי?', 'איך מחזירים מוצר?', 'יש במלאי?'],
  'property-manager-he': ['תקלה בדירה', 'מתי משלמים שכר דירה?', 'דחוף — דליפת מים'],
  'content-he': ['פוסט ללינקדאין', 'מודעה לפייסבוק', 'כותרות חלופיות'],
  'data-entry': ['חלץ פרטים מהטקסט', 'הכן שורת CSV', 'מה חסר במסמך?'],
  'hr-recruiter-he': ['יש משרה פתוחה?', 'רוצה לקבוע ראיון', 'מה תהליך הגיוס?'],
  'complaints-desk-he': ['יש לי תלונה', 'רוצה לדבר עם מנהל', 'הזמנה לא הגיעה'],
  'legal-receptionist-he': ['לקבוע ייעוץ', 'שאלה על חוזה', 'דחוף — מועד בבית משפט'],
};

const TEMPLATE_KNOWLEDGE_BOILERPLATE = {
  'clinic-receptionist-he': (biz) => `שם המרפאה: ${biz}
כתובת: (רחוב, עיר)
טלפון: 03-0000000
שעות פעילות: א-ה 08:00-19:00, ו 08:00-12:00
רופאים: ד"ר כהן — רפואת משפחה, ד"ר לוי — אורתופדיה
קופות חולים: כללית, מכבי, מאוחדת, לאומית
ביטוחים פרטיים: (רשימה)
מדיניות ביטול תור: 24 שעות מראש
חניה: חניון הבניין / רחוב
הערה: אין ייעוץ רפואי בצ'אט — רק ניהול תורים ומידע כללי`,
  'restaurant-manager-he': (biz) => `שם המסעדה: ${biz}
כתובת: (רחוב, עיר)
טלפון: 050-0000000
שעות: א-ה 12:00-23:00, ו 11:00-15:00, שבת סגור
סוג מטבח: ישראלי / איטלקי / אסייתי
כשרות: (רבנות מקומית / לא כשר)
תפריט עיקרי: (הדביקו מנות ומחירים)
הזמנת שולחן: עד 8 אנשים בצ'אט, מעל — התקשרו
טייק אווי: זמין, זמן הכנה ~20 דקות
אלרגיות: ציינו בהזמנה — נשמח להתאים`,
  'sales-leads-il': (biz) => `שם החברה: ${biz}
מה אנחנו מוכרים: (תיאור קצר)
קהל יעד: עסקים בישראל, 10-200 עובדים
מחירון: החל מ-₪___ לחודש
קישור לפגישה: https://cal.com/...
שעות מכירות: א-ה 09:00-18:00
מתי להעביר לנציג: ליד חם (ציון 7+), בקשה לחוזה, שאלה משפטית`,
  'support-he': (biz) => `שם העסק: ${biz}
שעות שירות: א-ה 09:00-18:00
מדיניות החזרות: 14 יום, מוצר שלם באריזה מקורית
זמן משלוח: 3-5 ימי עסקים
אימייל תמיכה: support@example.co.il
שאלות נפוצות: (הדביקו כאן)
מתי להעביר לאדם: החזר כספי, תלונה, שפה משפטית`,
  'real-estate-il': (biz) => `שם המשרד: ${biz}
אזורי פעילות: תל אביב, רמת גן, גבעתיים
נכסים זמינים: (הדביקו רשימת דירות)
עמלת תיווך: 2% + מע"מ
שעות: א-ה 09:00-19:00, שישי 09:00-13:00
רישיון תיווך: (מספר)
תיאום ביקור: דרך הצ'אט או בטלפון`,
  'ecom-support-he': (biz) => `שם החנות: ${biz}
אתר: https://...
משלוח חינם מעל: ₪199
זמני אספקה: 3-7 ימי עסקים
החזרות: 14 יום מקבלת המשלוח
שירותי משלוח: דואר ישראל, צ'יטה, שליח עד הבית
אימייל: service@example.co.il`,
  'property-manager-he': (biz) => `חברת ניהול: ${biz}
בניינים מנוהלים: (רשימת כתובות)
שכר דירה: מועד תשלום 1 לחודש, העברה בנקאית
תחזוקה דחופה: דליפה, גז, נעילה — טלפון חירום 050-0000000
שעות משרד: א-ה 09:00-17:00
מדיניות פיקדון: החזר תוך 30 יום מסיום חוזה`,
  'hr-recruiter-he': (biz) => `שם החברה: ${biz}
תחום: (הייטק / קמעונאות / שירותים וכו')
משרות פתוחות: (תפקיד — דרישות — מיקום)
טווח שכר פנימי (לא להבטיח מועמד): (לדוגמה 12-18K ברוטו)
קישור לקביעת ראיון: https://cal.com/...
איש קשר HR: (שם, מייל)
שעות מענה: א-ה 09:00-18:00
שאלות אסורות בגיוס: גיל, מצב משפחתי, דת, הריון`,
  'complaints-desk-he': (biz) => `שם העסק: ${biz}
זמן מענה לתלונה: עד 24 שעות בימי עסקים
מדיניות החזר: (מה מאושר בצ'אט — בדרך כלל להעביר למנהל)
איש קשר להסלמה: (שם מנהל, טלפון)
נושאים נפוצים: (משלוח, מוצר פגום, שירות, חיוב)
מה אסור להבטיח בצ'אט: החזר כספי, פיצוי, הנחה — רק מנהל`,
  'legal-receptionist-he': (biz) => `שם המשרד: ${biz}
תחומי עיסוק: (משפטי / חשבונאי / ייעוץ עסקי)
עורכי דין / יועצים: (שמות ותחומים)
דמי ייעוץ ראשוני: ₪___ (אם רלוונטי)
קישור לקביעת פגישה: https://cal.com/...
כתובת: (רחוב, עיר)
שעות: א-ה 09:00-18:00, ו 09:00-12:00
קו חירום: 050-0000000 (דחוף בלבד)
הערה: אין ייעוץ משפטי/חשבונאי בצ'אט — רק קבלת פניות ותיאום`,
};

export function getTemplateSuggestions(templateId) {
  return TEMPLATE_SUGGESTIONS[templateId] ?? ['שלום', 'מה אתם עושים?', 'איך יוצרים קשר?'];
}

export function buildSmartKnowledge(templateId, businessName = 'העסק שלי') {
  const tpl = getTemplate(templateId);
  const biz = String(businessName || 'העסק שלי').trim();
  const custom = TEMPLATE_KNOWLEDGE_BOILERPLATE[templateId];
  if (custom) return custom(biz);
  if (tpl?.defaultKnowledge) {
    return tpl.defaultKnowledge.replace(/\(the tenant fills this in\)/gi, `(${biz} — מלאו כאן)`);
  }
  return starterKnowledgeForTemplate(tpl ?? { category: 'support' }, biz);
}

function starterKnowledgeForTemplate(tpl, businessName = '') {
  const biz = businessName || '(כתוב כאן)';
  const custom = tpl?.id && TEMPLATE_KNOWLEDGE_BOILERPLATE[tpl.id];
  if (custom) return custom(biz);
  return `שם העסק: ${biz}
מה העסק מוכר או נותן: (כתוב כאן)
שעות פעילות: א-ה 09:00-18:00, שישי 09:00-13:00
מחירים או חבילות: (כתוב כאן)
טלפון: 050-0000000
מתי להעביר לאדם: לקוח כועס, בקשת החזר, שאלה משפטית/רפואית, או כל דבר שהעובד לא יודע.`;
}

export function getWorkerHealth(worker) {
  const srv = getServerLlmConfig();
  const hasLlm = !!(srv.apiKey || worker.llm?.hasApiKey);
  if (!hasLlm) return { status: 'needs_llm', labelHe: 'צריך הגדרה', tone: 'warn' };
  if (worker.isActive) {
    if (worker.paidUntil && new Date(worker.paidUntil) > new Date()) {
      const d = new Date(worker.paidUntil).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
      return { status: 'active_until', labelHe: `פעיל עד ${d}`, tone: 'ok' };
    }
    return { status: 'healthy', labelHe: 'עובד תקין ✓', tone: 'ok' };
  }
  if (worker.status === 'pending_payment') return { status: 'trial', labelHe: 'מצב ניסיון — דמו', tone: 'info' };
  return { status: 'expired', labelHe: 'פג תוקף — צריך חידוש', tone: 'warn' };
}

function llmErrorMessageHe(error, detail = '') {
  const e = String(error || '').toLowerCase();
  const d = String(detail || '').toLowerCase();
  if (e.includes('429') || d.includes('rate') || d.includes('limit') || d.includes('too many')) {
    return 'המערכת עמוסה כרגע — נסו שוב בעוד דקה. אנחנו ממשיכים לעבוד בשבילכם.';
  }
  if (e.includes('timeout') || e.includes('agent_timeout')) {
    return 'התשובה לקחה יותר מדי זמן — נסו שאלה קצרה יותר או שוב בעוד רגע.';
  }
  if (e.includes('no_api_key')) {
    return 'שירות ה-AI עדיין לא מחובר — בינתיים העובד עונה במצב הדגמה.';
  }
  return 'משהו נתעכב, נסה שוב';
}
export { llmErrorMessageHe };

export function learnFromCorrection(tenantId, workerId, { original = '', corrected = '', userMessage = '' } = {}) {
  const worker = getWorker(tenantId, workerId);
  if (!worker) return { ok: false, error: 'not_found' };
  const correctedTrim = String(corrected).trim();
  if (!correctedTrim) return { ok: false, error: 'corrected_required' };
  const stamp = new Date().toLocaleDateString('he-IL');
  const snippet = `\n\n--- למידה מתיקון (${stamp}) ---\nשאלת לקוח: ${String(userMessage).slice(0, 200)}\nתשובה מומלצת: ${correctedTrim}`;
  const knowledge = (worker.knowledge + snippet).slice(0, 50000);
  updateWorker(tenantId, workerId, { knowledge });
  return { ok: true, snippetLength: snippet.length };
}

function computeQualityScore({ reply = '', runtime = '', error = null, toolCalls = [], timedOut = false }) {
  if (error || timedOut) return { level: 'low', labelHe: 'ביטחון: נמוך' };
  if (runtime === 'mock' || runtime === 'mock_fallback' || runtime === 'mock_agent') {
    return { level: 'medium', labelHe: 'ביטחון: בינוני' };
  }
  const len = String(reply).length;
  const hasTools = toolCalls.length > 0;
  const uncertain = /לא בטוח|לא יודע|אינני יכול|אעביר לנציג|escalat/i.test(reply);
  if (uncertain) return { level: 'low', labelHe: 'ביטחון: נמוך' };
  if (hasTools && len > 40) return { level: 'high', labelHe: 'ביטחון: גבוה' };
  if (len > 80) return { level: 'high', labelHe: 'ביטחון: גבוה' };
  if (len > 25) return { level: 'medium', labelHe: 'ביטחון: בינוני' };
  return { level: 'low', labelHe: 'ביטחון: נמוך' };
}

const FALLBACK_MODELS = {
  'openrouter/free': 'openrouter/free',
  'meta-llama/llama-3.2-3b-instruct:free': 'openrouter/free',
  'gpt-5.5': 'gpt-4o-mini',
  'gpt-4o': 'gpt-4o-mini',
};

function getFallbackModel(model = '') {
  return FALLBACK_MODELS[model] ?? (model.includes('free') ? 'openrouter/free' : null);
}

function isRetryableLlmError(res) {
  if (!res || res.ok) return false;
  const blob = `${res.error || ''} ${res.detail || ''}`.toLowerCase();
  return /429|rate|limit|503|502|timeout|overloaded|too many/.test(blob);
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
  const trialDays = Number(process.env.TRIAL_DAYS ?? 0);
  const initialStatus = trialDays > 0 ? 'active' : 'pending_payment';
  const trialPaidUntil = trialDays > 0 ? new Date(Date.now() + trialDays * 86400000).toISOString() : null;
  db.prepare(`INSERT INTO workers
    (id, name, template_id, persona, tasks_json, knowledge, tools_json, llm_provider, llm_model, llm_base_url, status, paid_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`).run(
    workerId, `${tpl.nameHe || tpl.name} (חדש)`, tpl.id, tpl.defaultPersona,
    JSON.stringify(defaultTasks), starterKnowledgeForTemplate(tpl),
    JSON.stringify(defaultTools), llmProvider, llmModel, initialStatus, trialPaidUntil, now, now
  );
  db.prepare(`INSERT INTO purchases
    (id, worker_id, template_id, kind, amount_ils, payment_channel, payment_reference, paid_until, created_at)
    VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?)`).run(
    newId('pur'), workerId, tpl.id, tpl.buyPriceIls, paymentChannel ?? (trialDays > 0 ? 'trial' : null), paymentReference ?? (trialDays > 0 ? `trial-${trialDays}d` : null), trialPaidUntil, now
  );
  if (trialDays > 0) {
    db.prepare(`INSERT INTO rentals (worker_id, tenant_id, days, amount_ils, payment_channel, payment_reference, paid_until, created_at)
      VALUES (?, ?, ?, 0, 'trial', ?, ?, ?)`).run(workerId, tenantId, trialDays, `trial-${trialDays}d`, trialPaidUntil, now);
  }
  return { ok: true, workerId, template: tpl, trialDays: trialDays > 0 ? trialDays : undefined, isActive: trialDays > 0 };
}

export function listWorkers(tenantId) {
  const db = getTenantDb(tenantId);
  const rows = db.prepare(`SELECT id, name, template_id AS templateId, status, paid_until AS paidUntil, created_at AS createdAt, updated_at AS updatedAt FROM workers ORDER BY created_at DESC`).all();
  return rows.map((r) => {
    const worker = {
      ...r,
      template: getTemplate(r.templateId),
      isActive: r.status === 'active' && (!r.paidUntil || new Date(r.paidUntil) > new Date()),
      llm: { hasApiKey: !!getServerLlmConfig().apiKey },
    };
    return { ...worker, health: getWorkerHealth(worker) };
  });
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
    agentMode: r.agent_mode === 'chat' ? 'chat' : 'agent',
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
  if (patch.agentMode !== undefined) { fields.push('agent_mode = ?'); values.push(patch.agentMode === 'chat' ? 'chat' : 'agent'); }
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
  db.prepare(`DELETE FROM customer_profiles WHERE worker_id = ?`).run(workerId);
  db.prepare(`DELETE FROM schedule_callbacks WHERE worker_id = ?`).run(workerId);
  db.prepare(`DELETE FROM followup_triggers WHERE worker_id = ?`).run(workerId);
  db.prepare(`DELETE FROM crm_notes WHERE worker_id = ?`).run(workerId);
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

export function adminFindWorker(workerId) {
  if (!workerId) return null;
  for (const row of adminListAllWorkers()) {
    if (row.id === workerId) return row;
  }
  return null;
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
    'clinic-receptionist-he': '\n\nTEMPLATE RULES (clinic): Use get_appointment_slots for scheduling. Triage urgency: chest pain, bleeding, severe pain -> escalate_to_human priority high + recommend ER. NEVER give medical advice — only administrative info. Always include disclaimer: "אני מזכיר/ה שאינני נותן/ת ייעוץ רפואי."',
    'sales-leads-il': '\n\nTEMPLATE RULES (sales): Qualify with BANT. Use save_lead with score 1-10. Hot leads (score>=7): book_meeting_link. Use export_leads_csv when asked for lead export.',
    'support-he': '\n\nTEMPLATE RULES (support): ALWAYS search_knowledge first. If confidence < 0.55 OR refund/legal/hostile -> escalate_to_human priority high. Cite KB chunks in reply as [מקור 1], [מקור 2]. End with confidence statement.',
    'restaurant-manager-he': '\n\nTEMPLATE RULES (restaurant): Use check_business_hours before confirming reservations. Capture party size and dietary needs. Use generate_image for dish/special promo visuals.',
    'social-media-creator-he': '\n\nTEMPLATE RULES (social): Write Hebrew captions + hashtags. Always generate_image for feed posts. Use 9:16 for Stories, 1:1 for Instagram feed, 16:9 for LinkedIn.',
    'real-estate-il': '\n\nTEMPLATE RULES (real estate): Use generate_image only as stylized marketing art — never present AI images as actual property photos.',
    'content-he': '\n\nTEMPLATE RULES (content): For blog drafts, call generate_image for a 16:9 header illustration.',
  };
  return hints[templateId] ?? '';
}

function buildSystemPrompt(worker, memories = [], extraToolDefs = [], convSummaries = [], customerProfile = null) {
  const tasks = (worker.tasks ?? []).map((t, i) => `${i + 1}. ${t}`).join('\n');
  const agentMode = worker.agentMode !== 'chat';
  const allToolNames = agentMode
    ? [...new Set([...(worker.tools ?? []).map(resolveToolName), ...extraToolDefs.map((t) => t.name)])]
    : [];
  const toolDesc = allToolNames.length
    ? '\n\nAVAILABLE TOOLS (invoke these to take real actions — plan → act → observe → respond):\n' +
      allToolNames.map((tn) => {
        const td = TOOL_DEFS.find((d) => d.name === tn) || extraToolDefs.find((d) => d.name === tn);
        if (!td) return '';
        const params = Object.entries(td.parameters.properties || {}).map(([k, v]) => `  - ${k} (${v.type}): ${v.description}`).join('\n');
        return `- ${td.name}: ${td.description}\n${params}`;
      }).filter(Boolean).join('\n') +
      '\n\nAGENT LOOP: You may call multiple tools across up to 5 steps. After each tool result, decide if another action is needed before your final reply.'
    : '\n\nMODE: Chat-only — respond conversationally without invoking tools.';
  const memStr = memories.length
    ? '\n\nCUSTOMER FACTS (remembered about this customer):\n' + memories.map((m) => `- ${m.key}: ${m.value}`).join('\n')
    : '';
  const profStr = customerProfile
    ? `\n\nCUSTOMER PROFILE:\n- name: ${customerProfile.name || '(unknown)'}\n- phone: ${customerProfile.phone || '(unknown)'}\n- last intent: ${customerProfile.lastIntent || '(none)'}\n- preferences: ${JSON.stringify(customerProfile.preferences || {})}`
    : '';
  const sumStr = convSummaries.length
    ? '\n\nPREVIOUS CONVERSATIONS (summaries with this customer):\n' + convSummaries.map((s) => `- [${s.createdAt?.slice(0, 10) ?? ''}] ${s.summary}`).join('\n')
    : '';
  const tplHint = templateRuntimeHint(worker.templateId);
  return `${worker.persona}

YOUR TASKS (follow these in order):
${tasks || '(no specific tasks set; respond helpfully based on your persona)'}

KNOWLEDGE BASE (treat as ground truth):
${worker.knowledge || '(none provided)'}${memStr}${profStr}${sumStr}${toolDesc}${tplHint}

RULES:
- Stay in character at all times
- Never reveal you are an AI or language model unless directly asked
- Reply in the language the user writes in (default to Hebrew if worker persona says so)
- Keep replies concise: aim for under 200 words unless more is genuinely needed`.trim();
}

function polishDemoReply(reply, worker, { isFirst = false } = {}) {
  let clean = String(reply || '')
    .replace(/^\([^)]+\)\s*\n+/i, '')
    .replace(/\n\n\(This is a demo reply[^\)]*\)\.?/gi, '')
    .replace(/\n\n\(Contact the platform admin[^\)]*\)\.?/gi, '')
    .replace(/\n\n\(Demo mode[^\)]*\)\.?/gi, '')
    .trim();
  if (!isFirst) return clean || reply;
  const name = String(worker.name || '').trim();
  const parts = name.split(' — ');
  const biz = parts.length > 1 ? parts[parts.length - 1].trim() : name || 'העסק';
  const role = parts.length > 1 ? parts.slice(0, -1).join(' — ').trim() : 'העובד/ת שלכם';
  const header = `שלום! אני ${role} של ${biz}. זו תשובה לדוגמה — עדיין לא מחובר/ה לוואטסאפ.\n\n`;
  return header + (clean || reply);
}

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

export function publicTemplateDemoChat({ templateId, userMessage, businessName = '' }) {
  const tpl = getTemplate(templateId);
  if (!tpl) return { ok: false, error: 'unknown_template' };
  const fakeWorker = {
    name: businessName || tpl.nameHe || tpl.name,
    templateId,
    persona: tpl.defaultPersona,
    tasks: tpl.defaultTasks ?? [],
    knowledge: tpl.defaultKnowledge ?? '',
  };
  const raw = mockReply(fakeWorker, [], userMessage);
  const reply = raw
    .replace(/^\([^)]+\)\s*\n+/i, '')
    .replace(/\n\n\(This is a demo reply[^\)]*\)\.?/gi, '')
    .replace(/\n\n\(Contact the platform admin[^\)]*\)\.?/gi, '')
    .trim();
  return { ok: true, reply, runtime: 'demo' };
}

function extractPhone(msg) {
  const m = String(msg).match(/(?:0\d{1,2}[-.\s]?\d{3}[-.\s]?\d{4}|05\d[-.\s]?\d{7})/);
  return m?.[0]?.replace(/\s/g, '') ?? '';
}

function extractName(msg) {
  const m = String(msg).match(/(?:שמי|שם[:\s]+|my name is)\s*([א-תA-Za-z\s]{2,40})/i);
  return m?.[1]?.trim() ?? '';
}

async function runMockAgentLoop({ worker, userMessage, toolCtx, enabledToolNames, allToolDefs, agentSteps }) {
  const toolCallsLog = [];
  const can = (name) => enabledToolNames.includes(name) && allToolDefs.has(name);

  const runTool = async (name, args, phase = 'act') => {
    if (toolCallsLog.length >= MAX_AGENT_STEPS) return null;
    const td = allToolDefs.get(name);
    if (!td) return null;
    agentSteps.push({ step: agentSteps.length + 1, phase: 'plan', thought: `Running ${name}` });
    const res = await td.handler(args, toolCtx);
    const resultStr = typeof res.result === 'string' ? res.result : JSON.stringify(res);
    toolCallsLog.push({ name, args, result: resultStr, meta: res });
    agentSteps.push({ step: agentSteps.length + 1, phase, tool: name, args, result: resultStr.slice(0, 400) });
    return res;
  };

  agentSteps.push({ step: 1, phase: 'plan', thought: 'מנתח את הודעת הלקוח ומזהה פעולות אפשריות' });

  const msg = userMessage;
  const low = msg.toLowerCase();

  if ((/תור|appointment|פגישה|ביקור/i.test(msg)) && can('get_appointment_slots')) {
    await runTool('get_appointment_slots', { daysAhead: 3 });
  }
  if ((/חזור|callback|התקשר|להתקשר/i.test(msg)) && can('schedule_callback')) {
    const phone = extractPhone(msg) || toolCtx.customerProfile?.phone || 'unknown';
    await runTool('schedule_callback', { phone, preferredTime: 'בהקדם', notes: msg.slice(0, 200) });
  }
  if ((/מנהל|אדם|נציג|human|החזר|refund|משפטי|legal|כועס|angry/i.test(msg)) && can('escalate_to_human')) {
    const priority = /דחוף|urgent|כועס|החזר|refund/i.test(msg) ? 'high' : 'normal';
    await runTool('escalate_to_human', { reason: msg.slice(0, 300), priority, urgency: priority });
  }
  if (can('search_knowledge') && msg.length > 8 && !/^(שלום|היי|hello|hi)\b/i.test(msg.trim())) {
    const kbRes = await runTool('search_knowledge', { query: msg.slice(0, 120), maxChunks: 3 });
    if (worker.templateId === 'support-he' && kbRes?.confidence != null && kbRes.confidence < 0.55 && can('escalate_to_human')) {
      await runTool('escalate_to_human', { reason: 'Low KB confidence — auto-escalation', priority: 'normal', urgency: 'normal' });
    }
  }
  if ((/שם|טלפון|phone|ליד|lead|חברה|company/i.test(msg)) && can('save_lead')) {
    const fullName = extractName(msg) || 'לקוח חדש';
    const phone = extractPhone(msg);
    const notes = msg.slice(0, 300);
    await runTool('save_lead', { fullName, phone, notes, score: scoreLeadFromNotes(notes) });
  }
  if ((/פגישה|meeting|book|יומן/i.test(msg)) && can('book_meeting_link')) {
    await runTool('book_meeting_link', { leadName: extractName(msg), preferredWindow: msg.slice(0, 100) });
  }
  if (can('flag_needs_followup') && /מחר|מאוחר|follow.?up|לחזור/i.test(msg)) {
    await runTool('flag_needs_followup', { reason: 'Customer requested follow-up', priority: 'normal' });
  }
  if (can('create_crm_note') && toolCallsLog.length > 0) {
    await runTool('create_crm_note', {
      subject: 'Agent session summary',
      body: `Customer said: ${msg.slice(0, 200)}. Tools used: ${toolCallsLog.map((t) => t.name).join(', ')}`,
      tags: ['auto-mock'],
    });
  }
  if ((/תמונה|image|פוסט|ויזואל|visual|אינסטגרם|instagram/i.test(msg)) && can('generate_image')) {
    await runTool('generate_image', {
      prompt: `Professional brand visual for: ${msg.slice(0, 200)}`,
      aspectRatio: /לינקדאין|linkedin|בלוג|blog/i.test(msg) ? '16:9' : '1:1',
      purpose: 'social_post',
    });
  }

  agentSteps.push({ step: agentSteps.length + 1, phase: 'respond', thought: 'מכין תשובה ללקוח על בסיס הפעולות שבוצעו' });
  return { toolCallsLog, actionsTaken: toolCallsLog.length };
}

function mockReplyWithAgent(worker, userMessage, toolCallsLog = [], agentSteps = []) {
  const base = mockReply(worker, [], userMessage);
  if (!toolCallsLog.length) return base;
  const actions = toolCallsLog.map((t) => `• ${t.name}: ${(t.result ?? '').slice(0, 120)}`).join('\n');
  const trace = agentSteps.filter((s) => s.tool).map((s) => `[שלב ${s.step}] ${s.tool}`).join(' → ');
  return `${base}\n\n--- פעולות סוכן (הדגמה) ---\n${actions}\n\nמסלול: ${trace}\n\n(חבר LLM_API_KEY להפעלת לולאת סוכן מלאה עם AI)`;
}

// --- Real LLM runtime ----------------------------------------------------

async function callLLMOnce(worker, systemPrompt, messages, toolDefs = [], apiKey = '') {
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

async function callLLM(worker, systemPrompt, messages, toolDefs = [], apiKey = '') {
  let res = await callLLMOnce(worker, systemPrompt, messages, toolDefs, apiKey);
  if (!res.ok && isRetryableLlmError(res)) {
    const fallback = getFallbackModel(worker.llm.model || '');
    if (fallback && fallback !== worker.llm.model) {
      const fallbackWorker = { ...worker, llm: { ...worker.llm, model: fallback } };
      const shortPrompt = `${systemPrompt}\n\nIMPORTANT: Reply in Hebrew, under 80 words, no tools.`;
      const shortHistory = messages.slice(-6);
      const retry = await callLLMOnce(fallbackWorker, shortPrompt, shortHistory, [], apiKey);
      if (retry.ok) return { ...retry, retried: true, fallbackModel: fallback };
      res = retry;
    }
  }
  return res;
}

const PROVIDER_DEFAULT_MODELS = {
  anthropic: 'claude-opus-4.8',
  groq: 'llama-4-8b-instant',
};
function defaultModelFor(provider) {
  return PROVIDER_DEFAULT_MODELS[provider] ?? getServerLlmConfig().model;
}

export async function chatWithWorker({ tenantId, workerId, userMessage, customerId = '', testMode = false, demoMode = false }) {
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

  // Active + paid check (demoMode lets owner try before paying for production)
  const isPaid = worker.paidUntil && new Date(worker.paidUntil) > new Date();
  const isProductionReady = worker.status === 'active' && isPaid;
  if (!testMode && !demoMode && !isProductionReady) {
    return {
      ok: false, status: 402,
      error: 'payment_required',
      message: 'להפעיל את העובד ללקוחות — שלחו בקשת הפעלה מהמסך הייעודי.',
      paidUntil: worker.paidUntil ?? null,
    };
  }

  if (!testMode) appendMessage(tenantId, workerId, 'user', userMessage);
  const history = testMode
    ? []
    : db.prepare(`SELECT role, content FROM messages WHERE worker_id = ? ORDER BY id ASC LIMIT ${CHAT_HISTORY_LIMIT}`).all(workerId);
  const isFirstDemoReply = demoMode && !history.some((m) => m.role === 'assistant');
  const memories = getCustomerMemories(tenantId, workerId, customerId);
  const convSummaries = customerId ? getConversationSummaries(tenantId, workerId, customerId) : [];

  // --- MCP tool discovery ---
  let mcpToolDefs = [];
  const mcpErrors = [];
  const integrationMcp = getIntegrationsByType(tenantId, 'mcp').map((row) => ({
    name: row.config?.name || row.label,
    url: row.config?.url,
    headers: row.config?.authHeader ? { authorization: row.config.authHeader } : {},
  }));
  const allMcpServers = [...(worker.mcpServers ?? []), ...integrationMcp.filter((s) => s.url)];
  for (const mcpSrv of allMcpServers) {
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

  const agentMode = worker.agentMode !== 'chat';
  const integrationToolNames = getAutoToolNamesForTenant(tenantId);
  const enabledToolNames = agentMode ? [...new Set(
    [...(worker.tools ?? []), ...integrationToolNames].map(resolveToolName).filter((t) => allToolDefs.has(t))
  )] : [];
  if (agentMode) {
    for (const td of mcpToolDefs) {
      if (!enabledToolNames.includes(td.name)) enabledToolNames.push(td.name);
    }
  }

  const customerProfile = customerId ? getCustomerProfile(tenantId, workerId, customerId) : null;
  const allToolDefsArray = agentMode ? enabledToolNames.map((n) => allToolDefs.get(n)).filter(Boolean) : [];
  const systemPrompt = buildSystemPrompt(worker, memories, mcpToolDefs, convSummaries, customerProfile);

  let reply = '';
  let runtime = 'mock';
  let error = null;
  const toolCallsLog = [];
  const agentSteps = [];

  const chatHistory = history.map((m) => ({ role: m.role, content: m.content }));
  const toolCtx = { tenantId, workerId, customerId, workerName: worker.name, workerKnowledge: worker.knowledge, customerProfile };

  const loopStarted = Date.now();
  let finalReply = '';
  let timedOut = false;

  const runAgentStep = async (loopIndex, phase) => {
    agentSteps.push({ step: loopIndex + 1, phase, thought: phase === 'plan' ? 'LLM planning next action' : undefined });
  };

  if (srvCfg.apiKey && agentMode && enabledToolNames.length > 0) {
    for (let loop = 0; loop < MAX_AGENT_STEPS; loop++) {
      if (Date.now() - loopStarted > AGENT_LOOP_TIMEOUT_MS) {
        timedOut = true;
        error = 'agent_timeout';
        break;
      }
      await runAgentStep(loop, 'plan');
      const llmRes = await callLLM(worker, systemPrompt, chatHistory, allToolDefsArray, srvCfg.apiKey);
      if (!llmRes.ok) {
        error = llmRes.error;
        finalReply = mockReplyWithAgent(worker, userMessage, toolCallsLog, agentSteps);
        runtime = 'mock_fallback';
        if (isRetryableLlmError(llmRes)) error = llmRes.error;
        break;
      }
      runtime = worker.llm.provider;
      finalReply = llmRes.text;

      if (!llmRes.toolCalls || llmRes.toolCalls.length === 0) {
        agentSteps.push({ step: agentSteps.length + 1, phase: 'respond', thought: 'Final reply ready' });
        break;
      }

      const assistantMsg = { role: 'assistant', content: llmRes.text, toolCalls: llmRes.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })) };
      chatHistory.push(assistantMsg);

      for (const tc of llmRes.toolCalls) {
        if (Date.now() - loopStarted > AGENT_LOOP_TIMEOUT_MS) { timedOut = true; error = 'agent_timeout'; break; }
        const td = allToolDefs.get(tc.name);
        if (!td || !enabledToolNames.includes(tc.name)) {
          chatHistory.push({ role: 'tool', toolCallId: tc.id, content: `Error: tool "${tc.name}" not enabled` });
          toolCallsLog.push({ name: tc.name, args: tc.args, result: 'tool not enabled' });
          continue;
        }
        try {
          const res = await td.handler(tc.args ?? {}, toolCtx);
          const resultStr = typeof res.result === 'string' ? res.result : JSON.stringify(res);
          chatHistory.push({ role: 'tool', toolCallId: tc.id, content: resultStr });
          toolCallsLog.push({ name: tc.name, args: tc.args, result: resultStr });
          agentSteps.push({ step: agentSteps.length + 1, phase: 'observe', tool: tc.name, result: resultStr.slice(0, 400) });
        } catch (e) {
          const errMsg = `Error executing ${tc.name}: ${e?.message ?? e}`;
          chatHistory.push({ role: 'tool', toolCallId: tc.id, content: errMsg });
          toolCallsLog.push({ name: tc.name, args: tc.args, result: errMsg });
        }
      }
      if (timedOut) break;
    }
    reply = finalReply;
  } else if (srvCfg.apiKey) {
    const llmRes = await callLLM(worker, systemPrompt, chatHistory, [], srvCfg.apiKey);
    if (!llmRes.ok) {
      error = llmRes.error;
      reply = mockReply(worker, chatHistory, userMessage);
      runtime = 'mock_fallback';
    } else {
      runtime = worker.llm.provider;
      reply = llmRes.text;
    }
  } else if (agentMode && enabledToolNames.length > 0) {
    const mockRun = await runMockAgentLoop({ worker, userMessage, toolCtx, enabledToolNames, allToolDefs, agentSteps });
    toolCallsLog.push(...mockRun.toolCallsLog);
    reply = mockReplyWithAgent(worker, userMessage, toolCallsLog, agentSteps);
    runtime = 'mock_agent';
  } else {
    reply = mockReply(worker, chatHistory, userMessage);
  }

  if (demoMode && reply) {
    reply = polishDemoReply(reply, worker, { isFirst: isFirstDemoReply });
  }

  if (!testMode && customerId) {
    upsertCustomerProfile(tenantId, workerId, customerId, { lastIntent: userMessage.slice(0, 120) });
  }

  if (!testMode) appendMessage(tenantId, workerId, 'assistant', reply);
  if (!testMode && toolCallsLog.length > 0) {
    logAgentActions(tenantId, workerId, customerId, toolCallsLog);
  }
  if (!testMode && customerId && history.length >= 2) {
    const snippet = history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 100)}`).join(' | ');
    saveConversationSummary(tenantId, workerId, customerId, `Last exchange: ${snippet}`.slice(0, 500));
    if (agentMode && toolCallsLog.length > 0) {
      const fuReason = `Post-chat follow-up: tools used (${toolCallsLog.map((t) => t.name).join(', ')})`;
      const db2 = getTenantDb(tenantId);
      db2.prepare(`INSERT INTO followup_triggers (id, worker_id, customer_id, reason, priority, status, scheduled_for, created_at)
        VALUES (?, ?, ?, ?, 'normal', 'open', NULL, ?)`).run(newId('fu'), workerId, customerId, fuReason, new Date().toISOString());
    }
  }
  const qualityScore = computeQualityScore({ reply, runtime, error, toolCalls: toolCallsLog, timedOut });
  const userMessageHe = error ? llmErrorMessageHe(error) : undefined;
  return {
    ok: true, status: 200, reply, runtime, error, timedOut,
    userMessageHe,
    qualityScore,
    mcpErrors: mcpErrors.length ? mcpErrors : undefined,
    workerId, workerName: worker.name, customerId,
    agentMode: worker.agentMode,
    toolCalls: toolCallsLog,
    agentSteps,
    stepsUsed: agentSteps.length,
  };
}

/** Stream reply tokens via callback (SSE-friendly). Falls back to single chunk. */
export async function streamChatWithWorker(params, onEvent) {
  const result = await chatWithWorker(params);
  if (!result.ok) {
    onEvent('error', { error: result.error, message: result.message || result.userMessageHe || llmErrorMessageHe(result.error) });
    return result;
  }
  const text = result.reply || '';
  const chunkSize = Math.max(4, Math.min(12, Math.ceil(text.length / 24)));
  for (let i = 0; i < text.length; i += chunkSize) {
    onEvent('token', { text: text.slice(i, i + chunkSize) });
  }
  onEvent('done', {
    runtime: result.runtime,
    qualityScore: result.qualityScore,
    toolCalls: result.toolCalls,
    stepsUsed: result.stepsUsed,
  });
  return result;
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

registerMediaTools(TOOL_DEFS, { getTenantDb, ensureTenantDir, newId });
initIntegrationStore({ getTenantDb, newId });
registerIntegrationTools(TOOL_DEFS, { validatePublicHttpUrl, pinnedLookup });

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
