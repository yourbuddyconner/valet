import { Hono } from 'hono';
import satori from '@cf-wasm/satori/workerd';
import { Resvg } from '@cf-wasm/resvg/workerd';

import type { Env, Variables } from '../env.js';
import { getSession, getShareLink, getSessionGitState, getInviteByCodeAny, getOrgSettings } from '../lib/db.js';

// DM Sans font — loaded lazily and cached in module scope
let fontData: ArrayBuffer | null = null;

async function getFont(): Promise<ArrayBuffer> {
  if (fontData) return fontData;
  // Fetch DM Sans 600 weight from Google Fonts
  const css = await fetch(
    'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  ).then((r) => r.text());

  // Extract the first font URL (woff2, woff, or ttf)
  const urlMatch = css.match(/src:\s*url\(([^)]+\.(?:woff2|woff|ttf))\)/);
  if (!urlMatch) throw new Error('Could not find font URL');

  const data = await fetch(urlMatch[1]).then((r) => r.arrayBuffer());
  fontData = data;
  return data;
}

export const ogRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /og/meta/session/:id
 * Returns OG metadata for a session (public, no auth)
 */
ogRouter.get('/meta/session/:id', async (c) => {
  const { id } = c.req.param();

  const session = await getSession(c.get('db'), id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const gitState = await getSessionGitState(c.get('db'), id);

  const sessionName = session.title || session.workspace || 'Untitled Session';
  const title = `Join session: ${sessionName}`;
  const parts: string[] = [];
  if (gitState?.sourceRepoFullName) parts.push(gitState.sourceRepoFullName);
  if (session.workspace) parts.push(session.workspace);
  const description = parts.length > 0 ? parts.join(' · ') : 'Valet session';

  // Build absolute image URL based on the request origin
  const url = new URL(c.req.url);
  const imageUrl = `${url.origin}/og/image/session/${id}`;

  return c.json({ title, description, imageUrl });
});

/**
 * GET /og/meta/session-token/:token
 * Resolves a share token to session metadata
 */
ogRouter.get('/meta/session-token/:token', async (c) => {
  const { token } = c.req.param();

  const link = await getShareLink(c.get('db'), token);
  if (!link) {
    return c.json({ error: 'Invalid share link' }, 404);
  }

  // Redirect to the session ID variant
  const url = new URL(c.req.url);
  return c.redirect(`${url.origin}/og/meta/session/${link.sessionId}`);
});

/**
 * GET /og/image/session/:id
 * Generates a dynamic OG image (PNG) for a session
 */
ogRouter.get('/image/session/:id', async (c) => {
  const { id } = c.req.param();

  const session = await getSession(c.get('db'), id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const gitState = await getSessionGitState(c.get('db'), id);

  const sessionName = session.title || session.workspace || 'Untitled Session';
  const title = `Join session: ${sessionName}`;
  const repo = gitState?.sourceRepoFullName || '';
  const workspace = session.workspace || '';

  const font = await getFont();

  // satori accepts virtual DOM objects — cast to satisfy React types
  const svg = await satori(
    ({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '1200px',
          height: '630px',
          backgroundColor: '#0a0a0a',
          padding: '60px',
          fontFamily: 'DM Sans',
          color: '#fafafa',
        },
        children: [
          // Top: branding
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      width: '40px',
                      height: '40px',
                      backgroundColor: '#22d3ee',
                      borderRadius: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '24px',
                      fontWeight: 700,
                      color: '#0a0a0a',
                    },
                    children: 'V',
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: {
                      fontSize: '24px',
                      fontWeight: 600,
                      color: '#a1a1aa',
                    },
                    children: 'Valet',
                  },
                },
              ],
            },
          },
          // Center: session title
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: title.length > 60 ? '36px' : '48px',
                      fontWeight: 700,
                      lineHeight: 1.2,
                      color: '#fafafa',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                    children: title,
                  },
                },
              ],
            },
          },
          // Bottom: repo + workspace
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                gap: '24px',
                fontSize: '28px',
                color: '#71717a',
              },
              children: [
                ...(repo
                  ? [
                      {
                        type: 'span',
                        props: {
                          style: { color: '#a1a1aa' },
                          children: repo,
                        },
                      },
                    ]
                  : []),
                ...(workspace
                  ? [
                      {
                        type: 'span',
                        props: {
                          children: workspace,
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
        ],
      },
    }) as React.ReactNode,
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'DM Sans',
          data: font,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'DM Sans',
          data: font,
          weight: 600,
          style: 'normal',
        },
        {
          name: 'DM Sans',
          data: font,
          weight: 700,
          style: 'normal',
        },
      ],
    }
  );

  const resvg = await Resvg.async(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return new Response(pngBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache',
    },
  });
});

/**
 * GET /og/meta/invite/:code
 * Returns OG metadata for an invite link (public, no auth)
 */
ogRouter.get('/meta/invite/:code', async (c) => {
  const { code } = c.req.param();

  const invite = await getInviteByCodeAny(c.get('db'), code);
  if (!invite) {
    return c.json({ error: 'Invite not found' }, 404);
  }

  const orgSettings = await getOrgSettings(c.get('db'));
  const orgName = orgSettings.name || 'Valet';

  const isExpired = new Date(invite.expiresAt) < new Date();
  const isAccepted = !!invite.acceptedAt;

  let description: string;
  if (isAccepted) {
    description = 'Invite already accepted';
  } else if (isExpired) {
    description = 'Invite expired';
  } else {
    description = `You've been invited as a ${invite.role}`;
  }

  const url = new URL(c.req.url);
  const imageUrl = `${url.origin}/og/image/invite/${code}`;

  return c.json({ title: `Join organization: ${orgName}`, description, imageUrl });
});

/**
 * GET /og/image/invite/:code
 * Generates a dynamic OG image (PNG) for an invite
 */
ogRouter.get('/image/invite/:code', async (c) => {
  const { code } = c.req.param();

  const invite = await getInviteByCodeAny(c.get('db'), code);
  if (!invite) {
    return c.json({ error: 'Invite not found' }, 404);
  }

  const orgSettings = await getOrgSettings(c.get('db'));
  const orgName = orgSettings.name || 'Valet';
  const roleLabel = `Invited as ${invite.role}`;

  const font = await getFont();

  const svg = await satori(
    ({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '1200px',
          height: '630px',
          backgroundColor: '#0a0a0a',
          padding: '60px',
          fontFamily: 'DM Sans',
          color: '#fafafa',
        },
        children: [
          // Top: branding
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      width: '40px',
                      height: '40px',
                      backgroundColor: '#22d3ee',
                      borderRadius: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '24px',
                      fontWeight: 700,
                      color: '#0a0a0a',
                    },
                    children: 'V',
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: {
                      fontSize: '24px',
                      fontWeight: 600,
                      color: '#a1a1aa',
                    },
                    children: 'Valet',
                  },
                },
              ],
            },
          },
          // Center: org name
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '16px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: orgName.length > 40 ? '36px' : '48px',
                      fontWeight: 700,
                      lineHeight: 1.2,
                      color: '#fafafa',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                    children: `Join organization: ${orgName}`,
                  },
                },
              ],
            },
          },
          // Bottom: role
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                fontSize: '28px',
                color: '#71717a',
              },
              children: [
                {
                  type: 'span',
                  props: {
                    style: { color: '#a1a1aa' },
                    children: roleLabel,
                  },
                },
              ],
            },
          },
        ],
      },
    }) as React.ReactNode,
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'DM Sans',
          data: font,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'DM Sans',
          data: font,
          weight: 600,
          style: 'normal',
        },
        {
          name: 'DM Sans',
          data: font,
          weight: 700,
          style: 'normal',
        },
      ],
    }
  );

  const resvg = await Resvg.async(svg, {
    fitTo: { mode: 'width', value: 1200 },
  });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  return new Response(pngBuffer, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache',
    },
  });
});
