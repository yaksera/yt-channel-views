'use strict';

const { api, suggest, DAY, fmt, compact, esc, sum, ago, df, parseDuration, fmtDuration, viewsPerDay, pool } = YT;
const $ = (sel) => document.querySelector(sel);

const SHORT_MAX = 180; // Shorts can be up to 3 minutes long
const MAX_PAGES = 10;  // YouTube search stops returning results after ~500 per query
const KINDS = { long: 'Long videos', short: 'Shorts' };
const state = { run: 0, stop: false, q: '', lists: { long: [], short: [] }, kinds: [], tab: 'long', sort: 'views', units: 0, variants: null, mined: [] };

function setStatus(html, { error = false, progress = null } = {}) {
  const el = $('#status');
  el.hidden = !html;
  el.className = 'status' + (error ? ' error' : '');
  el.innerHTML = html + (progress != null ? `<div class="bar"><span style="width:${Math.round(progress * 100)}%"></span></div>` : '');
}

// YouTube serves /shorts/ID with 200 for a real Short and redirects (303) for a normal video.
const shortCache = new Map();
async function isShort(id, duration) {
  if (shortCache.has(id)) return shortCache.get(id);
  let short;
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, { method: 'HEAD', redirect: 'manual', credentials: 'include' });
    short = r.status === 200;
  } catch {
    short = duration <= 60; // network problem: fall back to the classic 60-second rule
  }
  shortCache.set(id, short);
  return short;
}

function toVideo(v) {
  const views = +v.statistics?.viewCount || 0;
  const published = Date.parse(v.snippet.publishedAt);
  return {
    id: v.id,
    title: v.snippet.title,
    channel: v.snippet.channelTitle,
    channelId: v.snippet.channelId,
    state: v.snippet.liveBroadcastContent,
    views,
    likes: v.statistics?.likeCount != null ? +v.statistics.likeCount : null,
    comments: v.statistics?.commentCount != null ? +v.statistics.commentCount : null,
    published,
    vpd: viewsPerDay(views, published),
    duration: parseDuration(v.contentDetails?.duration),
    tags: v.snippet.tags || [],
  };
}

// Pages through "order by view count" search results until `want` videos of `kind` are found.
// Videos of the other kind that turn up are kept too, so a combined run wastes less quota.
async function collect(kind, opts, maps, onPage) {
  const params = {
    part: 'id', q: opts.q, type: 'video', order: 'viewCount', maxResults: 50,
    videoDuration: kind === 'short' ? 'short' : undefined,
    regionCode: opts.region || undefined,
    publishedAfter: opts.since ? new Date(Date.now() - opts.since * DAY).toISOString() : undefined,
    fields: 'nextPageToken,items/id/videoId',
  };
  let pageToken;
  for (let page = 0; page < MAX_PAGES && maps[kind].size < opts.want; page++) {
    if (state.stop) return;
    const r = await api('search', { ...params, pageToken });
    state.units += 100;
    const ids = (r.items || []).map((it) => it.id?.videoId).filter((id) => id && !maps.long.has(id) && !maps.short.has(id));
    if (ids.length) {
      const vr = await api('videos', {
        part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50,
        fields: 'items(id,snippet(title,publishedAt,channelId,channelTitle,liveBroadcastContent,tags),statistics(viewCount,likeCount,commentCount),contentDetails/duration)',
      });
      state.units += 1;
      const videos = (vr.items || []).map(toVideo).filter((v) => v.state !== 'upcoming');
      await pool(videos, 8, async (v) => {
        v.type = v.duration > 0 && v.duration <= SHORT_MAX && (await isShort(v.id, v.duration)) ? 'short' : 'long';
      });
      for (const v of videos) {
        // The unfiltered (long) search also yields top Shorts worth keeping; the Shorts search's
        // non-Shorts are just short normal videos, which would crowd out better long results.
        const keep = v.type === kind || kind === 'long';
        if (keep && opts.kinds.includes(v.type) && maps[v.type].size < opts.want) maps[v.type].set(v.id, v);
      }
    }
    onPage();
    pageToken = r.nextPageToken;
    if (!pageToken) return;
  }
}

async function run(e) {
  e?.preventDefault();
  const q = $('#kw').value.trim();
  if (!q) return;
  const opts = {
    q,
    want: +$('#want').value,
    since: +$('#since').value,
    region: $('#region').value,
    kinds: $('#type').value === 'both' ? ['long', 'short'] : [$('#type').value],
  };
  const runId = ++state.run;
  Object.assign(state, { stop: false, q, units: 0, kinds: opts.kinds, tab: opts.kinds[0] });
  history.replaceState(null, '', `?q=${encodeURIComponent(q)}`);
  document.title = `${q} · Top Videos`;
  $('#results').hidden = true;
  $('#goBtn').disabled = true;
  $('#stopBtn').hidden = false;

  const variantsPromise = keywordVariants(q, opts.region);
  $('#related').hidden = true;
  const maps = { long: new Map(), short: new Map() };
  const progress = () => {
    if (runId !== state.run) return;
    const done = sum(opts.kinds, (k) => Math.min(maps[k].size, opts.want));
    setStatus(`Searching <b>${esc(q)}</b>… ` + opts.kinds.map((k) => `${KINDS[k]}: ${fmt(maps[k].size)}/${opts.want}`).join(' · ') +
      ` · ~${fmt(state.units)} API units used`, { progress: done / (opts.want * opts.kinds.length) });
  };
  progress();

  // Wait for both searches; if one fails (e.g. quota), tell the other to stop.
  let error = null;
  await Promise.allSettled(opts.kinds.map((k) => collect(k, opts, maps, progress).catch((err) => {
    error ??= err;
    state.stop = true;
  })));
  const userStopped = state.stop && !error;
  if (runId !== state.run) return;
  $('#goBtn').disabled = false;
  $('#stopBtn').hidden = true;

  for (const k of Object.keys(maps)) state.lists[k] = [...maps[k].values()];
  const total = sum(opts.kinds, (k) => state.lists[k].length);
  if (error && !total) return setStatus(esc(error.message) + (error.reason === 'noKey' ? ' <a href="dashboard.html?settings=1">Open settings</a>' : ''), { error: true });

  const notes = [];
  for (const k of opts.kinds) {
    if (state.lists[k].length < opts.want && !state.stop) {
      notes.push(`YouTube returned only ${fmt(state.lists[k].length)} ${KINDS[k].toLowerCase()} for this keyword.`);
    }
  }
  if (error) notes.unshift(`Stopped early: ${esc(error.message)} Showing what was found.`);
  if (userStopped) notes.unshift('Stopped. Showing what was found so far.');
  setStatus(notes.join(' '), { error: !!error });
  render();
  state.mined = mineKeywords(q, opts.kinds.flatMap((k) => state.lists[k]));
  state.variants = await variantsPromise;
  if (runId === state.run) renderRelated();
}

// ---------- related keywords ----------

const MODIFIERS = ['how to', 'best', 'top', 'new', 'latest', 'why', 'what is'];

// Keyword variants from YouTube autocomplete: direct suggestions, question/modifier forms and A–Z expansions.
async function keywordVariants(q, gl) {
  const groups = { top: [], modifiers: [], az: [] };
  const seen = new Set([q.toLowerCase()]);
  const add = (group, list) => {
    for (const x of list) {
      const k = x.toLowerCase().trim();
      if (k && !seen.has(k)) { seen.add(k); groups[group].push(x); }
    }
  };
  const queries = [
    ['top', q],
    ...MODIFIERS.map((m) => ['modifiers', `${m} ${q}`]),
    ['modifiers', `${q} ${new Date().getFullYear()}`],
    ['modifiers', `${q} vs`],
    ['modifiers', `${q} for`],
    ...'abcdefghijklmnopqrstuvwxyz'.split('').map((l) => ['az', `${q} ${l}`]),
  ];
  const results = new Array(queries.length);
  await pool(queries.map((x, i) => i), 6, async (i) => { results[i] = await suggest(queries[i][1], { gl }); });
  queries.forEach(([group], i) => add(group, results[i] || [])); // keep autocomplete order
  return groups;
}

// Words that can't start or end a keyword phrase (English + common Hindi/Nepali connectors).
const EDGE_STOP = new Set(('a an the and or of to in on for with by at from is are was be this that it its as your you my me i we our ' +
  'vs ft feat x ka ki ke ko hai se me mein na aur ra le lai ma').split(' '));
// Words that make a phrase pointless at its edges or on their own.
const EDGE_JUNK = new Set(['official', 'video', 'videos', 'hd', '4k', 'full', 'shorts', 'short', 'live']);
const JUNK = new Set([...EDGE_JUNK, 'new', 'latest']);
// Title separators: "|", " - ", brackets, punctuation, hashtags and "ft." start a new segment.
const SEGMENT = /\s+[-–—]+\s+|[|()[\]{}:;,.!?#/"“”]+|\s(?:ft|feat)\b\.?/u;

function phrasesOf(v) {
  const out = new Set();
  const words = (text) => text.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
  const edgeOk = (w) => !EDGE_STOP.has(w) && !EDGE_JUNK.has(w);
  const ok = (ws) => edgeOk(ws[0]) && edgeOk(ws[ws.length - 1]) && !ws.every((w) => JUNK.has(w) || /^\d+$/.test(w));
  for (const segment of v.title.toLowerCase().split(SEGMENT)) {
    const t = words(segment);
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= t.length; i++) {
        const ws = t.slice(i, i + n);
        if (ok(ws)) out.add(ws.join(' '));
      }
    }
  }
  for (const tag of v.tags) {
    const ws = words(tag);
    if (ws.length && ws.length <= 5 && ok(ws)) out.add(ws.join(' '));
  }
  return out;
}

// Phrases that keep appearing in the titles and tags of the videos found, ranked by those videos' total views.
function mineKeywords(q, videos) {
  const stats = new Map();
  for (const v of videos) {
    for (const p of phrasesOf(v)) {
      const s = stats.get(p) || { phrase: p, count: 0, views: 0 };
      s.count++;
      s.views += v.views;
      stats.set(p, s);
    }
  }
  const qn = q.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean).join(' ');
  const minCount = videos.length >= 60 ? 3 : 2;
  let list = [...stats.values()].filter((s) => s.count >= minCount && s.phrase !== qn);
  // Drop a phrase when a longer phrase containing it covers (almost) the same videos.
  list = list.filter((s) => !list.some((o) => o !== s && o.phrase.length > s.phrase.length
    && ` ${o.phrase} `.includes(` ${s.phrase} `) && o.count >= s.count * 0.9));
  return list.sort((a, b) => b.views - a.views).slice(0, 40);
}

function renderRelated() {
  const sec = $('#related');
  sec.hidden = false;
  const chip = (text) => `<button type="button" class="chip" data-q="${esc(text)}">${esc(text)}</button>`;

  const mined = state.mined;
  const maxViews = Math.max(1, ...mined.map((m) => m.views));
  $('#mined').innerHTML = mined.length ? `<div class="kw-list">${mined.map((m, i) => `
      <button type="button" class="kw-row" data-q="${esc(m.phrase)}" title="${fmt(m.views)} total views">
        <span class="kw-rank num">${i + 1}</span>
        <span class="kw-name">${esc(m.phrase)}</span>
        <span class="kw-bar"><span style="width:${(m.views / maxViews) * 100}%"></span></span>
        <span class="kw-views num">${compact(m.views)}</span>
        <span class="kw-count muted num">${m.count} videos</span>
      </button>`).join('')}</div>`
    : `<div class="muted small">${state.lists.long.length + state.lists.short.length ? 'No repeated keywords found in these videos.' : 'Click "Find videos" to see the keywords used by the most viewed videos.'}</div>`;

  const v = state.variants || { top: [], modifiers: [], az: [] };
  const group = (title, list) => (list.length ? `<div class="kw-group"><div class="kw-group-title">${title} <span class="muted">${list.length}</span></div><div class="chips">${list.map(chip).join('')}</div></div>` : '');
  $('#variants').innerHTML = group('Top searches', v.top) + group('Questions &amp; modifiers', v.modifiers) + group('A–Z variants', v.az)
    || '<div class="muted small">YouTube has no autocomplete suggestions for this keyword.</div>';
}

async function relatedOnly() {
  const q = $('#kw').value.trim();
  if (!q) return $('#kw').focus();
  const runId = ++state.run;
  state.q = q;
  history.replaceState(null, '', `?q=${encodeURIComponent(q)}`);
  $('#results').hidden = true;
  $('#relatedBtn').disabled = true;
  setStatus(`Finding keywords related to <b>${esc(q)}</b>…`);
  const variants = await keywordVariants(q, $('#region').value);
  $('#relatedBtn').disabled = false;
  if (runId !== state.run) return;
  Object.assign(state, { variants, mined: [], lists: { long: [], short: [] } });
  setStatus('');
  renderRelated();
}

function copyList(which) {
  const list = which === 'mined' ? state.mined.map((m) => m.phrase)
    : Object.values(state.variants || {}).flat();
  return navigator.clipboard.writeText(list.join(', '));
}

function render() {
  $('#results').hidden = false;
  const card = (k) => {
    const list = state.lists[k];
    const views = sum(list, (v) => v.views);
    const top = list.reduce((b, v) => (!b || v.views > b.views ? v : b), null);
    return `<div class="card">
      <div class="label"><span class="dot ${k}"></span>${KINDS[k]}</div>
      <div class="big num" title="${fmt(views)} views">${compact(views)}</div>
      <div class="exact num">${fmt(views)} total views</div>
      <div class="rows">
        <div><span>Videos found</span><b class="num">${fmt(list.length)}</b></div>
        <div><span>Avg views</span><b class="num">${list.length ? compact(views / list.length) : '—'}</b></div>
        <div><span>Most viewed</span><b class="num">${top ? compact(top.views) : '—'}</b></div>
      </div></div>`;
  };
  $('#summary').innerHTML = state.kinds.map(card).join('') + `<div class="card">
      <div class="label">Search</div>
      <div class="big" style="font-size:20px">${esc(state.q)}</div>
      <div class="rows"><div><span>API units used</span><b class="num">~${fmt(state.units)}</b></div>
      <div><span>Daily free limit</span><b class="num">10,000</b></div></div></div>`;
  $('#tabs').innerHTML = state.kinds.map((k) =>
    `<button type="button" role="tab" data-k="${k}" aria-selected="${state.tab === k}">${KINDS[k]} <span class="muted num">${fmt(state.lists[k].length)}</span></button>`).join('');
  renderTable();
}

function sorted(list) {
  const cmp = { views: (a, b) => b.views - a.views, vpd: (a, b) => b.vpd - a.vpd, new: (a, b) => b.published - a.published }[state.sort];
  return [...list].sort(cmp);
}

const videoUrl = (v) => (v.type === 'short' ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`);

function renderTable() {
  const list = sorted(state.lists[state.tab]);
  if (!list.length) { $('#table').innerHTML = '<div class="empty">No videos found.</div>'; return; }
  $('#table').innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th>#</th><th>Video</th><th>Channel</th><th class="r">Views</th><th class="r">Views / day</th><th class="r">Likes</th><th>Published</th><th class="r">Length</th></tr></thead>
    <tbody>${list.map((v, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td><div class="vid ${v.type === 'short' ? 'shortthumb' : ''}"><img loading="lazy" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" alt="">
        <a href="${videoUrl(v)}" target="_blank" rel="noopener">${esc(v.title)}</a></div></td>
      <td><a href="https://www.youtube.com/channel/${esc(v.channelId)}" target="_blank" rel="noopener">${esc(v.channel)}</a></td>
      <td class="r num"><b>${fmt(v.views)}</b></td>
      <td class="r num">${fmt(v.vpd)}</td>
      <td class="r num">${v.likes == null ? '—' : fmt(v.likes)}</td>
      <td class="num date">${df.format(v.published)}<div class="muted small">${ago(v.published)}</div></td>
      <td class="r num">${v.state === 'live' ? 'LIVE' : fmtDuration(v.duration)}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function exportCsv() {
  const cell = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines = [['Type', 'Rank', 'Title', 'Channel', 'Views', 'Views per day', 'Likes', 'Comments', 'Published', 'Duration (s)', 'URL'].map(cell).join(',')];
  for (const k of state.kinds) {
    sorted(state.lists[k]).forEach((v, i) => lines.push([KINDS[k], i + 1, v.title, v.channel, v.views, Math.round(v.vpd), v.likes, v.comments,
      new Date(v.published).toISOString().slice(0, 10), v.duration, videoUrl(v)].map(cell).join(',')));
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `${state.q.replace(/[^\p{L}\p{N}]+/gu, '_')}_top_videos.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function updateEstimate() {
  const kinds = $('#type').value === 'both' ? 2 : 1;
  const pages = Math.ceil(+$('#want').value / 50);
  const lo = kinds * pages * 101, hi = kinds * MAX_PAGES * 101;
  $('#estimate').textContent = `Uses about ${fmt(lo)}–${fmt(hi)} API units per search (your free limit is 10,000 a day). ` +
    'YouTube search returns at most ~500 results per keyword, so rare keywords give fewer videos.';
}

$('#topForm').onsubmit = run;
$('#relatedBtn').onclick = relatedOnly;
$('#related').onclick = async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await copyList(copy.dataset.copy);
    copy.textContent = 'Copied!';
    setTimeout(() => { copy.textContent = 'Copy all'; }, 1500);
    return;
  }
  const kw = e.target.closest('[data-q]');
  if (!kw) return;
  $('#kw').value = kw.dataset.q;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#kw').focus();
};
$('#stopBtn').onclick = () => { state.stop = true; $('#stopBtn').hidden = true; };
$('#type').onchange = $('#want').onchange = updateEstimate;
$('#sort').onchange = () => { state.sort = $('#sort').value; renderTable(); };
$('#csvBtn').onclick = exportCsv;
$('#tabs').onclick = (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  state.tab = b.dataset.k;
  render();
};

updateEstimate();
const initial = new URLSearchParams(location.search).get('q');
if (initial) { $('#kw').value = initial; $('#goBtn').focus(); } else $('#kw').focus();
