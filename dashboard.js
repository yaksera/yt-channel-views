'use strict';

// Each upload type maps to one of YouTube's auto-generated per-channel playlists:
// UULF = long-form videos, UUSH = Shorts, UULV = past/current live streams.
const TYPES = {
  long: { label: 'Long videos', one: 'Video', prefix: 'UULF' },
  short: { label: 'Shorts', one: 'Short', prefix: 'UUSH' },
  live: { label: 'Live streams', one: 'Live', prefix: 'UULV' },
};
const TYPE_KEYS = Object.keys(TYPES);
const PAGE = 50;
const { DAY, store, api, fmt, compact, esc, sum, ago, df, parseDuration, fmtDuration, median, pool } = YT;

const $ = (sel) => document.querySelector(sel);
const state = { key: '', channel: null, videos: [], fetchedAt: 0, filter: 'all', sort: 'views', shown: PAGE, run: 0 };

// Turns whatever the user has open (channel page, video, short, @handle, ID) into a lookup target.
function parseInput(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (/^UC[\w-]{22}$/.test(s)) return { channelId: s };
  if (/^@[^\s/]+$/.test(s)) return { handle: s, pageUrl: `https://www.youtube.com/${encodeURI(s)}` };

  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return id ? { videoId: id } : null;
  }
  if (host !== 'youtube.com') {
    // Bare word typed in the box: treat it as a handle.
    return /^[\w.-]+$/.test(s) ? { handle: '@' + s, pageUrl: `https://www.youtube.com/@${s}` } : null;
  }

  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [first, second] = parts;
  if (u.pathname === '/watch' && u.searchParams.get('v')) return { videoId: u.searchParams.get('v') };
  if (['shorts', 'live', 'embed', 'v'].includes(first) && second) return { videoId: second };
  if (first === 'channel' && /^UC[\w-]{22}$/.test(second || '')) return { channelId: second };
  const pageUrl = `https://www.youtube.com/${parts.slice(0, first === 'c' || first === 'user' ? 2 : 1).map(encodeURI).join('/')}`;
  if (first?.startsWith('@')) return { handle: first, pageUrl };
  if (first === 'user' && second) return { username: second, pageUrl };
  if (first && !['watch', 'results', 'feed', 'playlist'].includes(first)) return { pageUrl };
  return null;
}

async function scrapeChannelId(pageUrl) {
  try {
    const html = await (await fetch(pageUrl, { credentials: 'omit' })).text();
    const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)
      || html.match(/"externalId":"(UC[\w-]{22})"/)
      || html.match(/"browseId":"(UC[\w-]{22})"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function resolveChannelId(input) {
  const t = parseInput(input);
  if (!t) throw new Error("That doesn't look like a YouTube channel or video link.");
  if (t.channelId) return t.channelId;
  if (t.videoId) {
    const r = await api('videos', { part: 'snippet', id: t.videoId, fields: 'items/snippet/channelId' });
    const id = r.items?.[0]?.snippet?.channelId;
    if (!id) throw new Error('Video not found — it may be private or deleted.');
    return id;
  }
  if (t.handle) {
    const r = await api('channels', { part: 'id', forHandle: t.handle, fields: 'items/id' });
    if (r.items?.[0]) return r.items[0].id;
  }
  if (t.username) {
    const r = await api('channels', { part: 'id', forUsername: t.username, fields: 'items/id' });
    if (r.items?.[0]) return r.items[0].id;
  }
  if (t.pageUrl) {
    const id = await scrapeChannelId(t.pageUrl);
    if (id) return id;
  }
  throw new Error('Channel not found.');
}

async function getChannel(id) {
  const r = await api('channels', {
    part: 'snippet,statistics',
    id,
    fields: 'items(id,snippet(title,customUrl,thumbnails/medium/url,thumbnails/default/url),statistics)',
  });
  const c = r.items?.[0];
  if (!c) throw new Error('Channel not found.');
  return {
    id: c.id,
    title: c.snippet.title,
    handle: c.snippet.customUrl || '',
    avatar: c.snippet.thumbnails?.medium?.url || c.snippet.thumbnails?.default?.url || '',
    views: +c.statistics.viewCount || 0,
    subs: c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount || 0,
    uploads: +c.statistics.videoCount || 0,
  };
}

async function listPlaylist(playlistId, onProgress) {
  const ids = [];
  let pageToken;
  do {
    let r;
    try {
      r = await api('playlistItems', {
        part: 'contentDetails', playlistId, maxResults: 50, pageToken,
        fields: 'nextPageToken,pageInfo/totalResults,items/contentDetails/videoId',
      });
    } catch (e) {
      if (e.status === 404) return ids; // channel has no uploads of this type
      throw e;
    }
    for (const it of r.items || []) ids.push(it.contentDetails.videoId);
    onProgress(ids.length, r.pageInfo?.totalResults);
    pageToken = r.nextPageToken;
  } while (pageToken);
  return ids;
}

async function fetchDetails(entries, onProgress) {
  const batches = [];
  for (let i = 0; i < entries.length; i += 50) batches.push(entries.slice(i, i + 50));
  const typeOf = new Map(entries.map((e) => [e.id, e.type]));
  const out = [];
  await pool(batches, 4, async (batch) => {
    const r = await api('videos', {
      part: 'snippet,statistics,contentDetails',
      id: batch.map((e) => e.id).join(','),
      maxResults: 50,
      fields: 'items(id,snippet(title,publishedAt,liveBroadcastContent),statistics(viewCount,likeCount,commentCount),contentDetails/duration)',
    });
    for (const v of r.items || []) {
      out.push({
        id: v.id,
        type: typeOf.get(v.id),
        title: v.snippet.title,
        published: Date.parse(v.snippet.publishedAt),
        state: v.snippet.liveBroadcastContent, // none | live | upcoming
        views: +v.statistics?.viewCount || 0,
        likes: v.statistics?.likeCount != null ? +v.statistics.likeCount : null,
        comments: v.statistics?.commentCount != null ? +v.statistics.commentCount : null,
        duration: parseDuration(v.contentDetails?.duration),
      });
    }
    onProgress(out.length);
  });
  return out;
}

// ---------- main flow ----------

function setStatus(html, { error = false, progress = null } = {}) {
  const el = $('#status');
  el.hidden = !html;
  el.className = 'status' + (error ? ' error' : '');
  el.innerHTML = html + (progress != null ? `<div class="bar"><span style="width:${Math.round(progress * 100)}%"></span></div>` : '');
}

async function analyze(input) {
  if (!state.key) {
    $('#keyPanel').hidden = false;
    $('#keyInput').focus();
    setStatus('Add your YouTube Data API key first (one-time setup).', { error: true });
    return;
  }
  const run = ++state.run;
  const alive = () => run === state.run;
  $('#results').hidden = true;
  try {
    setStatus('Finding channel…', { progress: 0.02 });
    const channelId = await resolveChannelId(input);
    if (!alive()) return;
    const channel = await getChannel(channelId);
    if (!alive()) return;
    document.title = `${channel.title} · Channel Views`;

    const listed = { long: 0, short: 0, live: 0 };
    const expected = Math.max(channel.uploads, 1);
    const showListing = () => setStatus(
      `Listing uploads of <b>${esc(channel.title)}</b>… ` +
      TYPE_KEYS.map((t) => `${TYPES[t].label}: ${fmt(listed[t])}`).join(' · '),
      { progress: Math.min(0.45, 0.05 + 0.4 * (sum(TYPE_KEYS, (t) => listed[t]) / expected)) },
    );
    showListing();
    const base = channelId.slice(2);
    const lists = await Promise.all(TYPE_KEYS.map((t) =>
      listPlaylist(TYPES[t].prefix + base, (n) => { listed[t] = n; if (alive()) showListing(); })));
    if (!alive()) return;

    // A video should only appear in one list; if not, live > short > long wins.
    const seen = new Map();
    for (const t of ['live', 'short', 'long']) {
      for (const id of lists[TYPE_KEYS.indexOf(t)]) if (!seen.has(id)) seen.set(id, t);
    }
    const entries = [...seen].map(([id, type]) => ({ id, type }));
    const videos = await fetchDetails(entries, (n) => {
      if (alive()) setStatus(`Fetching view counts… ${fmt(n)} / ${fmt(entries.length)}`, { progress: 0.45 + 0.55 * (n / Math.max(entries.length, 1)) });
    });
    if (!alive()) return;

    Object.assign(state, { channel, videos, fetchedAt: Date.now(), filter: 'all', shown: PAGE });
    setStatus('');
    renderAll();
  } catch (e) {
    if (alive()) setStatus(esc(e.message || String(e)), { error: true });
  }
}

// ---------- rendering ----------

function stats(list) {
  const views = sum(list, (v) => v.views);
  return {
    count: list.length,
    views,
    avg: list.length ? views / list.length : null,
    median: median(list.map((v) => v.views)),
    top: list.reduce((best, v) => (!best || v.views > best.views ? v : best), null),
  };
}

function byType(list) {
  const out = {};
  for (const t of TYPE_KEYS) out[t] = list.filter((v) => v.type === t);
  return out;
}

function renderAll() {
  $('#results').hidden = false;
  renderChannel();
  renderTypeCards();
  renderPeriod();
  renderBestTime();
  renderFilter();
  renderAllTable();
}

function renderChannel() {
  const c = state.channel;
  const url = `https://www.youtube.com/channel/${c.id}`;
  $('#channelCard').innerHTML = `
    ${c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : ''}
    <div>
      <div class="name"><a href="${url}" target="_blank" rel="noopener">${esc(c.title)}</a></div>
      <div class="meta">
        ${c.handle ? `<span>${esc(c.handle)}</span>` : ''}
        <span><b>${c.subs == null ? 'Hidden' : compact(c.subs)}</b> subscribers</span>
        <span><b>${fmt(c.views)}</b> channel views (YouTube total)</span>
        <span><b>${fmt(c.uploads)}</b> public uploads</span>
      </div>
    </div>
    <div class="fetched">Fetched ${new Date(state.fetchedAt).toLocaleString()}<br>
      <button class="ghost" type="button" id="refreshBtn">Refresh</button></div>`;
  $('#refreshBtn').onclick = () => analyze(c.id);
}

function renderTypeCards() {
  const all = stats(state.videos);
  const groups = byType(state.videos);
  const card = (cls, label, s, share) => `
    <div class="card">
      <div class="label">${cls ? `<span class="dot ${cls}"></span>` : ''}${label}</div>
      <div class="big num" title="${fmt(s.views)} views">${compact(s.views)}</div>
      <div class="exact num">${fmt(s.views)} views</div>
      <div class="rows">
        <div><span>${cls ? 'Uploads' : 'Videos counted'}</span><b class="num">${fmt(s.count)}</b></div>
        <div><span>Avg views</span><b class="num">${compact(s.avg)}</b></div>
        <div><span>Median views</span><b class="num">${compact(s.median)}</b></div>
        ${share != null ? `<div><span>Share of views</span><b class="num">${(share * 100).toFixed(1)}%</b></div>` : ''}
      </div>
      ${share != null ? `<div class="share"><span class="fill-${cls}" style="width:${(share * 100).toFixed(2)}%"></span></div>` : ''}
    </div>`;
  $('#typeCards').innerHTML =
    TYPE_KEYS.map((t) => { const s = stats(groups[t]); return card(t, TYPES[t].label, s, all.views ? s.views / all.views : 0); }).join('') +
    card('', 'All uploads', all, null);
}

function periodRange(p) {
  const now = new Date();
  if (p === 'thisMonth') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: +s, end: +now, label: now.toLocaleString(undefined, { month: 'long', year: 'numeric' }) };
  }
  if (p === 'prevMonth') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: +s, end: +e, label: s.toLocaleString(undefined, { month: 'long', year: 'numeric' }) };
  }
  const days = +p;
  return { start: +now - days * DAY, end: +now, label: `Last ${days} days` };
}

function renderPeriod() {
  const { start, end, label } = periodRange($('#period').value);
  const inPeriod = state.videos.filter((v) => v.published >= start && v.published < end).sort((a, b) => a.published - b.published);
  $('#periodLabel').textContent = `${label}: ${df.format(start)} – ${df.format(end - 1)} · videos published in this window and their views to date.`;

  const allGroups = byType(state.videos);
  const groups = byType(inPeriod);
  const vsAll = (s, t) => {
    const base = stats(allGroups[t]).avg;
    if (!s.avg || !base) return '';
    const pct = (s.avg / base - 1) * 100;
    return `<div><span>vs all-time avg</span><b class="num ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%</b></div>`;
  };
  const totals = stats(inPeriod);
  $('#periodCards').innerHTML = TYPE_KEYS.map((t) => {
    const s = stats(groups[t]);
    return `<div class="card">
      <div class="label"><span class="dot ${t}"></span>${TYPES[t].label}</div>
      <div class="big num" title="${fmt(s.views)} views">${compact(s.views)}</div>
      <div class="exact num">${fmt(s.views)} views</div>
      <div class="rows">
        <div><span>Uploads</span><b class="num">${fmt(s.count)}</b></div>
        <div><span>Avg views</span><b class="num">${compact(s.avg)}</b></div>
        ${vsAll(s, t)}
      </div></div>`;
  }).join('') + `<div class="card">
      <div class="label">Total</div>
      <div class="big num" title="${fmt(totals.views)} views">${compact(totals.views)}</div>
      <div class="exact num">${fmt(totals.views)} views</div>
      <div class="rows">
        <div><span>Uploads</span><b class="num">${fmt(totals.count)}</b></div>
        <div><span>Avg views</span><b class="num">${compact(totals.avg)}</b></div>
        ${totals.top ? `<div><span>Best</span><b class="num">${compact(totals.top.views)}</b></div>` : ''}
      </div></div>`;

  renderChart(inPeriod);
  $('#periodTable').innerHTML = inPeriod.length
    ? videoTable([...inPeriod].reverse(), { perDay: true })
    : '';
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function renderChart(list) {
  const wrap = $('#chartWrap');
  if (!list.length) { wrap.innerHTML = '<div class="empty">No uploads in this period.</div>'; return; }
  wrap.innerHTML = `<div class="legend">${TYPE_KEYS.map((t) => `<span><i class="dot ${t}"></i>${TYPES[t].label}</span>`).join('')}
    <span class="muted">· each bar is one upload, oldest → newest, height = views</span></div>
    <div class="chart"><svg role="img" aria-label="Views per upload in the selected period"></svg></div>`;
  const svg = wrap.querySelector('svg');
  const W = svg.clientWidth || 800, H = 220;
  const m = { l: 48, r: 8, t: 8, b: 22 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(...list.map((v) => v.views)));
  const y = (v) => m.t + ih - (v / max) * ih;
  const slot = iw / list.length;
  const gap = slot > 4 ? 2 : 0;
  const bw = Math.max(1, Math.min(48, slot - gap));
  const r = Math.min(4, bw / 2);

  let out = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    out += `<line class="${i ? 'gridline' : 'baseline'}" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
    out += `<text class="axis" x="${m.l - 6}" y="${yy + 4}" text-anchor="end">${compact(v)}</text>`;
  }
  list.forEach((v, i) => {
    const x = m.l + i * slot + (slot - bw) / 2;
    const top = y(v.views), h = m.t + ih - top;
    const rr = Math.min(r, h);
    const d = h <= 0 ? '' : `M${x},${m.t + ih}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + bw - rr}Q${x + bw},${top} ${x + bw},${top + rr}V${m.t + ih}Z`;
    out += `<path class="bar" data-i="${i}" d="${d}" fill="var(--${v.type})"/>`;
    out += `<rect class="hit" data-i="${i}" x="${m.l + i * slot}" y="${m.t}" width="${slot}" height="${ih}"/>`;
  });
  const first = list[0].published, last = list[list.length - 1].published;
  out += `<text class="axis" x="${m.l}" y="${H - 4}">${df.format(first)}</text>`;
  if (list.length > 1) out += `<text class="axis" x="${W - m.r}" y="${H - 4}" text-anchor="end">${df.format(last)}</text>`;
  svg.innerHTML = out;

  const chart = wrap.querySelector('.chart');
  const tip = $('#tooltip');
  svg.addEventListener('mousemove', (e) => {
    const i = e.target.dataset?.i;
    if (i == null) return hide();
    const v = list[+i];
    chart.classList.add('hovering');
    svg.querySelectorAll('.bar.active').forEach((b) => b.classList.remove('active'));
    svg.querySelector(`.bar[data-i="${i}"]`)?.classList.add('active');
    tip.innerHTML = `<div class="t">${esc(v.title)}</div>
      <div class="r"><span><i class="dot ${v.type}"></i> ${TYPES[v.type].one}</span><span>${df.format(v.published)}</span></div>
      <div class="r"><span>Views</span><b class="num">${fmt(v.views)}</b></div>
      <div class="r"><span>Views / day</span><b class="num">${fmt(viewsPerDay(v))}</b></div>`;
    tip.hidden = false;
    const tx = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${tx}px`;
    const below = e.clientY + 14;
    tip.style.top = `${below + tip.offsetHeight > window.innerHeight - 8 ? e.clientY - tip.offsetHeight - 14 : below}px`;
  });
  const hide = () => { tip.hidden = true; chart.classList.remove('hovering'); };
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('click', (e) => {
    const i = e.target.dataset?.i;
    if (i != null) window.open(videoUrl(list[+i]), '_blank', 'noopener');
  });
}

const viewsPerDay = (v) => v.views / Math.max(1, (Date.now() - v.published) / DAY);
const videoUrl = (v) => (v.type === 'short' ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`);

function videoTable(list, { perDay = false } = {}) {
  const rows = list.map((v) => `<tr>
      <td><div class="vid ${v.type === 'short' ? 'shortthumb' : ''}">
        <img loading="lazy" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" alt="">
        <a href="${videoUrl(v)}" target="_blank" rel="noopener">${esc(v.title)}</a></div></td>
      <td><span class="badge ${v.state === 'live' ? 'now' : ''}"><i class="dot ${v.type}"></i>${v.state === 'live' ? 'LIVE NOW' : v.state === 'upcoming' ? 'Upcoming' : TYPES[v.type].one}</span></td>
      <td class="num date" title="${new Date(v.published).toLocaleString()}">${df.format(v.published)}<div class="muted small">${ago(v.published)}</div></td>
      <td class="r num">${fmtDuration(v.duration)}</td>
      <td class="r num"><b>${fmt(v.views)}</b></td>
      ${perDay ? `<td class="r num">${fmt(viewsPerDay(v))}</td>` : ''}
      <td class="r num">${v.likes == null ? '—' : fmt(v.likes)}</td>
      <td class="r num">${v.comments == null ? '—' : fmt(v.comments)}</td>
    </tr>`).join('');
  return `<div class="table-scroll"><table>
    <thead><tr><th>Video</th><th>Type</th><th>Published</th><th class="r">Length</th><th class="r">Views</th>
      ${perDay ? '<th class="r">Views / day</th>' : ''}<th class="r">Likes</th><th class="r">Comments</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderFilter() {
  const counts = byType(state.videos);
  const opts = [['all', 'All', state.videos.length], ...TYPE_KEYS.map((t) => [t, TYPES[t].label, counts[t].length])];
  $('#typeFilter').innerHTML = opts.map(([k, label, n]) =>
    `<button type="button" role="tab" data-k="${k}" aria-selected="${state.filter === k}">${label} <span class="muted num">${fmt(n)}</span></button>`).join('');
}

function filteredSorted() {
  const list = state.filter === 'all' ? [...state.videos] : state.videos.filter((v) => v.type === state.filter);
  const cmp = {
    views: (a, b) => b.views - a.views,
    least: (a, b) => a.views - b.views,
    new: (a, b) => b.published - a.published,
    old: (a, b) => a.published - b.published,
  }[state.sort];
  return list.sort(cmp);
}

function renderAllTable() {
  const list = filteredSorted();
  $('#allTable').innerHTML = list.length ? videoTable(list.slice(0, state.shown)) : '<div class="empty">No videos.</div>';
  const btn = $('#moreBtn');
  btn.hidden = list.length <= state.shown;
  btn.textContent = `Show more (${fmt(list.length - state.shown)} left)`;
}

function exportCsv() {
  const list = filteredSorted();
  const cell = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines = [['Video ID', 'Type', 'Title', 'Published', 'Duration (s)', 'Views', 'Likes', 'Comments', 'URL'].map(cell).join(',')];
  for (const v of list) {
    lines.push([v.id, TYPES[v.type].one, v.title, new Date(v.published).toISOString(), v.duration, v.views, v.likes, v.comments, videoUrl(v)].map(cell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.channel.title.replace(/[^\w-]+/g, '_')}_${state.filter}_videos.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- best time to publish ----------

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BLOCK_HOURS = 3; // 8 blocks of 3 hours per day

function blockLabel(b) {
  const f = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
  return `${f(b * BLOCK_HOURS)}–${f(((b + 1) * BLOCK_HOURS) % 24)}`;
}

function renderBestTime() {
  const type = $('#btType').value, windowDays = +$('#btWindow').value;
  const now = Date.now();
  // Skip videos under a week old (still collecting views) and scheduled streams.
  const list = state.videos.filter((v) => (type === 'all' || v.type === type) && v.state !== 'upcoming'
    && now - v.published >= 7 * DAY && (!windowDays || now - v.published <= windowDays * DAY));

  const blocks = 24 / BLOCK_HOURS;
  const cells = WEEKDAYS.map(() => Array.from({ length: blocks }, () => []));
  const days = WEEKDAYS.map(() => []);
  for (const v of list) {
    const d = new Date(v.published);
    const day = (d.getDay() + 6) % 7;
    cells[day][Math.floor(d.getHours() / BLOCK_HOURS)].push(v.views);
    days[day].push(v.views);
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('#btNote').textContent = `Median views of ${fmt(list.length)} uploads by the day and time they were published (your time zone: ${tz}). ` +
    'Videos younger than 7 days are left out.';

  if (list.length < 5) {
    $('#btBest').innerHTML = '';
    $('#btHeat').innerHTML = '<div class="empty">Not enough uploads in this window to find a pattern.</div>';
    $('#btDays').innerHTML = '';
    return;
  }

  const slots = [];
  cells.forEach((row, d) => row.forEach((views, b) => views.length && slots.push({ d, b, n: views.length, med: median(views) })));
  const minCount = slots.some((s) => s.n >= 2) ? 2 : 1;
  const best = slots.filter((s) => s.n >= minCount).sort((a, b) => b.med - a.med).slice(0, 3);
  $('#btBest').innerHTML = best.map((s, i) => `<div class="card">
      <div class="label">${i === 0 ? 'Best slot' : `#${i + 1}`}</div>
      <div class="big">${WEEKDAYS[s.d]} <span style="font-size:15px">${blockLabel(s.b)}</span></div>
      <div class="exact num">Median ${compact(s.med)} views · ${s.n} upload${s.n > 1 ? 's' : ''}</div>
    </div>`).join('');

  // Heatmap: one blue hue, light → dark by log(median views).
  const meds = slots.map((s) => s.med).filter((m) => m > 0);
  const lo = Math.log(Math.min(...meds) + 1), hi = Math.log(Math.max(...meds) + 1);
  const shade = (m) => (hi > lo ? (Math.log(m + 1) - lo) / (hi - lo) : 1);
  let html = `<div class="heat" style="grid-template-columns: 40px repeat(${blocks}, minmax(28px, 1fr))"><div></div>`;
  for (let b = 0; b < blocks; b++) html += `<div class="heat-h">${new Date(2000, 0, 1, b * BLOCK_HOURS).toLocaleTimeString([], { hour: 'numeric' })}</div>`;
  cells.forEach((row, d) => {
    html += `<div class="heat-d">${WEEKDAYS[d]}</div>`;
    row.forEach((views, b) => {
      if (!views.length) { html += '<div class="heat-c empty-c"></div>'; return; }
      const t = shade(median(views));
      html += `<div class="heat-c" data-d="${d}" data-b="${b}" style="background:color-mix(in oklab, var(--seq-hi) ${Math.round(15 + t * 85)}%, var(--seq-lo))"></div>`;
    });
  });
  html += '</div><div class="heat-legend"><span>Fewer views</span><i></i><span>More views</span><span class="muted">· blank = no uploads</span></div>';
  $('#btHeat').innerHTML = html;

  const heat = $('#btHeat .heat');
  const tip = $('#tooltip');
  heat.onmousemove = (e) => {
    const c = e.target.closest('.heat-c[data-d]');
    if (!c) { tip.hidden = true; return; }
    const views = cells[+c.dataset.d][+c.dataset.b];
    tip.innerHTML = `<div class="t">${WEEKDAYS[+c.dataset.d]} ${blockLabel(+c.dataset.b)}</div>
      <div class="r"><span>Uploads</span><b class="num">${views.length}</b></div>
      <div class="r"><span>Median views</span><b class="num">${fmt(median(views))}</b></div>
      <div class="r"><span>Best</span><b class="num">${fmt(Math.max(...views))}</b></div>`;
    tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${e.clientY + 14 + tip.offsetHeight > window.innerHeight - 8 ? e.clientY - tip.offsetHeight - 14 : e.clientY + 14}px`;
  };
  heat.onmouseleave = () => { tip.hidden = true; };

  const dayMeds = days.map((v) => (v.length ? median(v) : 0));
  const maxDay = Math.max(...dayMeds, 1);
  $('#btDays').innerHTML = `<div class="days-title">By weekday</div>` + WEEKDAYS.map((d, i) => `
    <div class="day-row" title="${days[i].length} uploads · median ${fmt(dayMeds[i])} views">
      <span class="day-name">${d}</span>
      <span class="day-bar"><span style="width:${(dayMeds[i] / maxDay) * 100}%"></span></span>
      <span class="day-val num">${days[i].length ? compact(dayMeds[i]) : '—'}</span>
      <span class="day-n muted num">${days[i].length}</span>
    </div>`).join('');
}

// ---------- wiring ----------

async function init() {
  state.key = (await store.get('apiKey')) || '';
  $('#keyInput').value = state.key;

  $('#keyBtn').onclick = () => { $('#keyPanel').hidden = !$('#keyPanel').hidden; };
  $('#keyForm').onsubmit = async (e) => {
    e.preventDefault();
    state.key = $('#keyInput').value.trim();
    await store.set('apiKey', state.key);
    $('#keyPanel').hidden = !!state.key;
    setStatus('');
    if (state.key && $('#q').value.trim()) analyze($('#q').value);
  };
  $('#lookup').onsubmit = (e) => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (!q) return;
    history.replaceState(null, '', `?src=${encodeURIComponent(q)}`);
    analyze(q);
  };
  const settings = await YT.getSettings();
  $('#setPanel').checked = settings.videoPanel;
  $('#setBadges').checked = settings.badges;
  const saveSettings = () => store.set('settings', { videoPanel: $('#setPanel').checked, badges: $('#setBadges').checked });
  $('#setPanel').onchange = saveSettings;
  $('#setBadges').onchange = saveSettings;

  $('#period').onchange = () => state.channel && renderPeriod();
  $('#btType').onchange = $('#btWindow').onchange = () => state.channel && renderBestTime();
  $('#sort').onchange = () => { state.sort = $('#sort').value; state.shown = PAGE; renderAllTable(); };
  $('#typeFilter').onclick = (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    state.filter = b.dataset.k;
    state.shown = PAGE;
    renderFilter();
    renderAllTable();
  };
  $('#moreBtn').onclick = () => { state.shown += PAGE * 2; renderAllTable(); };
  $('#csvBtn').onclick = exportCsv;
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.channel && renderPeriod(), 150);
  });

  const params = new URLSearchParams(location.search);
  const src = params.get('src');
  if (!state.key || params.has('settings')) $('#keyPanel').hidden = false;
  if (src && parseInput(src)) {
    $('#q').value = src;
    analyze(src);
  } else if (src) {
    setStatus("This tab isn't a YouTube channel or video. Paste a channel link above.");
  } else {
    $('#q').focus();
  }
}

init();
