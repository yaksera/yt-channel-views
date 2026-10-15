'use strict';
// Shared helpers for the dashboard, keyword explorer, background worker and content script.
(function (g) {
  const DAY = 864e5;
  const DEFAULT_SETTINGS = { videoPanel: true, badges: true };

  // chrome.storage inside the extension, localStorage when a page is opened outside it.
  const store = {
    async get(k) {
      if (g.chrome?.storage?.local) return (await chrome.storage.local.get(k))[k];
      try { return JSON.parse(localStorage.getItem(k)); } catch { return undefined; }
    },
    async set(k, v) {
      if (g.chrome?.storage?.local) return chrome.storage.local.set({ [k]: v });
      try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
    },
  };

  const getKey = async () => (await store.get('apiKey')) || '';
  const getSettings = async () => ({ ...DEFAULT_SETTINGS, ...((await store.get('settings')) || {}) });

  async function api(endpoint, params) {
    const key = await getKey();
    if (!key) {
      const err = new Error('Add your YouTube Data API key first (one-time setup).');
      err.reason = 'noKey';
      throw err;
    }
    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    for (const [k, v] of Object.entries({ ...params, key })) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = body.error?.errors?.[0]?.reason;
      let msg = (body.error?.message || `HTTP ${res.status}`).replace(/<[^>]+>/g, '');
      if (reason === 'quotaExceeded') msg = 'Daily API quota used up. It resets at midnight Pacific time.';
      if (reason === 'keyInvalid' || /API key not valid/i.test(msg)) msg = 'Your API key is not valid. Open Settings to update it.';
      if (/are blocked/i.test(msg) && !/referer/i.test(msg)) {
        msg = 'This API key is restricted to other APIs. In Google Cloud Console → Credentials, edit the key and add "YouTube Data API v3" under API restrictions (or create a new key).';
      }
      const err = new Error(msg);
      err.status = res.status;
      err.reason = reason;
      throw err;
    }
    return body;
  }

  // YouTube search autocomplete (free, no API quota). Returns [] on any failure.
  async function suggest(q, { gl } = {}) {
    const url = new URL('https://suggestqueries.google.com/complete/search');
    url.search = new URLSearchParams({ client: 'firefox', ds: 'yt', hl: 'en', q, ...(gl ? { gl } : {}) });
    try {
      const r = await fetch(url, { credentials: 'omit' });
      const body = JSON.parse(await r.text());
      return Array.isArray(body?.[1]) ? body[1].map(String) : [];
    } catch {
      return [];
    }
  }

  // ---------- formatting ----------

  const nf = new Intl.NumberFormat();
  const cf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const df = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const fmt = (n) => (n == null || Number.isNaN(n) ? '—' : nf.format(Math.round(n)));
  const compact = (n) => (n == null || Number.isNaN(n) ? '—' : cf.format(n));
  const pct = (n, digits = 1) => (n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));

  function ago(ms) {
    const d = Math.floor((Date.now() - ms) / DAY);
    if (d < 1) return 'today';
    if (d === 1) return '1 day ago';
    if (d < 60) return `${d} days ago`;
    if (d < 730) return `${Math.floor(d / 30)} months ago`;
    return `${Math.floor(d / 365)} years ago`;
  }

  function parseDuration(iso) {
    const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  function fmtDuration(s) {
    if (!s) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b), mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  const viewsPerDay = (views, publishedMs) => views / Math.max(1, (Date.now() - publishedMs) / DAY);

  async function pool(items, limit, fn) {
    let i = 0;
    const worker = async () => { while (i < items.length) await fn(items[i++]); };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  g.YT = {
    DAY, DEFAULT_SETTINGS, store, getKey, getSettings, api, suggest,
    fmt, compact, pct, esc, sum, clamp, ago, df, parseDuration, fmtDuration, median, viewsPerDay, pool, chunk,
  };
})(globalThis);
