'use strict';

const { api, fmt, compact, pct, esc, clamp, ago, df, median, viewsPerDay, pool } = YT;
const $ = (sel) => document.querySelector(sel);
const state = { q: '', run: 0, topTags: [] };

function setStatus(html, error = false) {
  const el = $('#status');
  el.hidden = !html;
  el.className = 'status' + (error ? ' error' : '');
  el.innerHTML = html;
}

async function suggest(q) {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, { credentials: 'omit' });
    const body = JSON.parse(await r.text());
    return Array.isArray(body?.[1]) ? body[1].map(String) : [];
  } catch {
    return [];
  }
}

const label = (score) => (score >= 80 ? 'Excellent' : score >= 60 ? 'Very good' : score >= 40 ? 'Good' : score >= 20 ? 'Fair' : 'Poor');
const tone = (score, invert = false) => {
  const s = invert ? 100 - score : score;
  return s >= 60 ? 'up' : s >= 35 ? '' : 'down';
};

async function explore(q) {
  q = q.trim();
  if (!q) return;
  const run = ++state.run;
  const alive = () => run === state.run;
  state.q = q;
  $('#kw').value = q;
  history.replaceState(null, '', `?q=${encodeURIComponent(q)}`);
  document.title = `${q} · Keyword Explorer`;
  $('#results').hidden = true;
  $('#longtail').innerHTML = '';
  $('#longtailBtn').hidden = false;
  setStatus(`Searching YouTube for <b>${esc(q)}</b>…`);

  try {
    const [suggestions, search] = await Promise.all([
      suggest(q),
      api('search', { part: 'id', q, type: 'video', maxResults: 25, fields: 'pageInfo/totalResults,items/id/videoId' }),
    ]);
    if (!alive()) return;
    const ids = (search.items || []).map((it) => it.id.videoId).filter(Boolean);
    setStatus('Fetching stats of top videos…');
    const vr = ids.length ? await api('videos', {
      part: 'snippet,statistics', id: ids.join(','), maxResults: 50,
      fields: 'items(id,snippet(title,publishedAt,channelId,channelTitle,tags),statistics(viewCount,likeCount,commentCount))',
    }) : { items: [] };
    const channelIds = [...new Set((vr.items || []).map((v) => v.snippet.channelId))];
    const cr = channelIds.length ? await api('channels', {
      part: 'statistics', id: channelIds.join(','), maxResults: 50,
      fields: 'items(id,statistics(subscriberCount,hiddenSubscriberCount))',
    }) : { items: [] };
    if (!alive()) return;

    const subs = new Map((cr.items || []).map((c) => [c.id, c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount]));
    const order = new Map(ids.map((id, i) => [id, i]));
    const ql = q.toLowerCase();
    const videos = (vr.items || []).map((v) => {
      const views = +v.statistics?.viewCount || 0;
      const published = Date.parse(v.snippet.publishedAt);
      return {
        id: v.id,
        rank: order.get(v.id) + 1,
        title: v.snippet.title,
        channel: v.snippet.channelTitle,
        subs: subs.get(v.snippet.channelId) ?? null,
        views,
        published,
        vpd: viewsPerDay(views, published),
        tags: v.snippet.tags || [],
        match: v.snippet.title.toLowerCase().includes(ql),
      };
    }).sort((a, b) => a.rank - b.rank);

    render(q, videos, suggestions, search.pageInfo?.totalResults);
    setStatus('');
  } catch (e) {
    if (alive()) {
      setStatus(esc(e.message) + (e.reason === 'noKey' ? ' <a href="dashboard.html?settings=1">Open settings</a>' : ''), true);
    }
  }
}

function scores(videos) {
  const top = videos.slice(0, 10);
  if (!top.length) return { demand: 0, competition: 0, overall: 0, exact: 0, vpd: 0, subs: 0 };
  // Demand: median views/day of the top 10 results, log scale (1/day → 0, 100K/day → 100).
  const vpd = median(top.map((v) => v.vpd));
  const demand = clamp((Math.log10(Math.max(vpd, 1)) / 5) * 100);
  // Competition: how big the ranking channels are (1K subs → 0, 10M → 100) and how many titles target the exact phrase.
  const subs = median(top.map((v) => v.subs).filter((n) => n != null)) || 0;
  const subsScore = clamp(((Math.log10(Math.max(subs, 1)) - 3) / 4) * 100);
  const exact = top.filter((v) => v.match).length / top.length;
  const competition = 0.7 * subsScore + 0.3 * exact * 100;
  const overall = 0.5 * demand + 0.5 * (100 - competition);
  return { demand: Math.round(demand), competition: Math.round(competition), overall: Math.round(overall), exact, vpd, subs };
}

function render(q, videos, suggestions, total) {
  $('#results').hidden = false;
  $('#kwTitle').textContent = `"${q}"`;
  const s = scores(videos);
  const card = (title, score, sub, invert = false) => `
    <div class="card">
      <div class="label">${title}</div>
      <div class="big num ${tone(score, invert)}">${score}<span class="muted" style="font-size:14px">/100</span></div>
      <div class="exact">${sub}</div>
      <div class="share"><span style="width:${score}%;background:var(--text-2)"></span></div>
    </div>`;
  $('#scoreCards').innerHTML =
    card('Overall', s.overall, label(s.overall)) +
    card('Search demand', s.demand, `Top videos get ~${compact(s.vpd)} views/day`) +
    card('Competition', s.competition, `Median channel: ${compact(s.subs)} subs`, true) +
    card('Exact-match titles', Math.round(s.exact * 100), `${Math.round(s.exact * 10)} of top 10 use the exact phrase`, true);
  $('#scoreNote').textContent =
    `${total ? `About ${fmt(total)} results. ` : ''}Higher overall = more demand with weaker competition. ` +
    'Scores are estimates from public data (YouTube does not publish search volume).';

  const chip = (text, extra = '') => `<button type="button" class="chip" data-q="${esc(text)}">${esc(text)}${extra}</button>`;
  $('#suggestions').innerHTML = suggestions.filter((x) => x.toLowerCase() !== q.toLowerCase()).map((x) => chip(x)).join('')
    || '<span class="muted small">No suggestions — this phrase is rarely searched.</span>';

  const counts = new Map();
  for (const v of videos) for (const t of new Set(v.tags.map((x) => x.toLowerCase().trim()))) counts.set(t, (counts.get(t) || 0) + 1);
  state.topTags = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 40);
  $('#tags').innerHTML = state.topTags.map(([t, n]) => chip(t, ` <span class="muted">${n}</span>`)).join('')
    || '<span class="muted small">Top videos share no common tags.</span>';
  $('#copyTags').hidden = !state.topTags.length;

  $('#topTable').innerHTML = videos.length ? `<div class="table-scroll"><table>
    <thead><tr><th>#</th><th>Video</th><th>Channel</th><th class="r">Subs</th><th class="r">Views</th><th class="r">Views / day</th><th>Published</th><th>Exact match</th></tr></thead>
    <tbody>${videos.map((v) => `<tr>
      <td class="num">${v.rank}</td>
      <td><div class="vid"><img loading="lazy" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" alt="">
        <a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">${esc(v.title)}</a></div></td>
      <td>${esc(v.channel)}</td>
      <td class="r num">${v.subs == null ? 'Hidden' : compact(v.subs)}</td>
      <td class="r num"><b>${fmt(v.views)}</b></td>
      <td class="r num">${fmt(v.vpd)}</td>
      <td class="num date">${df.format(v.published)}<div class="muted small">${ago(v.published)}</div></td>
      <td>${v.match ? '<span class="up">✓ Yes</span>' : '<span class="muted">No</span>'}</td>
    </tr>`).join('')}</tbody></table></div>` : '<div class="empty">No videos found.</div>';
}

async function findLongtail() {
  const q = state.q, run = state.run;
  const btn = $('#longtailBtn');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  const found = new Set();
  const seen = new Set([...document.querySelectorAll('#suggestions .chip')].map((c) => c.dataset.q.toLowerCase()));
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  await pool(letters, 6, async (l) => {
    for (const s of await suggest(`${q} ${l}`)) {
      const k = s.toLowerCase();
      if (k !== q.toLowerCase() && !seen.has(k)) found.add(s);
    }
  });
  if (run !== state.run) return;
  btn.disabled = false;
  btn.textContent = 'Find A–Z ideas';
  btn.hidden = true;
  $('#longtail').innerHTML = [...found].map((x) => `<button type="button" class="chip" data-q="${esc(x)}">${esc(x)}</button>`).join('')
    || '<span class="muted small">No long-tail ideas found.</span>';
}

$('#kwForm').onsubmit = (e) => { e.preventDefault(); explore($('#kw').value); };
$('#longtailBtn').onclick = findLongtail;
$('#copyTags').onclick = async () => {
  await navigator.clipboard.writeText(state.topTags.map(([t]) => t).join(', '));
  $('#copyTags').textContent = 'Copied!';
  setTimeout(() => { $('#copyTags').textContent = 'Copy top tags'; }, 1500);
};
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-q]');
  if (chip) { window.scrollTo({ top: 0 }); explore(chip.dataset.q); }
});

const initial = new URLSearchParams(location.search).get('q');
if (initial) explore(initial); else $('#kw').focus();
