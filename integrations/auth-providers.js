/** OAuth provider definitions — credentials live in env vars only, never in user UI. */

export const OAUTH_PROVIDERS = {
  google: {
    id: 'google',
    forTypes: ['google_calendar', 'google_sheets'],
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'openid',
      'email',
      'profile',
    ],
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    connectLabelHe: 'התחבר עם Google',
    clientId: () => process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: () => process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
    mapConfig(tokens, profile) {
      return {
        authMethod: 'oauth',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : '',
        email: profile.email || '',
        mode: 'oauth',
      };
    },
  },

  hubspot: {
    id: 'hubspot',
    forTypes: ['crm_hubspot'],
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'oauth'],
    connectLabelHe: 'התחבר עם HubSpot',
    clientId: () => process.env.HUBSPOT_CLIENT_ID || '',
    clientSecret: () => process.env.HUBSPOT_CLIENT_SECRET || '',
    mapConfig(tokens) {
      return {
        authMethod: 'oauth',
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : '',
        apiKey: tokens.access_token,
      };
    },
  },

  shopify: {
    id: 'shopify',
    forTypes: ['shopify'],
    authorizeUrl: null,
    tokenUrl: null,
    scopes: ['read_orders', 'read_products'],
    connectLabelHe: 'התחבר עם Shopify',
    clientId: () => process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || '',
    clientSecret: () => process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || '',
    buildAuthUrl({ shop, redirectUri, state, clientId, scopes }) {
      const host = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const params = new URLSearchParams({
        client_id: clientId,
        scope: scopes.join(','),
        redirect_uri: redirectUri,
        state,
      });
      return `https://${host}/admin/oauth/authorize?${params.toString()}`;
    },
    exchangeBody({ code, clientId, clientSecret }) {
      return JSON.stringify({ client_id: clientId, client_secret: clientSecret, code });
    },
    mapConfig(tokens, _profile, extra) {
      const host = String(extra.shop || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      return {
        authMethod: 'oauth',
        shopDomain: host,
        accessToken: tokens.access_token,
      };
    },
  },

  pipedrive: {
    id: 'pipedrive',
    forTypes: ['crm_pipedrive'],
    authorizeUrl: 'https://oauth.pipedrive.com/oauth/authorize',
    tokenUrl: 'https://oauth.pipedrive.com/oauth/token',
    scopes: ['deals:full', 'contacts:full'],
    connectLabelHe: 'התחבר עם Pipedrive',
    clientId: () => process.env.PIPEDRIVE_CLIENT_ID || '',
    clientSecret: () => process.env.PIPEDRIVE_CLIENT_SECRET || '',
    mapConfig(tokens) {
      return {
        authMethod: 'oauth',
        apiToken: tokens.access_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
      };
    },
  },

  meta: {
    id: 'meta',
    forTypes: ['whatsapp'],
    authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'],
    connectLabelHe: 'התחבר עם Meta / WhatsApp',
    clientId: () => process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '',
    clientSecret: () => process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '',
    mapConfig(tokens) {
      return {
        authMethod: 'oauth',
        provider: 'meta',
        accessToken: tokens.access_token,
      };
    },
  },
};

export { OAUTH_PROVIDERS as default };
