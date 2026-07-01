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
