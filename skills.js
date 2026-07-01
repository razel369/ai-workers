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
