'use strict';

const { api, DAY, fmt, compact, esc, sum, ago, df, parseDuration, fmtDuration, viewsPerDay, pool } = YT;
const $ = (sel) => document.querySelector(sel);

const SHORT_MAX = 180; // Shorts can be up to 3 minutes long
const MAX_PAGES = 10;  // YouTube search stops returning results after ~500 per query
const KINDS = { long: 'Long videos', short: 'Shorts' };
const state = { run: 0, stop: false, q: '', lists: { long: [], short: [] }, kinds: [], tab: 'long', sort: 'views', units: 0 };

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
        fields: 'items(id,snippet(title,publishedAt,channelId,channelTitle,liveBroadcastContent),statistics(viewCount,likeCount,commentCount),contentDetails/duration)',
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
