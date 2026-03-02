const SLACK_API = 'https://slack.com/api';

/** Authenticated POST against the Slack Web API. */
export async function slackFetch(
  method: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : '{}',
  });
}
