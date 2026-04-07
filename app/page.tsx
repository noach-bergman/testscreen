'use client';

import { useState, useEffect, useRef } from 'react';

type Message = { text: string; source: string; pubDate: number };

const CHANNELS = [
  { handle: 'lelotsenzura', name: 'ללא צנזורה' },
  { handle: 'abualiexpress', name: 'Abu Ali Express' },
  { handle: 'firstreportsnews', name: 'First Reports' },
];

async function fetchChannel(handle: string, _name: string, cutoffMs: number): Promise<Message[]> {
  const phase = cutoffMs <= 60 * 60 * 1000 ? 'recent' : 'full';
  try {
    const res = await fetch(`/api/news?channel=${handle}&phase=${phase}`);
    if (!res.ok) return [];
    const { messages } = await res.json();
    return messages ?? [];
  } catch { return []; }
}

const INTERVAL_MS = 15 * 60 * 1000;

function msUntilNextInterval(): number {
  const now = new Date();
  const msIntoInterval =
    ((now.getMinutes() % (INTERVAL_MS / 60000)) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  return INTERVAL_MS - msIntoInterval;
}

function msRemainingInNewsWindow(): number {
  const now = new Date();
  const msIntoInterval =
    ((now.getMinutes() % (INTERVAL_MS / 60000)) * 60 + now.getSeconds()) * 1000 + now.getMilliseconds();
  const newsWindowMs = 2 * 60 * 1000;
  return msIntoInterval < newsWindowMs ? newsWindowMs - msIntoInterval : 0;
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
  const [newsVisible, setNewsVisible] = useState(false);
  const [timeString, setTimeString] = useState('');
  const [dateString, setDateString] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [scrollDuration, setScrollDuration] = useState(90);
  const [scrollKey, setScrollKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasEverLoadedRef = useRef(false);

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

  function fetchAllMessages() {
    let respondedCount = 0;
    let hasMessages = false;
    const RECENT = 60 * 60 * 1000;
    const FULL   = 24 * 60 * 60 * 1000;

    CHANNELS.forEach(({ handle, name }) => {
      fetchChannel(handle, name, RECENT).then((msgs) => {
        respondedCount++;
        if (msgs.length > 0) {
          hasMessages = true;
          setMessages((prev) => mergeMessages(prev, msgs));
          if (!hasEverLoadedRef.current) {
            hasEverLoadedRef.current = true;
            setLoading(false);
          }
        } else if (respondedCount === CHANNELS.length && !hasMessages) {
          if (!hasEverLoadedRef.current) {
            hasEverLoadedRef.current = true;
            setLoading(false);
          }
        }
        fetchChannel(handle, name, FULL).then((allMsgs) => {
          setMessages((prev) => mergeMessages(prev, allMsgs));
        }).catch(() => {});
      }).catch(() => {
        respondedCount++;
        if (respondedCount === CHANNELS.length && !hasMessages) {
          if (!hasEverLoadedRef.current) {
            hasEverLoadedRef.current = true;
            setLoading(false);
          }
        }
      });
    });
  }

  function showNews(durationMs: number) {
    if (returnTimerRef.current) clearTimeout(returnTimerRef.current);

    setNewsVisible(true);
    setScrollKey((k) => k + 1);

    returnTimerRef.current = setTimeout(() => setNewsVisible(false), durationMs);

    if (nextTimerRef.current) clearTimeout(nextTimerRef.current);
    const msToNext = msUntilNextInterval();
    nextTimerRef.current = setTimeout(
      () => showNews(2 * 60 * 1000),
      msToNext
    );

    // Prefetch 1 minute before next open
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    const msToPrefetch = msToNext - 60 * 1000;
    if (msToPrefetch > 0) {
      prefetchTimerRef.current = setTimeout(fetchAllMessages, msToPrefetch);
    }
  }

  // Background fetch on mount
  useEffect(() => {
    fetchAllMessages();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic background refresh every 10 minutes
  useEffect(() => {
    const id = setInterval(fetchAllMessages, 10 * 60 * 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Master timer — aligned to interval marks
  useEffect(() => {
    const remaining = msRemainingInNewsWindow();
    if (remaining > 0) {
      showNews(remaining);
    } else {
      const msToNext = msUntilNextInterval();
      nextTimerRef.current = setTimeout(() => showNews(2 * 60 * 1000), msToNext);
      // Prefetch 1 minute before first open
      const msToPrefetch = msToNext - 60 * 1000;
      if (msToPrefetch > 0) {
        prefetchTimerRef.current = setTimeout(fetchAllMessages, msToPrefetch);
      }
    }
    return () => {
      if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
      if (nextTimerRef.current) clearTimeout(nextTimerRef.current);
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll duration based on content height
  useEffect(() => {
    if (newsVisible && listRef.current && !loading) {
      const height = listRef.current.scrollHeight;
      setScrollDuration(Math.max(60, Math.round(height / 35)));
    }
  }, [messages, newsVisible, loading]);

  return (
    <main className="bg-black min-h-screen w-full overflow-hidden select-none relative">
      {/* Clock — always rendered */}
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <div
          className="text-white font-thin tracking-widest tabular-nums"
          style={{ fontSize: 'clamp(2.5rem, 12vw, 5rem)' }}
        >
          {timeString}
        </div>
        <div className="text-gray-600 text-sm tracking-[0.3em] uppercase">Brooklyn</div>
        <div className="text-gray-700 text-xs tracking-wider mt-1">{dateString}</div>
      </div>

      {/* News overlay — sits on top of clock */}
      {newsVisible && (
        <div className="absolute inset-0 bg-black overflow-hidden">
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
              onAnimationEnd={() => setNewsVisible(false)}
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
