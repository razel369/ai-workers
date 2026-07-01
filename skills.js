import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __skillsDir = path.dirname(fileURLToPath(import.meta.url));
const LEGAL_DIR = path.join(__skillsDir, 'docs', 'legal');

export const SKILLS = [
  {
    id: 'web-research',
    name: 'Web Research',
    nameHe: 'מחקר אינטרנט',
    description: 'Search the web, fetch pages, and summarize content in real-time. Ideal for researchers, journalists, and competitive intelligence.',
    icon: '🔍',
    category: 'research',
    mcpServers: [],
    addTools: ['search_knowledge', 'remember_fact'],
    addKnowledge: `SKILL: Web Research
You can research topics by asking the user for information or using available search tools.
When researching:
1. Ask clarifying questions before searching
2. Cite sources when providing information
3. Summarize findings concisely
4. Offer to dig deeper on any point`,
    persona: '',
  },
  {
    id: 'crm-leads',
    name: 'CRM & Lead Management',
    nameHe: 'ניהול לידים ו-CRM',
    description: 'Capture, qualify, and manage leads with automated follow-ups. Tracks every interaction for full sales visibility.',
    icon: '📊',
    category: 'sales',
    mcpServers: [],
    addTools: ['save_lead', 'remember_fact', 'recall_facts', 'send_email'],
    addKnowledge: `SKILL: CRM & Lead Management
You manage the full lead lifecycle:
1. Capture lead details (name, company, phone, email, needs)
2. Qualify leads based on BANT criteria
3. Set follow-up reminders and tasks
4. Track all lead interactions in the memory system
5. Send follow-up emails when appropriate`,
    persona: '',
  },
  {
    id: 'email-campaigns',
    name: 'Email Campaigns',
    nameHe: 'קמפיינים במייל',
    description: 'Draft, send, and track email campaigns. Supports templates, personalization, and follow-up sequences.',
    icon: '📧',
    category: 'marketing',
    mcpServers: [],
    addTools: ['send_email', 'save_lead'],
    addKnowledge: `SKILL: Email Campaigns
You can draft and send emails for the business:
1. Confirm recipient, subject, and purpose before sending
2. Use professional language matching the brand voice
3. Track all sent emails in the outbox
4. Offer A/B subject line variants
5. Schedule follow-ups when appropriate`,
    persona: '',
  },
  {
    id: 'calendar-scheduling',
    name: 'Calendar & Scheduling',
    nameHe: 'יומן ותיאום פגישות',
    description: 'Check availability, book appointments, and manage schedules. Perfect for receptionists and sales teams.',
    icon: '📅',
    category: 'productivity',
    mcpServers: [],
    addTools: ['get_current_time', 'remember_fact', 'save_lead'],
    addKnowledge: `SKILL: Calendar & Scheduling
You manage appointments and scheduling:
1. Ask for preferred date, time, and duration
2. Confirm timezone (default: Israel, Asia/Jerusalem)
3. Collect contact details for confirmation
4. Offer 2-3 alternative time slots
5. Confirm the booking details before finalizing`,
    persona: '',
  },
  {
    id: 'social-media',
    name: 'Social Media Content',
    nameHe: 'תוכן לרשתות חברתיות',
    description: 'Generate posts for LinkedIn, Facebook, Instagram, and Twitter. Adapts tone per platform and brand voice.',
    icon: '📱',
    category: 'marketing',
    mcpServers: [],
    addTools: ['remember_fact'],
    addKnowledge: `SKILL: Social Media Content
You write social media posts adapted to each platform:
1. Ask: platform, topic, audience, tone, CTA
2. LinkedIn: professional, insight-driven, 200-300 words
3. Facebook: conversational, engaging, 100-200 words
4. Instagram: visual-first, short, with hashtags (5-10)
5. Twitter/X: concise, punchy, under 280 chars
6. Always offer 2-3 headline variants
7. Avoid anglicisms — use natural Hebrew`,
    persona: '',
  },
  {
    id: 'data-analysis',
    name: 'Data Analysis & Reports',
    nameHe: 'ניתוח נתונים ודוחות',
    description: 'Process structured data, generate insights, and produce formatted reports. Great for operations and finance teams.',
    icon: '📈',
    category: 'ops',
    mcpServers: [],
    addTools: ['remember_fact', 'send_email'],
    addKnowledge: `SKILL: Data Analysis & Reports
You analyze data and produce insights:
1. Ask for the data format (CSV, table, description)
2. Identify key metrics and trends
3. Provide clear summaries with actionable insights
4. Offer to format as a report or email
5. Use bullet points and sections for clarity`,
    persona: '',
  },
  {
    id: 'hebrew-content',
    name: 'Hebrew Content Writing',
    nameHe: 'כתיבה שיווקית בעברית',
    description: 'Write blog posts, landing pages, ads, and newsletters in natural, fluent Hebrew. Brand-voice aware.',
    icon: '✍️',
    category: 'content',
    mcpServers: [],
    addTools: ['remember_fact'],
    addKnowledge: `SKILL: Hebrew Content Writing
You write marketing content in natural Hebrew:
1. Ask: format (blog/landing/ad/email), topic, audience, key message, desired length, CTA
2. Write in clear, modern Hebrew — minimal anglicisms
3. Match the brand voice from knowledge base
4. Always end with 3 alternative headlines
5. Offer revisions and 2 more variants after feedback`,
    persona: '',
  },
  {
    id: 'customer-support-pro',
    name: 'Advanced Customer Support',
    nameHe: 'תמיכת לקוחות מתקדמת',
    description: 'Handle complex support tickets with escalation management, satisfaction surveys, and follow-up automation.',
    icon: '🎧',
    category: 'support',
    mcpServers: [],
    addTools: ['search_knowledge', 'escalate_to_human', 'remember_fact', 'recall_facts'],
    addKnowledge: `SKILL: Advanced Customer Support
You provide professional customer support:
1. Acknowledge the issue and show empathy
2. Search the knowledge base for answers
3. If unresolved, create an escalation with full context
4. Remember customer preferences and history
5. Follow up within the promised timeframe
6. Always end with "Is there anything else I can help with?"`,
    persona: '',
  },
];

export function getSkill(id) {
  return SKILLS.find((s) => s.id === id) ?? null;
}

export function getSkillsByCategory(category) {
  return category ? SKILLS.filter((s) => s.category === category) : SKILLS;
}

export function skillCategories() {
  return [...new Set(SKILLS.map((s) => s.category))];
}

// --- Hebrew legal pages (/privacy, /terms) ---------------------------------

const LEGAL_PAGES = {
  '/privacy': { file: 'privacy-he.md', title: 'מדיניות פרטיות' },
  '/terms': { file: 'terms-he.md', title: 'תנאי שימוש' },
};

const LEGAL_FALLBACK = {
  'privacy-he.md': `# מדיניות פרטיות

**עודכן לאחרונה:** יולי 2026

## 1. מי אנחנו

פלטפורמת AI Workers מספקת עובדי בינה מלאכותית לעסקים בישראל — צ'אט באתר, לידים, והסלמות לבעל העסק. אנו מעבדים מידע אישי רק כדי להפעיל את השירות שביקשתם.

## 2. אילו נתונים נאספים

- **פרטי חשבון:** אימייל, שם עסק, מפתח API (מוצפן), היסטוריית תשלומים ואישורי הפעלה.
- **שיחות עובדים:** הודעות לקוחות עם העובד הווירטואלי, זיכרונות שהעובד שומר, לידים ופניות הסלמה.
- **טכני:** כתובת IP (למניעת שימוש לרעה), לוגי שרת, מזהי סשן.

## 3. מטרות עיבוד

- הפעלת עובדים, תמיכה בלקוחותיכם, וחיוב מנוי חודשי.
- אבטחה, מניעת הונאה, ועמידה בדרישות חוק.
- שיפור המוצר (באגרגציה אנונימית בלבד).

## 4. שיתוף עם צדדים שלישיים

אנו משתמשים בספקי LLM (למשל OpenAI/Anthropic) לעיבוד שיחות — לפי מדיניות הפרטיות שלהם. תשלומים מתבצעים ישירות ביניכם לבין PayPal, Bit או העברה בנקאית; איננו שומרים פרטי כרטיס אשראי.

## 5. אחסון ואבטחה

נתונים נשמרים בשרת מאובטח (SQLite ותיקיות דיירים על ווליום קבוע ב-Railway). גישת אדמין מוגנת ב-\`ADMIN_TOKEN\`. מומלץ לסובב מפתחות API לאחר חשיפה.

## 6. זכויותיכם

לפי חוק הגנת הפרטיות, תוכלו לבקש גישה, תיקון או מחיקת נתונים — פנו לכתובת התמיכה שמופיעה בחשבונית (\`AGENT_OWNER_CONTACT\`).

## 7. עוגיות

האתר משתמש בעוגיות הכרחיות לסשן ולממשק המרקטפלייס בלבד. אין מעקב פרסומי מצדנו.

## 8. שינויים

נעדכן מדיניות זו בעת שינוי מהותי בשירות. המשך שימוש לאחר עדכון מהווה הסכמה.

## 9. יצירת קשר

שאלות בנושא פרטיות: ראו את פרטי הקשר בדף \`/invoice\` או במייל התמיכה של הפלטפורמה.`,
  'terms-he.md': `# תנאי שימוש

**עודכן לאחרונה:** יולי 2026

## 1. קבלת התנאים

בשימוש בפלטפורמת AI Workers ("השירות") אתם מסכימים לתנאים אלה. אם אינכם מסכימים — אל תשתמשו בשירות.

## 2. השירות

השירות מאפשר ליצור, להתאים ולהפעיל "עובדי AI" לעסקים: צ'אט באתר, איסוף לידים, כלים מובנים, והסלמה לבעל העסק. WhatsApp וערוצים נוספים עשויים להתווסף בהמשך.

## 3. חשבון ואבטחה

- אתם אחראים לשמירה על מפתח ה-API שלכם.
- אסור לשתף מפתח עם צד שלישי לא מורשה.
- אנו רשאים להשעות חשבון במקרה של שימוש לרעה או הפרת חוק.

## 4. תשלום והפעלה

- רכישת תבנית או מנוי חודשי מתבצעת דרך ערוצי התשלום שמוגדרים בפלטפורמה (PayPal, Bit, העברה בנקאית).
- הפעלת עובד דורשת אישור תשלום ידני על ידי מנהל הפלטפורמה עד להפעלת סליקה אוטומטית.
- מחירים מוצגים בשקלים (₪) אלא אם צוין אחרת.

## 5. תוכן ואחריות

- אתם אחראים לתוכן שהעובד מציג ללקוחותיכם ולעמידה בחוקי ישראל (פרסום, הגנת צרכן, פרטיות).
- תשובות AI עלולות להיות שגויות — מומלץ לבדוק הגדרות persona וידע לפני הפעלה.
- השירות מסופק "כמות שהוא" (AS IS) ללא אחריות לרווחים או לנזקים עקיפים.

## 6. קניין רוחני

תבניות, קוד וממשק שייכים למפעיל הפלטפורמה. תוכן שאתם מזינים (טקסטים, ידע עסקי) נשאר בבעלותכם; אתם מעניקים לנו רישיון להפעילו לצורך השירות בלבד.

## 7. הגבלת אחריות

אחריותנו המצטברת מוגבלת לסכום ששילמתם ב-12 החודשים האחרונים עבור השירות, במידה המרבית המותרת בחוק.

## 8. ביטול

ניתן להפסיק שימוש בכל עת. מנויים פעילים אינם מוחזרים באופן יחסי אלא אם נדרש בחוק. נתונים עשויים להימחק לאחר תקופת שמירה סבירה.

## 9. שינויים

נוכל לעדכן תנאים אלה; נפרסם גרסה מעודכנת בכתובת \`/terms\`. שימוש מתמשך לאחר עדכון מהווה הסכמה.

## 10. דין וסמכות שיפוט

הדין החל הוא דין מדינת ישראל. סמכות שיפוט בבתי המשפט המוסמכים בישראל.

## 11. יצירת קשר

לשאלות משפטיות או חיוב: פנו לכתובת התמיכה בחשבונית או ב-\`AGENT_OWNER_CONTACT\`.`,
};

const legalCache = new Map();

function loadLegalMarkdown(filename) {
  if (!legalCache.has(filename)) {
    const filePath = path.join(LEGAL_DIR, filename);
    try {
      legalCache.set(filename, fs.readFileSync(filePath, 'utf8'));
    } catch {
      legalCache.set(filename, LEGAL_FALLBACK[filename]);
    }
  }
  return legalCache.get(filename);
}

function escapeLegalHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function legalMarkdownToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    if (line.startsWith('# ')) {
      closeList();
      out.push(`<h1>${escapeLegalHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith('## ')) {
      closeList();
      out.push(`<h2>${escapeLegalHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith('- ')) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${legalInlineFormat(line.slice(2))}</li>`);
    } else {
      closeList();
      out.push(`<p>${legalInlineFormat(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

function legalInlineFormat(text) {
  let s = escapeLegalHtml(text);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function wrapLegalPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeLegalHtml(title)} — AI Workers</title>
  <style>
    :root { color-scheme: dark; --bg: #0a0908; --text: #f2ebe2; --muted: #8f857a; --accent: #d4a24a; }
    body { font-family: system-ui, "Segoe UI", Arial, sans-serif; background: var(--bg); color: var(--text);
      line-height: 1.7; max-width: 720px; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    a { color: var(--accent); }
    h1 { font-size: 1.75rem; margin-bottom: .5rem; }
    h2 { font-size: 1.15rem; margin: 1.5rem 0 .5rem; color: var(--text); }
    p, li { color: var(--muted); }
    code { background: #1e1a16; padding: .1em .35em; border-radius: 4px; font-size: .9em; }
    .nav { margin-bottom: 2rem; font-size: .9rem; }
    .nav a { margin-left: 1rem; }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="/">דף הבית</a>
    <a href="/marketplace">מרקטפלייס</a>
    <a href="/privacy">פרטיות</a>
    <a href="/terms">תנאים</a>
  </nav>
  ${bodyHtml}
</body>
</html>`;
}

/** @returns {boolean} true if handled */
export function handleLegalRoutes(req, res, url, send) {
  if (req.method !== 'GET') return false;
  const page = LEGAL_PAGES[url.pathname];
  if (!page) return false;
  try {
    const md = loadLegalMarkdown(page.file);
    send(res, 200, wrapLegalPage(page.title, legalMarkdownToHtml(md)), { 'content-type': 'text/html; charset=utf-8' });
    return true;
  } catch (err) {
    console.error('legal-pages:', err);
    send(res, 500, { error: 'legal_page_unavailable' });
    return true;
  }
}

export const LEGAL_PATHS = Object.keys(LEGAL_PAGES);
