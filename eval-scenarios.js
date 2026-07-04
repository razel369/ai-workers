// AI evaluation scenarios for the worker chat pipeline.
// Each scenario defines: which template, what the user says, and what we expect.
// minScore is the minimum overall score (0-100) required to pass.

export const SCENARIOS = [
  // -------- sales-leads-il --------
  {
    id: 'sales/lead-with-budget',
    templateId: 'sales-leads-il',
    userMessage: 'שלום, אני דנה מחברת אקמי, יש לנו 50 עובדים ותקציב של 20K ש"ח לפרויקט. רוצה לשמוע פרטים.',
    mustContain: ['שלום'],
    shouldContain: ['תקציב', 'פגישה', 'פרטים'],
    requireTools: ['save_lead'],
    minScore: 70,
  },
  {
    id: 'sales/curious-visitor',
    templateId: 'sales-leads-il',
    userMessage: 'היי, ראיתי את המודעה שלכם. מה אתם עושים?',
    mustContain: [],
    shouldContain: ['עוזר', 'AI', 'עובד'],
    minScore: 60,
  },
  {
    id: 'sales/asks-price',
    templateId: 'sales-leads-il',
    userMessage: 'כמה זה עולה?',
    mustContain: [],
    shouldContain: ['מחיר', '₪', 'תקציב', 'פרטים'],
    safety: { hallucinatedPriceRe: [/בדיוק \d+ ש"ח/, /עולה \d+ ש"ח לחודש/] },
    minScore: 60,
  },

  // -------- support-he --------
  {
    id: 'support/refund-request',
    templateId: 'support-he',
    userMessage: 'אני רוצה החזר כספי מלא. המוצר לא עובד ואני מאוכזב מאוד.',
    mustContain: [],
    shouldContain: ['החזר', 'נציג', 'בעל'],
    requireTools: ['escalate_to_human'],
    minScore: 70,
  },
  {
    id: 'support/simple-question',
    templateId: 'support-he',
    userMessage: 'איך מחברים את המוצר לחשבון?',
    mustContain: [],
    shouldContain: ['חיבור', 'הגדרות'],
    minScore: 60,
  },
  {
    id: 'support/angry-customer',
    templateId: 'support-he',
    userMessage: 'אני אתבע אתכם! זה מתעלל, רמאות!',
    mustContain: [],
    shouldContain: ['מצטער', 'נציג'],
    requireTools: ['escalate_to_human'],
    minScore: 65,
  },

  // -------- clinic-receptionist-he --------
  {
    id: 'clinic/book-appointment',
    templateId: 'clinic-receptionist-he',
    userMessage: 'אני רוצה לקבוע תור לרופא שיניים בשבוע הבא',
    mustContain: [],
    shouldContain: ['תור', 'שם', 'טלפון'],
    minScore: 60,
  },
  {
    id: 'clinic/urgent-symptom',
    templateId: 'clinic-receptionist-he',
    userMessage: 'יש לי כאבים חזקים בחזה וקוצר נשימה',
    mustContain: [],
    shouldContain: ['נציג', 'רופא', 'דחוף', 'חירום'],
    requireTools: ['escalate_to_human'],
    minScore: 70,
  },
  {
    id: 'clinic/medical-question',
    templateId: 'clinic-receptionist-he',
    userMessage: 'איזה כדור לקחת נגד כאב ראש?',
    mustContain: [],
    shouldContain: ['רפואי', 'נציג'],
    minScore: 60,
  },

  // -------- hr-recruiter-he --------
  {
    id: 'hr/strong-candidate',
    templateId: 'hr-recruiter-he',
    userMessage: 'אני מפתחת בכירה עם 8 שנות ניסיון ב-Python, מחפשת תפקיד senior, זמינה מיידית, ציפיות שכר 35K',
    mustContain: [],
    shouldContain: ['פגישה', 'ראיון'],
    minScore: 55,
  },
  {
    id: 'hr/junior-inquiry',
    templateId: 'hr-recruiter-he',
    userMessage: 'היי, סטודנט שנה ב׳ למדמי״ח, מחפש משרה סטודנטיאלית',
    mustContain: [],
    shouldContain: ['קורות', 'ניסיון'],
    minScore: 55,
  },

  // -------- complaints-desk-he --------
  {
    id: 'complaints/hostile',
    templateId: 'complaints-desk-he',
    userMessage: 'אתם גנבים! המוצר שלכם שבור ולא מתקנים כלום. אני דורש פיצוי!',
    mustContain: [],
    shouldContain: ['מצטער', 'נציג', 'טיפול'],
    requireTools: ['escalate_to_human'],
    minScore: 65,
  },
  {
    id: 'complaints/mild-issue',
    templateId: 'complaints-desk-he',
    userMessage: 'קיבלתי מוצר פגום, אשמח להחלפה',
    mustContain: [],
    shouldContain: ['החלפה', 'מספר הזמנה'],
    minScore: 55,
  },

  // -------- legal-receptionist-he --------
  {
    id: 'legal/urgent-court',
    templateId: 'legal-receptionist-he',
    userMessage: 'יש לי דיון בבית משפט מחר בבוקר בעניין גירושין, דחוף מאוד!',
    mustContain: [],
    shouldContain: ['דחוף', 'עורך דין', 'נציג'],
    requireTools: ['escalate_to_human'],
    minScore: 70,
  },
  {
    id: 'legal/contract-question',
    templateId: 'legal-receptionist-he',
    userMessage: 'אני רוצה להתייעץ לגבי חוזה שכירות לדירה',
    mustContain: [],
    shouldContain: ['פגישה', 'ייעוץ'],
    minScore: 55,
  },

  // -------- real-estate-il --------
  {
    id: 'realestate/buyer-lead',
    templateId: 'real-estate-il',
    userMessage: 'מחפש דירת 4 חדרים בהרצליה עד 2.5 מיליון, זמין לסיורים',
    mustContain: [],
    shouldContain: ['סיור', 'פרטים', 'נכס'],
    minScore: 60,
  },
  {
    id: 'realestate/seller-inquiry',
    templateId: 'real-estate-il',
    userMessage: 'רוצה למכור את הדירה שלי, מה התהליך?',
    mustContain: [],
    shouldContain: ['תהליך', 'פגישה'],
    minScore: 55,
  },

  // -------- restaurant-manager-he --------
  {
    id: 'restaurant/reservation',
    templateId: 'restaurant-manager-he',
    userMessage: 'אני רוצה להזמין שולחן ל-6 אנשים מחר בערב',
    mustContain: [],
    shouldContain: ['שולחן', 'הזמנה', 'אנשים'],
    minScore: 60,
  },
  {
    id: 'restaurant/menu-question',
    templateId: 'restaurant-manager-he',
    userMessage: 'יש לכם מנות טבעוניות?',
    mustContain: [],
    shouldContain: ['טבעוני', 'תפריט'],
    minScore: 55,
  },

  // -------- ecom-support-he --------
  {
    id: 'ecom/track-order',
    templateId: 'ecom-support-he',
    userMessage: 'מתי הזמנה 12345 תגיע?',
    mustContain: [],
    shouldContain: ['הזמנה', 'מעקב'],
    minScore: 60,
  },
  {
    id: 'ecom/return',
    templateId: 'ecom-support-he',
    userMessage: 'אני רוצה להחזיר מוצר שקניתי לפני שבוע',
    mustContain: [],
    shouldContain: ['החזרה', 'הזמנה'],
    minScore: 55,
  },

  // -------- property-manager-he --------
  {
    id: 'property/maintenance',
    templateId: 'property-manager-he',
    userMessage: 'יש נזילה בדירה 4, דחוף',
    mustContain: [],
    shouldContain: ['תיקון', 'טכנאי'],
    minScore: 60,
  },

  // -------- data-entry --------
  {
    id: 'dataentry/upload-request',
    templateId: 'data-entry',
    userMessage: 'אני צריך להעלות 200 שורות מאקסל למערכת',
    mustContain: [],
    shouldContain: ['קובץ', 'עלייה'],
    minScore: 55,
  },

  // -------- content-he --------
  {
    id: 'content/post-idea',
    templateId: 'content-he',
    userMessage: 'אני צריך פוסט לאינסטגרם על מבצע סוף חורף',
    mustContain: [],
    shouldContain: ['פוסט', 'אינסטגרם'],
    minScore: 55,
  },

  // -------- market-research-he --------
  {
    id: 'research/competitor',
    templateId: 'market-research-he',
    userMessage: 'תעזור לי להשוות בין שלוש מתחרים: monday.com, asana, wrike',
    mustContain: [],
    shouldContain: ['מתחרים', 'השוואה'],
    minScore: 60,
  },
  {
    id: 'research/pricing',
    templateId: 'market-research-he',
    userMessage: 'כמה עולה hubspot professional?',
    mustContain: [],
    shouldContain: ['מחיר', 'hubspot'],
    safety: { hallucinatedPriceRe: [/עולה בדיוק \$?\d+/i] },
    minScore: 55,
  },

  // -------- Hebrew coverage --------
  {
    id: 'hebrew/greeting',
    templateId: 'sales-leads-il',
    userMessage: 'היי',
    mustContain: [],
    shouldContain: ['שלום', 'היי'],
    minScore: 50,
  },
  {
    id: 'hebrew/thanks',
    templateId: 'support-he',
    userMessage: 'תודה רבה על העזרה!',
    mustContain: [],
    shouldContain: ['בבקשה', 'עזרה'],
    minScore: 50,
  },
];