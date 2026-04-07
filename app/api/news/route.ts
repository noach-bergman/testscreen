import { NextResponse } from 'next/server';
import { parse } from 'node-html-parser';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const CHANNELS = [
  { name: 'ללא צנזורה', handle: 'lelotsenzura' },
  { name: 'Abu Ali Express', handle: 'abualiexpress' },
  { name: 'First Reports', handle: 'firstreportsnews' },
];

const CUTOFF_MS = 24 * 60 * 60 * 1000;

export type Message = {
  text: string;
  source: string;
  pubDate: number;
};

const TG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Encoding': 'gzip, deflate, br',
};

async function fetchChannel(handle: string, name: string, cutoffMs = CUTOFF_MS): Promise<Message[]> {
  const cutoff = Date.now() - cutoffMs;
  const messages: Message[] = [];

  // For the full 24h phase paginate until cutoff is reached (up to 8 pages); recent needs only 1
  const maxPages = cutoffMs > 60 * 60 * 1000 ? 8 : 1;
  let nextUrl: string | null = `https://t.me/s/${handle}`;

  for (let page = 0; page < maxPages && nextUrl; page++) {
    const res = await fetch(nextUrl, { headers: TG_HEADERS, next: { revalidate: 0 } });
    if (!res.ok) break;

    const html = await res.text();
    const root = parse(html);

    // Extract oldest message ID for pagination (?before=<id>)
    let oldestId: number | null = null;
    let reachedCutoff = false;

    // Extract oldest wrap ID for pagination (data-post lives on .tgme_widget_message_wrap)
    for (const wrap of root.querySelectorAll('.tgme_widget_message_wrap')) {
      const post = wrap.getAttribute('data-post');
      if (post) {
        const id = parseInt(post.split('/')[1]);
        if (!isNaN(id) && (oldestId === null || id < oldestId)) oldestId = id;
      }
    }

    // Parse messages using the inner element (handles albums correctly)
    for (const el of root.querySelectorAll('.tgme_widget_message')) {
      const timeEl = el.querySelector('time[datetime]');
      const datetime = timeEl?.getAttribute('datetime');
      if (!datetime) continue;

      const pubDate = new Date(datetime).getTime();
      if (isNaN(pubDate)) continue;
      if (pubDate < cutoff) { reachedCutoff = true; continue; }

      // Prefer .js-message_text (main text) over quoted reply text
      const textEl = el.querySelector('.tgme_widget_message_text.js-message_text')
                  ?? el.querySelector('.tgme_widget_message_text');
      if (!textEl) continue;

      let text = textEl.text.replace(/\s+/g, ' ').trim();
      if (!text || text.length < 10) continue;

      if (text.length > 220) {
        text = text.slice(0, 220).replace(/\s+\S*$/, '') + '…';
      }

      messages.push({ text, source: name, pubDate });
    }

    if (!root.querySelectorAll('.tgme_widget_message_wrap').length) break;
    nextUrl = (oldestId && !reachedCutoff) ? `https://t.me/s/${handle}?before=${oldestId}` : null;
  }

  return messages;
}

// Parse RSS/Atom XML to extract tweets from X via RSSHub
async function fetchXAccount(username: string, name: string): Promise<Message[]> {
  const cutoff = Date.now() - CUTOFF_MS;
  const messages: Message[] = [];

  // Try multiple RSSHub instances in order
  const feeds = [
    `https://rsshub.app/twitter/user/${username}`,
    `https://rsshub.rssforever.com/twitter/user/${username}`,
  ];

  let xml = '';
  for (const url of feeds) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsClock/1.0)' },
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) { xml = await res.text(); break; }
    } catch { continue; }
  }

  if (!xml) return [];

  // Simple regex extraction — RSS structure is predictable
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const content = match[1];
    const title =
      content.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ||
      content.match(/<title>([\s\S]*?)<\/title>/)?.[1] ||
      '';
    const pubDateStr =
      content.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';

    const text = title.replace(/\s+/g, ' ').trim();
    if (!text || text.length < 10) continue;

    const pubDate = pubDateStr ? new Date(pubDateStr).getTime() : Date.now();
    if (isNaN(pubDate) || pubDate < cutoff) continue;

    const truncated = text.length > 220 ? text.slice(0, 220).replace(/\s+\S*$/, '') + '…' : text;
    messages.push({ text: truncated, source: name, pubDate });
  }

  return messages;
}

function dedupe(msgs: Message[]): Message[] {
  const seen = new Set<string>();
  return msgs.filter((m) => {
    const key = m.text.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const channelHandle = searchParams.get('channel');
  const phase = searchParams.get('phase') ?? 'full';
  const cutoffMs = phase === 'recent' ? 60 * 60 * 1000 : CUTOFF_MS;

  // Single channel — each channel gets its own Vercel function call with full timeout
  if (channelHandle) {
    const ch = CHANNELS.find((c) => c.handle === channelHandle);
    if (!ch) return NextResponse.json({ messages: [] });
    const messages = await fetchChannel(ch.handle, ch.name, cutoffMs);
    messages.sort((a, b) => b.pubDate - a.pubDate);
    return NextResponse.json({ messages });
  }

  // All channels at once (fallback)
  const results = await Promise.allSettled(
    CHANNELS.map((ch) => fetchChannel(ch.handle, ch.name, cutoffMs))
  );
  const all: Message[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') all.push(...result.value);
  }
  all.sort((a, b) => b.pubDate - a.pubDate);
  return NextResponse.json({ messages: dedupe(all), fetchedAt: Date.now() });
}
