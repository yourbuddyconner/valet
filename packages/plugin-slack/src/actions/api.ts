const SLACK_API = 'https://slack.com/api';

/** Authenticated POST against the Slack Web API. Automatically retries on 429 rate limits. */
export async function slackFetch(
  method: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : '{}',
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') || '2');
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    return res;
  }

  // Return a synthetic 429 if all retries exhausted
  return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429 });
}

/** Authenticated GET against the Slack Web API. For read methods (conversations.list, etc.). Automatically retries on 429. */
export async function slackGet(
  method: string,
  token: string,
  params?: Record<string, unknown>,
): Promise<Response> {
  const url = new URL(`${SLACK_API}/${method}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  // URLSearchParams encodes commas to %2C, but Slack expects literal commas
  // in list params like types=public_channel,private_channel
  const finalUrl = url.toString().replace(/%2C/gi, ',');

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(finalUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') || '2');
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    return res;
  }

  return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 429 });
}
