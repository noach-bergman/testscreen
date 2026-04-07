'use client';

import { useState, useEffect, useRef } from 'react';

type Message = { text: string; source: string; pubDate: number };

const CHANNELS = [
  { handle: 'lelotsenzura', name: 'ללא צנזורה' },
  { handle: 'abualiexpress', name: 'Abu Ali Express' },
  { handle: 'firstreportsnews', name: 'First Reports' },
];

// CORS proxies tried in order
const PROXIES = [
  (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

async function fetchChannel(handle: string, name: string, cutoffMs: number): Promise<Message[]> {
  const telegramUrl = `https://t.me/s/${handle}`;
  let html = '';

  for (const makeProxy of PROXIES) {
    try {
      const res = await fetch(makeProxy(telegramUrl));
      if (res.ok) { html = await res.text(); break; }
    } catch { continue; }
  }

  if (!html) return [];

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const cutoff = Date.now() - cutoffMs;
  const messages: Message[] = [];

  doc.querySelectorAll('.tgme_widget_message').forEach((el) => {
    const datetime = el.querySelector('time')?.getAttribute('datetime');
    if (!datetime) return;
    const pubDate = new Date(datetime).getTime();
    if (isNaN(pubDate) || pubDate < cutoff) return;

    let text = el.querySelector('.tgme_widget_message_text')
      ?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (!text || text.length < 10) return;
    if (text.length > 220) text = text.slice(0, 220).replace(/\s+\S*$/, '') + '…';

    messages.push({ text, source: name, pubDate });
  });

  return messages;
}

function msUntilNextQuarter(): number {
  const now = new Date();
  const msIntoQuarter =
    ((now.getMinutes() % 15) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  return 15 * 60 * 1000 - msIntoQuarter;
}

function msRemainingInNewsWindow(): number {
  const now = new Date();
  const msIntoQuarter =
    ((now.getMinutes() % 15) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  const newsWindowMs = 2 * 60 * 1000;
  return msIntoQuarter < newsWindowMs ? newsWindowMs - msIntoQuarter : 0;
}

function mergeMessages(prev: Message[], incoming: Message[]): Message[] {
  const combined = [...prev, ...incoming];
  combined.sort((a, b) => b.pubDate - a.pubDate);
  const seen = new Set<string>();
  return combined.filter((m) => {
    const key = m.text.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function Home() {
  const [view, setView] = useState<'clock' | 'news'>('clock');
  const [timeString, setTimeString] = useState('');
  const [dateString, setDateString] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [scrollDuration, setScrollDuration] = useState(90);
  const [scrollKey, setScrollKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clock — ticks every second
  useEffect(() => {
    const timeFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    });
    const dateFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long', month: 'long', day: 'numeric',
    });
    function tick() {
      const now = new Date();
      setTimeString(timeFmt.format(now));
      setDateString(dateFmt.format(now));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  function showNews(durationMs: number) {
    if (returnTimerRef.current) clearTimeout(returnTimerRef.current);

    setMessages([]);
    setLoading(true);
    setView('news');
    setScrollKey((k) => k + 1);

    let firstArrived = false;
    const RECENT = 60 * 60 * 1000;      // 1 hour
    const FULL   = 24 * 60 * 60 * 1000; // 24 hours

    CHANNELS.forEach(({ handle, name }) => {
      // Phase 1: last 1 hour — show immediately when first channel arrives
      fetchChannel(handle, name, RECENT).then((msgs) => {
        if (!firstArrived) {
          firstArrived = true;
          setMessages(msgs);
          setLoading(false);
        } else {
          setMessages((prev) => mergeMessages(prev, msgs));
        }
        // Phase 2: full 24h — append older messages in background
        fetchChannel(handle, name, FULL).then((allMsgs) => {
          setMessages((prev) => mergeMessages(prev, allMsgs));
        }).catch(() => {});
      }).catch(() => {
        if (!firstArrived) { firstArrived = true; setLoading(false); }
      });
    });

    returnTimerRef.current = setTimeout(() => setView('clock'), durationMs);

    if (nextTimerRef.current) clearTimeout(nextTimerRef.current);
    nextTimerRef.current = setTimeout(
      () => showNews(2 * 60 * 1000),
      msUntilNextQuarter()
    );
  }

  // Master timer — aligned to :00 / :15 / :30 / :45
  useEffect(() => {
    const remaining = msRemainingInNewsWindow();
    if (remaining > 0) {
      showNews(remaining);
    } else {
      nextTimerRef.current = setTimeout(
        () => showNews(2 * 60 * 1000),
        msUntilNextQuarter()
      );
    }
    return () => {
      if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
      if (nextTimerRef.current) clearTimeout(nextTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll duration based on content height
  useEffect(() => {
    if (view === 'news' && listRef.current && !loading) {
      const height = listRef.current.scrollHeight;
      setScrollDuration(Math.max(60, Math.round(height / 35)));
    }
  }, [messages, view, loading]);

  return (
    <main className="bg-black min-h-screen w-full overflow-hidden select-none">
      {view === 'clock' ? (
        <div className="flex flex-col items-center justify-center h-screen gap-4">
          <div
            className="text-white font-thin tracking-widest tabular-nums"
            style={{ fontSize: 'clamp(2.5rem, 12vw, 5rem)' }}
          >
            {timeString}
          </div>
          <div className="text-gray-600 text-sm tracking-[0.3em] uppercase">Brooklyn</div>
          <div className="text-gray-700 text-xs tracking-wider mt-1">{dateString}</div>
          <button
            onClick={() => showNews(2 * 60 * 1000)}
            className="mt-8 px-6 py-2 border border-gray-700 text-gray-500 text-xs tracking-widest uppercase rounded hover:border-gray-500 hover:text-gray-300 transition-colors active:opacity-60"
          >
            הצג חדשות עכשיו
          </button>
        </div>
      ) : (
        <div className="overflow-hidden h-screen w-full">
          {loading ? (
            <div className="flex items-center justify-center h-screen">
              <div className="text-gray-600 text-sm tracking-widest uppercase animate-pulse">
                Loading…
              </div>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex items-center justify-center h-screen">
              <div className="text-gray-700 text-sm tracking-widest uppercase">
                No messages found
              </div>
            </div>
          ) : (
            <div
              key={scrollKey}
              ref={listRef}
              style={{ animation: `scrollUp ${scrollDuration}s linear forwards` }}
            >
              <div className="h-[50vh]" />
              <div className="px-5 pb-2 text-gray-600 text-xs tracking-[0.25em] uppercase">
                עדכונים אחרונים · Last 24h
              </div>
              {messages.map((m, i) => (
                <div key={i} className="px-4 py-3 border-b border-gray-900">
                  <p className="text-white leading-snug" style={{ fontSize: 'clamp(0.8rem, 3.2vw, 1rem)' }}>
                    {m.text}
                  </p>
                  <div className="flex items-center gap-3 mt-1">
                    <p className="text-gray-600 tracking-wider uppercase" style={{ fontSize: '0.65rem' }}>
                      {m.source}
                    </p>
                    <p className="text-gray-600" style={{ fontSize: '0.65rem' }}>
                      {new Intl.DateTimeFormat('en-US', {
                        timeZone: 'America/New_York',
                        hour: 'numeric', minute: '2-digit', hour12: true,
                      }).format(new Date(m.pubDate))}
                    </p>
                  </div>
                </div>
              ))}
              <div className="h-screen" />
            </div>
          )}
        </div>
      )}
    </main>
  );
}
