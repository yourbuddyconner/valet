/**
 * Cloudflare Pages Function — catch-all middleware
 * Detects bot User-Agents and injects dynamic OG meta tags for session URLs.
 */

interface PagesEnv {
  WORKER_URL: string;
}

const BOT_USER_AGENTS = [
  'Slackbot',
  'Twitterbot',
  'facebookexternalhit',
  'LinkedInBot',
  'Discordbot',
  'WhatsApp',
  'TelegramBot',
  'Googlebot',
  'bingbot',
  'Applebot',
  'Pinterestbot',
];

function isBot(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_USER_AGENTS.some((bot) => ua.includes(bot.toLowerCase()));
}

interface OGMeta {
  title: string;
  description: string;
  imageUrl: string;
}

// Match /sessions/:id (UUIDs or similar IDs)
const SESSION_ID_PATTERN = /^\/sessions\/([a-f0-9-]{36})\/?$/;
// Match /sessions/join/:token
const SESSION_JOIN_PATTERN = /^\/sessions\/join\/([^/]+)\/?$/;
// Match /invite/:code
const INVITE_PATTERN = /^\/invite\/([^/]+)\/?$/;

export const onRequest: PagesFunction<PagesEnv> = async (context) => {
  const { request, next, env } = context;
  const userAgent = request.headers.get('User-Agent');

  // Non-bots get the normal SPA
  if (!isBot(userAgent)) {
    return next();
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // Only intercept known OG-eligible URLs for bots
  const sessionIdMatch = path.match(SESSION_ID_PATTERN);
  const joinMatch = path.match(SESSION_JOIN_PATTERN);
  const inviteMatch = path.match(INVITE_PATTERN);

  if (!sessionIdMatch && !joinMatch && !inviteMatch) {
    return next();
  }

  const workerUrl = env.WORKER_URL;
  if (!workerUrl) {
    return next();
  }

  try {
    let metaUrl: string;
    if (sessionIdMatch) {
      metaUrl = `${workerUrl}/og/meta/session/${sessionIdMatch[1]}`;
    } else if (joinMatch) {
      metaUrl = `${workerUrl}/og/meta/session-token/${joinMatch[1]}`;
    } else {
      metaUrl = `${workerUrl}/og/meta/invite/${inviteMatch![1]}`;
    }

    const metaResponse = await fetch(metaUrl, {
      headers: { 'User-Agent': 'Valet-Pages-Function' },
      redirect: 'follow',
    });

    if (!metaResponse.ok) {
      return next();
    }

    const meta: OGMeta = await metaResponse.json();

    // Get the original HTML from the SPA
    const response = await next();
    const html = await response.text();

    // Replace default OG values with dynamic ones
    const modifiedHtml = html
      .replace(
        /<meta property="og:title" content="[^"]*" \/>/,
        `<meta property="og:title" content="${escapeAttr(meta.title)}" />`
      )
      .replace(
        /<meta property="og:description" content="[^"]*" \/>/,
        `<meta property="og:description" content="${escapeAttr(meta.description)}" />`
      )
      .replace(
        /<meta property="og:image" content="[^"]*" \/>/,
        `<meta property="og:image" content="${escapeAttr(meta.imageUrl)}" />`
      )
      .replace(
        /<meta name="twitter:title" content="[^"]*" \/>/,
        `<meta name="twitter:title" content="${escapeAttr(meta.title)}" />`
      )
      .replace(
        /<meta name="twitter:description" content="[^"]*" \/>/,
        `<meta name="twitter:description" content="${escapeAttr(meta.description)}" />`
      )
      .replace(
        /<meta name="twitter:image" content="[^"]*" \/>/,
        `<meta name="twitter:image" content="${escapeAttr(meta.imageUrl)}" />`
      )
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.title)} — Valet</title>`);

    return new Response(modifiedHtml, {
      status: response.status,
      headers: {
        ...Object.fromEntries(response.headers.entries()),
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  } catch {
    // On any error, fall through to static defaults
    return next();
  }
};

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
