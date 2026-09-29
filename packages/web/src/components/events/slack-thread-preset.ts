/** Slack's Copy link format. A reply link carries its parent's timestamp. */
export function parseSlackThreadLink(value: string): { channel: string; threadTs: string } | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com")) return null;
    const match = /^\/archives\/([CDG][A-Z0-9]+)\/p(\d{16})\/?$/.exec(url.pathname);
    if (!match) return null;
    const parent = url.searchParams.get("thread_ts");
    if (parent !== null && !/^\d{10}\.\d{6}$/.test(parent)) return null;
    return { channel: match[1], threadTs: parent ?? `${match[2].slice(0, -6)}.${match[2].slice(-6)}` };
  } catch { return null; }
}
