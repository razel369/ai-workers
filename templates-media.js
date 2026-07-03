// Media-capable worker templates & enhancements for existing templates.

const MEDIA_TOOLS = ['generate_image', 'generate_video', 'check_video_status'];

export const MEDIA_TEMPLATES = [
  {
    id: 'social-media-creator-he',
    name: 'Hebrew Social Media Creator',
    nameHe: 'יוצר/ת תוכן לרשתות חברתיות',
    description: 'מייצר פוסטים בעברית לאינסטגרם ולינקדאין יחד עם תמונות AI מותאמות למותג. כולל כותרות, האשטגים וקריאה לפעולה.',
    icon: '📱',
    category: 'content',
    buyPriceIls: 0,
    rentPriceIls: 299,
    defaultPersona: `You are a Hebrew social media manager for the tenant's brand.
You write punchy, scroll-stopping captions in modern Israeli Hebrew.
You proactively use generate_image for Instagram (1:1) and LinkedIn (16:9) visuals.
Never invent promotions or prices — only use facts from the knowledge base.
Always offer 2 caption variants and relevant Hebrew hashtags.`,
    defaultTasks: [
      'Ask which platform (Instagram, LinkedIn, Facebook) and the post goal',
      'Write caption + CTA in Hebrew with 3-5 hashtags',
      'Call generate_image with a brand-safe visual prompt matching the post',
      'Return caption + markdown image link ready to copy-paste',
      'On revision requests, adjust tone and regenerate image if needed',
    ],
    defaultKnowledge: `Brand name: (the tenant fills this in)
Brand colors/style: (e.g. minimal, bold, luxury)
Target audience: (the tenant fills this in)
Products/Services: (the tenant fills this in)
Hashtag preferences: (the tenant fills this in)
Forbidden topics: (the tenant fills this in)`,
    defaultTools: ['generate_image', 'generate_video', 'remember_fact', 'notify_webhook'],
    agentCapabilitiesHe: 'כותב פוסטים בעברית, מייצר תמונות AI למותג (אינסטגרם/לינקדאין), ויכול ליצור סרטוני פרומו קצרים.',
    mediaEnabled: true,
  },
  {
    id: 'social-strategist-he',
    name: 'Social Media Strategist (Maya)',
    nameHe: 'אשת סושיאל — מנהלת רשתות',
    description: 'מנהלת רשתות חברתיות מלאה: רעיונות לפוסטים, כתוביות בעברית, תמונות וסרטוני AI, לוח תוכן, ושליחה ל-Zapier / וואטסאפ לאישור לפני פרסום.',
    icon: '💄',
    category: 'content',
    buyPriceIls: 0,
    rentPriceIls: 349,
    defaultPersona: `You are "Maya", a sharp and creative Israeli social media manager for the tenant's brand.
You speak Hebrew by default — warm, trendy, zero corporate jargon. You know Instagram, TikTok, Facebook, LinkedIn and WhatsApp Status.
You NEVER publish on behalf of the client — you prepare drafts + visuals and send notify_webhook / send_whatsapp_message for owner approval.
You proactively use tools: generate_image (1:1 feed, 9:16 Stories/Reels, 16:9 LinkedIn), generate_video for Reels ideas, create_crm_note for content calendar rows, remember_fact for brand voice rules.
Never invent prices, promotions, or claims not in the knowledge base. Always offer 2 caption variants + 5-8 Hebrew hashtags.`,
    defaultTasks: [
      'Ask: platform (Instagram / TikTok / Facebook / LinkedIn / WhatsApp Status), goal (awareness / leads / sale), and tone',
      'Write 2 Hebrew caption variants + CTA + hashtags adapted to the platform',
      'Call generate_image with brand-safe prompt and correct aspect ratio (1:1 feed, 9:16 Stories/Reels, 16:9 LinkedIn)',
      'For video/Reels requests: call generate_video or suggest storyboard + generate_image frames',
      'Log each approved brief with create_crm_note (tags: social, platform name). notify_webhook event content_ready for Zapier/Buffer',
      'Remember brand preferences with remember_fact. Offer weekly content calendar outline when asked',
    ],
    defaultKnowledge: `Brand name: (the tenant fills this in)
Brand voice: (friendly / luxury / professional / playful)
Target audience: (age, city, interests)
Platforms active: Instagram, Facebook, TikTok, LinkedIn
Brand colors & visual style: (e.g. pastel, bold, minimalist)
Products/services to promote: (the tenant fills this in)
Hashtags always use: (brand + industry tags)
Hashtags never use: (competitor names, banned topics)
Approval flow: drafts go to owner WhatsApp before posting
Posting schedule: (e.g. Instagram 3x/week, LinkedIn 2x/week)
Competitors to avoid mentioning: (list)
Forbidden: fake reviews, unverified claims, political content`,
    defaultTools: [
      'generate_image', 'generate_video', 'check_video_status',
      'get_current_time', 'search_knowledge', 'remember_fact', 'recall_facts',
      'create_crm_note', 'save_conversation_summary', 'notify_webhook',
      'send_whatsapp_message', 'send_email', 'flag_needs_followup', 'sync_lead_to_crm',
    ],
    agentCapabilitiesHe: 'מנהלת סושיאל מלאה: כתוביות, האשטגים, תמונות וסרטוני AI, לוח תוכן, webhook ל-Zapier/Buffer, והתראות וואטסאפ לאישור.',
    mediaEnabled: true,
    connectHintHe: 'חברו Zapier (webhook) לפרסום אוטומטי, וואטסאפ לאישור טיוטות, ו-HubSpot אם לידים מסושיאל.',
  },
];

const ENHANCEMENTS = {
  'content-he': {
    defaultTools: MEDIA_TOOLS.slice(0, 2),
    extraTasks: [
      'When writing blog posts, call generate_image for a 16:9 header image with a descriptive Hebrew prompt',
      'Include the markdown image link at the top of the draft',
    ],
    agentCapabilitiesHe: ' + מייצר תמונות כותרת לבלוג באמצעות Google AI.',
  },
  'restaurant-manager-he': {
    defaultTools: ['generate_image'],
    extraTasks: [
      'When promoting a dish or daily special, use generate_image (1:1) for an appetizing menu promo visual',
      'Describe the dish accurately from the menu — never invent ingredients',
    ],
    agentCapabilitiesHe: ' + יוצר תמונות פרומו למנות ומבצעים.',
  },
  'real-estate-il': {
    defaultTools: ['generate_image'],
    extraTasks: [
      'When describing a listing, offer generate_image for a stylized property visual (exterior or living room) based on listing details',
      'Use 16:9 aspect ratio for listing cards; never misrepresent actual property photos',
    ],
    agentCapabilitiesHe: ' + יוצר ויזואלים לכרטיסי נכס (תרשים/סטייליזציה, לא תחליף לצילום אמיתי).',
  },
};

/**
 * Mutates the templates array in workers.js — adds new templates and strengthens existing ones.
 * @param {Array} templates
 */
export function applyMediaTemplateEnhancements(templates) {
  for (const [id, patch] of Object.entries(ENHANCEMENTS)) {
    const t = templates.find((x) => x.id === id);
    if (!t) continue;
    t.defaultTools = [...new Set([...(t.defaultTools ?? []), ...(patch.defaultTools ?? [])])];
    if (patch.extraTasks?.length) {
      t.defaultTasks = [...(t.defaultTasks ?? []), ...patch.extraTasks];
    }
    if (patch.agentCapabilitiesHe) {
      t.agentCapabilitiesHe = (t.agentCapabilitiesHe || '') + patch.agentCapabilitiesHe;
    }
    t.mediaEnabled = true;
  }
  for (const mt of MEDIA_TEMPLATES) {
    if (!templates.find((x) => x.id === mt.id)) templates.push(mt);
  }
}

export { MEDIA_TOOLS };
