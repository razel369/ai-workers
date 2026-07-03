// User-facing connect metadata — no secret/API-key fields exposed to the UI.

import { oauthAvailability, providerForType, isOAuthConfigured } from './oauth.js';
import { getIntegrationType } from './registry.js';

/** Non-secret fields users may fill (links, shop name, phone) */
export const USER_CONNECT_FIELDS = {
  google_calendar: [
    { key: 'bookingLink', labelHe: 'קישור לקביעת תור (Cal.com / Google Calendar)', type: 'url', required: false, placeholder: 'https://cal.com/your-business' },
  ],
  shopify: [
    { key: 'shop', labelHe: 'דומיין חנות', type: 'text', required: true, placeholder: 'mystore.myshopify.com' },
  ],
  webhook: [],
  whatsapp: [
    { key: 'ownerNotifyPhone', labelHe: 'המספר שלכם — לקבלת התראה כשלקוח כותב', type: 'tel', required: false, placeholder: '05X-XXXXXXX' },
  ],
  mcp: [],
};

export function enrichCatalogItem(typeDef) {
  const oauth = oauthAvailability(typeDef.id);
  const userFields = USER_CONNECT_FIELDS[typeDef.id] ?? [];
  const secretKeys = new Set(
    (typeDef.fields ?? []).filter((f) => f.type === 'secret' || /key|token|secret|password|auth/i.test(f.key)).map((f) => f.key)
  );
  const safeFields = (typeDef.fields ?? []).filter((f) => !secretKeys.has(f.key));

  let authMethod = 'oauth';
  let connectLabelHe = oauth.connectLabelHe || 'חבר';

  if (typeDef.id === 'webhook') {
    authMethod = 'generated';
    connectLabelHe = 'לחצו — ניצור קישור להעתקה';
  } else if (typeDef.id === 'whatsapp' && userFields.some((f) => f.key === 'ownerNotifyPhone')) {
    authMethod = 'phone';
    connectLabelHe = 'שמרו את המספר שלכם';
  } else if (typeDef.id === 'google_calendar') {
    authMethod = oauth.available ? 'oauth_or_link' : 'link';
    connectLabelHe = oauth.available ? oauth.connectLabelHe : 'הדביקו קישור ליומן';
  } else if (typeDef.id === 'mcp') {
    authMethod = 'platform';
    connectLabelHe = 'חבר שרת MCP';
  }

  const provider = providerForType(typeDef.id);
  const oauthConfigured = provider ? isOAuthConfigured(provider) : false;

  return {
    ...typeDef,
    authMethod,
    connectLabelHe,
    oauthAvailable: oauth.available,
    oauthConfigured,
    userFields: userFields.length ? userFields : safeFields.filter((f) => f.type !== 'secret'),
    hasSecretFields: secretKeys.size > 0,
  };
}

export function listEnrichedCatalog(listCatalogFn) {
  return listCatalogFn().map(enrichCatalogItem);
}
