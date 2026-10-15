'use strict';
// Runs on youtube.com: the "Video insights" panel on watch pages and stats badges on thumbnails.
// All API calls go through the background worker, which holds the key and caches responses.

(() => {
  const { fmt, compact, pct, esc, clamp, ago, df, parseDuration, fmtDuration, viewsPerDay, chunk } = YT;

  let settings = { ...YT.DEFAULT_SETTINGS };

  function bg(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (r?.error) return reject(Object.assign(new Error(r.error), { reason: r.reason, status: r.status }));
          resolve(r?.data);
        });
      } catch (e) {
        reject(e); // extension was reloaded; this content script is orphaned
      }
    });
  }
  const api = (endpoint, params) => bg({ type: 'api', endpoint, params });
  const openPage = (page, params) => bg({ type: 'open', page, params }).catch(() => {});

  const isDark = () => document.documentElement.hasAttribute('dark');

  // ==================== Video insights panel ====================

  const CATEGORIES = {
    1: 'Film & Animation', 2: 'Autos & Vehicles', 10: 'Music', 15: 'Pets & Animals', 17: 'Sports',
    19: 'Travel & Events', 20: 'Gaming', 22: 'People & Blogs', 23: 'Comedy', 24: 'Entertainment',
    25: 'News & Politics', 26: 'Howto & Style', 27: 'Education', 28: 'Science & Technology', 29: 'Nonprofits & Activism',
  };

  const PANEL_CSS = `
    :host { all: initial; display: block; margin-bottom: 12px;
      --bg: #ffffff; --bg2: #f2f2f2; --border: #e5e5e5; --text: #0f0f0f; --text2: #606060; --text3: #909090;
      --accent: #e62117; --good: #0f7a3d; --bad: #b42318; --warn: #a15c00; --chip: #f2f2f2; --chip-hover: #e5e5e5;
      font: 13px/1.4 Roboto, Arial, sans-serif; color: var(--text); }
    :host([dark]) { --bg: #181818; --bg2: #212121; --border: #303030; --text: #f1f1f1; --text2: #aaaaaa; --text3: #717171;
      --good: #4cc77f; --bad: #ff7b6e; --warn: #f0b429; --chip: #272727; --chip-hover: #3f3f3f; }
    * { box-sizing: border-box; }
    .box { background: var(--bg); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; user-select: none; }
    .head .logo { width: 18px; height: 18px; border-radius: 4px; background: var(--accent); display: grid; place-items: center; }
    .head .logo i { display: block; width: 0; height: 0; border-left: 6px solid #fff; border-top: 4px solid transparent; border-bottom: 4px solid transparent; margin-left: 2px; }
    .head h3 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
    .head .score { font-weight: 700; font-size: 13px; padding: 2px 8px; border-radius: 10px; background: var(--bg2); }
    .head .chev { color: var(--text3); transition: transform .15s; }
    .box.collapsed .chev { transform: rotate(-90deg); }
    .box.collapsed .body { display: none; }
    .body { padding: 0 12px 12px; }
    .muted { color: var(--text2); }
    .small { font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .stat { background: var(--bg2); border-radius: 8px; padding: 7px 8px; min-width: 0; }
    .stat .k { font-size: 11px; color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .stat .v { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .stat .s { font-size: 11px; color: var(--text3); white-space: nowrap; }
    .section { margin-top: 12px; }
    .section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 8px; }
    .section-head b { font-size: 13px; }
    button { font: inherit; font-size: 12px; color: var(--text); background: var(--chip); border: 0; border-radius: 14px; padding: 4px 10px; cursor: pointer; }
    button:hover { background: var(--chip-hover); }
    button.primary { background: var(--accent); color: #fff; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 150px; overflow: auto; }
    .chip { font-size: 12px; background: var(--chip); border-radius: 12px; padding: 3px 9px; cursor: pointer; border: 0; color: var(--text); }
    .chip:hover { background: var(--chip-hover); }
    .meter { height: 5px; border-radius: 3px; background: var(--bg2); overflow: hidden; margin-top: 4px; }
    .meter span { display: block; height: 100%; background: var(--text2); border-radius: 3px; }
    ul.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
    ul.checks li { display: flex; gap: 6px; align-items: baseline; }
    ul.checks .i { width: 14px; flex: none; font-weight: 700; text-align: center; }
    ul.checks .ok { color: var(--good); }
    ul.checks .no { color: var(--bad); }
    ul.checks .tip { color: var(--text3); font-size: 11px; }
    .channel { display: flex; gap: 10px; align-items: center; }
    .channel img { width: 36px; height: 36px; border-radius: 50%; background: var(--bg2); }
    .channel .n { font-weight: 600; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .good { color: var(--good); } .bad { color: var(--bad); } .warn { color: var(--warn); }
    .err { color: var(--bad); }
    .copied { color: var(--good); font-size: 12px; }
  `;

  const panel = { host: null, root: null, videoId: null, collapsed: false };

  function seoChecks(v) {
    const s = v.snippet, title = s.title || '', desc = s.description || '', tags = s.tags || [];
    const lower = (x) => x.toLowerCase();
    const kw = lower(tags[0] || '');
    const words = desc.trim() ? desc.trim().split(/\s+/).length : 0;
    // YouTube counts the tag box like "tag one","tag two" — quotes around multi-word tags, commas between.
    const tagChars = tags.reduce((n, t) => n + t.length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
    const hashtags = (`${title} ${desc}`.match(/#[\p{L}\p{N}_]+/gu) || []).length;
    const checks = [
      { w: 10, ok: title.length >= 30 && title.length <= 70, label: `Title length: ${title.length} chars`, tip: 'Best between 30 and 70' },
      { w: 15, ok: !!kw && lower(title).includes(kw), label: 'Main tag appears in title', tip: kw ? `Main tag: "${tags[0]}"` : 'Video has no tags' },
      { w: 10, ok: !!kw && lower(desc).includes(kw), label: 'Main tag appears in description' },
      { w: 10, ok: words >= 100, label: `Description: ${fmt(words)} words`, tip: 'Aim for 100+ words' },
      { w: 10, ok: tags.length >= 5, label: `${tags.length} tags`, tip: 'Use at least 5 relevant tags' },
      { w: 10, ok: tagChars >= 300, label: `Tag box: ${tagChars}/500 characters used`, tip: 'Use 300+ characters' },
      { w: 5, ok: hashtags >= 1 && hashtags <= 15, label: `${hashtags} hashtags`, tip: 'Use 1–15; more than 15 are ignored' },
      { w: 5, ok: /(^|\s)\(?\d{1,2}:\d{2}(:\d{2})?\)?\s/m.test(desc), label: 'Timestamps / chapters in description' },
      { w: 10, ok: !!s.thumbnails?.maxres, label: 'HD (1280×720) thumbnail' },
      { w: 10, ok: v.contentDetails?.caption === 'true', label: 'Captions uploaded' },
      { w: 5, ok: v.contentDetails?.definition === 'hd', label: 'Video is HD' },
    ];
    const score = checks.reduce((n, c) => n + (c.ok ? c.w : 0), 0);
    return { checks, score, tagChars };
  }

  const scoreClass = (s) => (s >= 70 ? 'good' : s >= 45 ? 'warn' : 'bad');

  async function waitFor(selector, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  function removePanel() {
    panel.host?.remove();
    panel.host = panel.root = null;
    panel.videoId = null;
  }

  async function mountPanel() {
    const parent = await waitFor('ytd-watch-flexy #secondary-inner, ytd-watch-flexy #secondary');
    if (!parent) return false;
    if (!panel.host) {
      panel.host = document.createElement('ycv-insights');
      panel.root = panel.host.attachShadow({ mode: 'open' });
      panel.root.addEventListener('click', onPanelClick);
    }
    if (panel.host.parentElement !== parent) parent.prepend(panel.host);
    panel.host.toggleAttribute('dark', isDark());
    return true;
  }

  function shell(scoreHtml, bodyHtml) {
    panel.root.innerHTML = `<style>${PANEL_CSS}</style>
      <div class="box ${panel.collapsed ? 'collapsed' : ''}">
        <div class="head" data-act="toggle"><span class="logo"><i></i></span><h3>Video insights</h3>${scoreHtml}<span class="chev">▾</span></div>
        <div class="body">${bodyHtml}</div>
      </div>`;
  }

  async function updateVideoPanel() {
    const videoId = location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
    if (!videoId || !settings.videoPanel) return removePanel();
    if (videoId === panel.videoId && panel.host?.isConnected) return;
    panel.videoId = videoId;
    if (!(await mountPanel()) || panel.videoId !== videoId) return;
    shell('', '<div class="muted">Loading stats…</div>');
    try {
      const r = await api('videos', { part: 'snippet,statistics,contentDetails', id: videoId });
      const v = r.items?.[0];
      if (!v) throw new Error('Video not found.');
      const c = (await api('channels', { part: 'snippet,statistics', id: v.snippet.channelId })).items?.[0];
      if (panel.videoId !== videoId) return;
      renderPanel(v, c);
    } catch (e) {
      if (panel.videoId !== videoId || !panel.root) return;
      const noKey = e.reason === 'noKey';
      shell('', `<div class="err">${esc(e.message)}</div>
        ${noKey ? '<div class="row"><button class="primary" data-act="settings">Add API key</button></div>' : ''}`);
    }
  }

  function renderPanel(v, c) {
    const s = v.statistics || {}, sn = v.snippet;
    const views = +s.viewCount || 0;
    const likes = s.likeCount != null ? +s.likeCount : null;
    const comments = s.commentCount != null ? +s.commentCount : null;
    const published = Date.parse(sn.publishedAt);
    const vpd = viewsPerDay(views, published);
    const engagement = views ? ((likes || 0) + (comments || 0)) / views : null;
    const tags = sn.tags || [];
    const { checks, score, tagChars } = seoChecks(v);

    const cs = c?.statistics || {};
    const chViews = +cs.viewCount || 0, chVideos = +cs.videoCount || 0;
    const chAvg = chVideos ? chViews / chVideos : null;
    const vsAvg = chAvg ? views / chAvg : null;

    const stat = (k, val, sub = '', cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${val}</div><div class="s">${sub || '&nbsp;'}</div></div>`;
    panel.tags = tags;
    panel.channelId = sn.channelId;
    panel.thumb = sn.thumbnails?.maxres?.url || sn.thumbnails?.high?.url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;

    shell(`<span class="score ${scoreClass(score)}" title="SEO score">SEO ${score}/100</span>`, `
      <div class="grid">
        ${stat('Views', compact(views), fmt(views))}
        ${stat('Views / day', compact(vpd), ago(published))}
        ${stat('vs channel avg', vsAvg ? `${vsAvg.toFixed(1)}×` : '—', chAvg ? `avg ${compact(chAvg)}` : '', vsAvg >= 1.5 ? 'good' : vsAvg && vsAvg < 0.5 ? 'bad' : '')}
        ${stat('Likes', likes == null ? 'Hidden' : compact(likes), likes != null && views ? `${pct(likes / views)} of views` : '')}
        ${stat('Comments', comments == null ? 'Off' : compact(comments), comments != null && views ? `${pct(comments / views, 2)} of views` : '')}
        ${stat('Engagement', pct(engagement, 2), 'likes + comments')}
        ${stat('Published', df.format(published), new Date(published).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
        ${stat('Length', fmtDuration(parseDuration(v.contentDetails?.duration)), v.contentDetails?.definition?.toUpperCase())}
        ${stat('Category', CATEGORIES[sn.categoryId] || '—', sn.defaultAudioLanguage || sn.defaultLanguage || '')}
      </div>

      <div class="section">
        <div class="section-head"><b>Tags (${tags.length})</b>
          <span>${tags.length ? '<span class="copied" hidden>Copied!</span> <button data-act="copy-tags">Copy all</button>' : ''}</span></div>
        ${tags.length
          ? `<div class="chips">${tags.map((t, i) => `<button class="chip" data-act="kw" data-i="${i}" title="Explore this keyword">${esc(t)}</button>`).join('')}</div>
             <div class="small muted" style="margin-top:6px">Tag box: ${tagChars}/500 characters · click a tag to explore it</div>
             <div class="meter"><span style="width:${clamp(tagChars / 5)}%"></span></div>`
          : '<div class="muted small">This video has no tags.</div>'}
      </div>

      <div class="section">
        <div class="section-head"><b>SEO checklist</b><span class="${scoreClass(score)}"><b>${score}</b>/100</span></div>
        <ul class="checks">${checks.map((ch) => `<li><span class="i ${ch.ok ? 'ok' : 'no'}">${ch.ok ? '✓' : '✗'}</span>
          <span>${esc(ch.label)}${!ch.ok && ch.tip ? ` <span class="tip">— ${esc(ch.tip)}</span>` : ''}</span></li>`).join('')}</ul>
      </div>

      ${c ? `<div class="section">
        <div class="channel">
          ${c.snippet.thumbnails?.default?.url ? `<img src="${esc(c.snippet.thumbnails.default.url)}" alt="">` : ''}
          <div><div class="n">${esc(c.snippet.title)}</div>
            <div class="small muted">${cs.hiddenSubscriberCount ? 'Hidden' : compact(+cs.subscriberCount)} subscribers · ${compact(chViews)} views · ${fmt(chVideos)} videos</div></div>
        </div>
      </div>` : ''}

      <div class="row">
        <button class="primary" data-act="channel">Analyze channel</button>
        <button data-act="thumb">HD thumbnail</button>
        ${tags[0] ? '<button data-act="kw" data-i="0">Explore main tag</button>' : ''}
      </div>`);
  }

  function onPanelClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'toggle') {
      panel.collapsed = !panel.collapsed;
      panel.root.querySelector('.box')?.classList.toggle('collapsed', panel.collapsed);
    } else if (act === 'copy-tags') {
      navigator.clipboard.writeText(panel.tags.join(', ')).then(() => {
        const ok = panel.root.querySelector('.copied');
        if (ok) { ok.hidden = false; setTimeout(() => { ok.hidden = true; }, 1500); }
      });
    } else if (act === 'kw') {
      openPage('keywords.html', { q: panel.tags[+el.dataset.i] });
    } else if (act === 'channel') {
      openPage('dashboard.html', { src: panel.channelId });
    } else if (act === 'thumb') {
      window.open(panel.thumb, '_blank', 'noopener');
    } else if (act === 'settings') {
      openPage('dashboard.html', { settings: 1 });
    }
  }

  // ==================== Thumbnail badges ====================

  const RENDERERS = [
    'ytd-video-renderer', 'ytd-rich-item-renderer', 'ytd-compact-video-renderer', 'ytd-grid-video-renderer',
    'ytd-playlist-video-renderer', 'yt-lockup-view-model',
  ].join(',');
  const THUMBS = 'ytd-thumbnail, yt-thumbnail-view-model, a#thumbnail, a[class*="content-image"]';
  const videoCache = new Map();   // id -> { views, published, channelId, tags, likes }
  const channelCache = new Map(); // id -> avg views per video
  const loading = new Set();
  let scanTimer = null;

  function idFromHref(href) {
    if (!href) return null;
    const m = href.match(/[?&]v=([\w-]{11})/) || href.match(/\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  // Throttled, not debounced: YouTube mutates the DOM constantly while a video plays.
  function scheduleScan(delay = 400) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, delay);
  }

  function clearBadges() {
    document.querySelectorAll('.ycv-badge').forEach((b) => b.remove());
    document.querySelectorAll('[data-ycv-id]').forEach((el) => delete el.dataset.ycvId);
  }

  function badgeHtml(id) {
    const v = videoCache.get(id);
    const avg = channelCache.get(v.channelId);
    const vpd = viewsPerDay(v.views, v.published);
    const x = avg ? v.views / avg : null;
    const tip = [
      `${fmt(v.views)} views · ${ago(v.published)}`,
      `${fmt(vpd)} views/day`,
      x != null ? `${x.toFixed(1)}× the channel's average views` : null,
      v.likes != null && v.views ? `Like rate ${pct(v.likes / v.views)}` : null,
      `${v.tags} tags`,
    ].filter(Boolean).join('\n');
    const hot = x != null && x >= 2 ? 'ycv-hot' : x != null && x < 0.5 ? 'ycv-cold' : '';
    return { tip, html: `<span>${compact(Math.round(vpd))}/day</span>${x != null ? `<span class="${hot}">${x >= 10 ? Math.round(x) : x.toFixed(1)}×</span>` : ''}` };
  }

  function attachBadge(el, id) {
    const thumb = el.querySelector(THUMBS);
    if (!thumb) return;
    if (getComputedStyle(thumb).position === 'static') thumb.style.position = 'relative';
    const { tip, html } = badgeHtml(id);
    const b = document.createElement('div');
    b.className = 'ycv-badge';
    b.title = tip;
    b.innerHTML = html;
    thumb.appendChild(b);
  }

  async function scan() {
    if (!settings.badges) return;
    const pending = [];
    for (const el of document.querySelectorAll(RENDERERS)) {
      if (el.querySelector(RENDERERS)) continue; // outer wrapper; the inner renderer gets the badge
      const a = el.querySelector('a[href*="watch?v="], a[href^="/shorts/"]');
      const id = idFromHref(a?.getAttribute('href'));
      if (!id) continue;
      if (el.dataset.ycvId === id && el.querySelector('.ycv-badge')) continue;
      el.querySelectorAll('.ycv-badge').forEach((b) => b.remove()); // YouTube recycles renderer nodes
      el.dataset.ycvId = id;
      pending.push({ el, id });
    }
    if (!pending.length) return;

    for (const { el, id } of pending) {
      const v = videoCache.get(id);
      if (v && channelCache.has(v.channelId)) attachBadge(el, id);
      else delete el.dataset.ycvId; // retry once data arrives
    }

    const needVideos = [...new Set(pending.map((p) => p.id))].filter((id) => !videoCache.has(id) && !loading.has(id));
    const needChannels = new Set();
    try {
      for (const ids of chunk(needVideos, 50)) {
        ids.forEach((id) => loading.add(id));
        const r = await api('videos', {
          part: 'snippet,statistics', id: ids.join(','), maxResults: 50,
          fields: 'items(id,snippet(publishedAt,channelId,tags),statistics(viewCount,likeCount))',
        });
        for (const it of r.items || []) {
          videoCache.set(it.id, {
            views: +it.statistics?.viewCount || 0,
            likes: it.statistics?.likeCount != null ? +it.statistics.likeCount : null,
            published: Date.parse(it.snippet.publishedAt),
            channelId: it.snippet.channelId,
            tags: it.snippet.tags?.length || 0,
          });
        }
        ids.forEach((id) => { if (!videoCache.has(id)) videoCache.set(id, null); }); // private/deleted: don't refetch
      }
      for (const { id } of pending) {
        const v = videoCache.get(id);
        if (v && !channelCache.has(v.channelId)) needChannels.add(v.channelId);
      }
      for (const ids of chunk([...needChannels], 50)) {
        const r = await api('channels', { part: 'statistics', id: ids.join(','), fields: 'items(id,statistics(viewCount,videoCount))' });
        for (const it of r.items || []) {
          const n = +it.statistics.videoCount;
          channelCache.set(it.id, n ? +it.statistics.viewCount / n : null);
        }
        ids.forEach((id) => { if (!channelCache.has(id)) channelCache.set(id, null); });
      }
    } catch (e) {
      // No key / quota: stop badging quietly until settings change.
      if (e.reason === 'noKey' || e.reason === 'quotaExceeded' || e.status === 400 || e.status === 403) settings.badges = false;
      return;
    } finally {
      needVideos.forEach((id) => loading.delete(id));
    }
    if (needVideos.length || needChannels.size) scheduleScan(50);
  }

  // ==================== wiring ====================

  function onNavigate() {
    updateVideoPanel();
    scheduleScan(600);
  }

  async function init() {
    settings = await YT.getSettings();
    chrome.storage.onChanged.addListener(async (changes) => {
      if (!changes.settings && !changes.apiKey) return;
      settings = await YT.getSettings();
      panel.videoId = null;
      updateVideoPanel();
      if (settings.badges) scheduleScan(0); else clearBadges();
    });
    document.addEventListener('yt-navigate-finish', onNavigate);
    new MutationObserver(() => scheduleScan()).observe(document.body, { childList: true, subtree: true });
    new MutationObserver(() => panel.host?.toggleAttribute('dark', isDark()))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
    onNavigate();
  }

  init();
})();
