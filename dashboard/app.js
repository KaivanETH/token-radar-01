// RADAR's page. It reads window.RADAR, which main.ts writes to data.js beside the page, and renders
// the ranked board, the filters, a per-protocol detail view and the market table the multiple is read
// from. No network, no framework, no fetch: every number on screen is in data.js and every number in
// data.js comes from the snapshot through lib/model.ts.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var main = document.getElementById('board');
  if (!DATA) {
    main.innerHTML = '<p class="empty">data.js is missing: run main.ts to write the board beside this page.</p>';
    return;
  }

  // ---------------------------------------------------------------- state

  var state = {
    q: '',
    category: 'all',
    window: 'any',
    stage: 'board',
    sort: 'implied',
    dir: -1,
    open: null
  };

  var SORTS = {
    implied: function (r) { return r.implied_value_usd; },
    tvl: function (r) { return r.tvl_usd; },
    change: function (r) { return r.change_7d === null ? -1e9 : r.change_7d; },
    age: function (r) { return r.age_days === null ? 1e9 : r.age_days; },
    window: function (r) { return r.farm_window; },
    name: function (r) { return r.name.toLowerCase(); }
  };

  // ---------------------------------------------------------------- formatting

  function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%';
  }
  function ageShort(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function tone(n) { return n === null || n === undefined ? 'flat' : n > 0.0001 ? 'up' : n < -0.0001 ? 'down' : 'flat'; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  // The log scale of the value bar: a linear bar would leave every row under $10M invisible.
  var MAX = Math.max.apply(null, DATA.rows.map(function (r) { return r.implied_value_usd; }));
  var MIN = Math.min.apply(null, DATA.rows.map(function (r) { return r.implied_value_usd; }));
  function barWidth(v) {
    if (MAX === MIN) return 100;
    var t = (Math.log(v) - Math.log(MIN)) / (Math.log(MAX) - Math.log(MIN));
    return Math.max(3, Math.round(t * 100));
  }

  // ---------------------------------------------------------------- header, stats, model

  function renderMeta() {
    var meta = document.getElementById('meta');
    meta.innerHTML =
      '<div>snapshot <b>' + esc(DATA.as_of) + '</b></div>' +
      '<div><b>' + DATA.counts.protocols + '</b> protocols · <b>' + DATA.counts.watchlist + '</b> watchlist</div>' +
      '<div>model <b>' + esc(DATA.model_version) + '</b> · <b>' + DATA.counts.board + '</b> rows</div>';
    document.getElementById('f-source').textContent = DATA.source;
  }

  function renderStats() {
    var total = DATA.rows.reduce(function (sum, r) { return sum + r.implied_value_usd; }, 0);
    var widest = DATA.rows.slice().sort(function (a, b) {
      return b.farm_window - a.farm_window || b.implied_value_usd - a.implied_value_usd;
    })[0];
    var cards = [
      ['Launch candidates', String(DATA.counts.board), DATA.counts.protocols + ' read · ' + (DATA.counts.board - DATA.counts.watchlist) + ' beyond the watchlist'],
      ['Watchlist covered', DATA.counts.watchlist + ' / ' + DATA.counts.watchlist, 'the house floor, every row on the board'],
      ['Board value', usd(total), 'if every record held as it is'],
      ['Widest window', esc(widest.name), widest.farm_window + '/100 · ' + widest.window_label + ' · ' + usd(widest.tvl_usd) + ' TVL']
    ];
    var host = document.getElementById('stats');
    host.innerHTML = '';
    cards.forEach(function (c) {
      var card = el('div', 'stat');
      card.appendChild(el('span', null, esc(c[0])));
      card.appendChild(el('b', null, c[1]));
      card.appendChild(el('i', null, c[2]));
      host.appendChild(card);
    });
  }

  function renderModel() {
    var m = DATA.multiples;
    var r = DATA.rules;
    document.getElementById('t-mult').innerHTML =
      '<em>' + m.global.toFixed(3) + '× TVL</em> — the median market cap ÷ TVL of the ' + m.live_count +
      ' protocols in this snapshot that record both. A category with three or more of them gets its own median, pulled toward this one by ' +
      r.shrink + ' pseudo-observations and held inside ' + r.tilt_floor + '–' + r.tilt_cap + '× of it.';
    document.getElementById('t-mom').innerHTML =
      '<em>1 + clamp(Δ7d, ' + r.momentum_floor + ', +' + r.momentum_cap + ') ÷ 100 × ' + r.momentum_weight.toFixed(2) +
      '</em> — one week of TVL change, counted at half weight because one week is a noisy vote.';
    document.getElementById('t-ten').innerHTML =
      '<em>' + r.tenure_floor.toFixed(2) + ' + ' + r.tenure_range.toFixed(2) + ' × min(age, ' + r.tenure_days + ') ÷ ' + r.tenure_days +
      '</em> — how long the snapshot has tracked it with no token: a four-year record is worth ' +
      (r.tenure_floor + r.tenure_range).toFixed(2) + ', a fresh listing ' + r.tenure_floor.toFixed(2) + '.';
  }

  // ---------------------------------------------------------------- filters

  function categories() {
    var seen = {};
    DATA.rows.forEach(function (r) { if (r.category) seen[r.category] = (seen[r.category] || 0) + 1; });
    return Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a] || a.localeCompare(b); });
  }

  function renderCategoryOptions() {
    var select = document.getElementById('cat');
    var cats = categories();
    select.innerHTML = '<option value="all">all ' + cats.length + ' categories</option>';
    cats.forEach(function (c) {
      var option = document.createElement('option');
      option.value = c;
      option.textContent = c + ' (' + DATA.rows.filter(function (r) { return r.category === c; }).length + ')';
      select.appendChild(option);
    });
    select.value = state.category;
  }

  function matches(row) {
    if (state.stage === 'watch' && !row.on_watchlist) return false;
    if (state.stage === 'below' && row.above_floor) return false;
    if (state.category !== 'all' && row.category !== state.category) return false;
    if (state.window !== 'any' && row.window_label !== state.window) return false;
    var q = state.q.trim().toLowerCase();
    if (!q) return true;
    var hay = [row.name, row.slug, row.category || '', (row.chains || []).join(' '), row.symbol || ''].join(' ').toLowerCase();
    return q.split(/\s+/).every(function (part) { return hay.indexOf(part) >= 0; });
  }

  function visibleRows() {
    var list = DATA.rows.filter(matches);
    var key = SORTS[state.sort] || SORTS.implied;
    list.sort(function (a, b) {
      var av = key(a);
      var bv = key(b);
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.rank - b.rank;
    });
    return list;
  }

  // ---------------------------------------------------------------- the table

  function head(sortable) {
    var cols = [
      ['#', '', false],
      ['Protocol', 'name', true],
      ['TVL', 'tvl', true],
      ['7-day', 'change', true],
      ['Tracked', 'age', true],
      ['Implied value', 'implied', true],
      ['Window', 'window', true]
    ];
    var tr = document.createElement('tr');
    cols.forEach(function (c) {
      var th = document.createElement('th');
      if (c[0] === '#') th.className = 'rank';
      if (c[0] !== '#' && c[0] !== 'Protocol') th.className = 'r';
      if (c[2]) {
        var button = document.createElement('button');
        button.type = 'button';
        button.dataset.sort = c[1];
        button.textContent = c[0];
        if (state.sort === c[1]) {
          button.dataset.on = 'true';
          button.textContent = c[0] + (state.dir === -1 ? ' ↓' : ' ↑');
        }
        button.addEventListener('click', function () { setSort(c[1]); });
        th.appendChild(button);
      } else {
        th.textContent = c[0];
      }
      tr.appendChild(th);
    });
    return tr;
  }

  function liveHead() {
    var tr = document.createElement('tr');
    ['#', 'Protocol', 'TVL', 'Market cap', 'Mcap ÷ TVL', '7-day'].forEach(function (label, i) {
      var th = document.createElement('th');
      if (i > 1) th.className = 'r';
      if (i === 0) th.className = 'rank';
      th.textContent = label;
      tr.appendChild(th);
    });
    return tr;
  }

  function rowNode(row) {
    var tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.slug = row.slug;

    var rank = el('td', 'rank');
    rank.innerHTML = '<b>' + row.rank + '</b>';
    tr.appendChild(rank);

    var who = el('td');
    var tag = row.on_watchlist
      ? '<span class="tag watch">watchlist</span>'
      : row.above_floor ? '' : '<span class="tag">below floor</span>';
    who.innerHTML =
      '<div class="who"><span class="nm">' + esc(row.name) + tag + '</span>' +
      '<span class="sub"><em>' + esc(row.category || 'no category') + '</em> · ' + esc((row.chains || []).slice(0, 2).join(', ') || 'no chain') + '</span></div>';
    tr.appendChild(who);

    tr.appendChild(el('td', 'r num', usd(row.tvl_usd)));
    tr.appendChild(el('td', 'r num ' + tone(row.change_7d), pct(row.change_7d)));
    tr.appendChild(el('td', 'r num', ageShort(row.age_days)));

    var value = el('td', 'r');
    value.innerHTML =
      '<div class="implied"><span class="bar"><i style="width:' + barWidth(row.implied_value_usd) + '%"></i></span>' +
      '<b>' + usd(row.implied_value_usd) + '</b></div>';
    tr.appendChild(value);

    var win = el('td', 'r');
    win.innerHTML = '<span class="pill ' + row.window_label + '">' + row.window_label + ' ' + row.farm_window + '</span>';
    tr.appendChild(win);

    tr.addEventListener('click', function () { open(row.slug); });
    tr.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open(row.slug);
      }
    });
    return tr;
  }

  function liveRowNode(row, i) {
    var tr = document.createElement('tr');
    tr.className = 'static';
    tr.appendChild(el('td', 'rank', '<b>' + (i + 1) + '</b>'));
    var who = el('td');
    who.innerHTML =
      '<div class="who"><span class="nm">' + esc(row.name) + '</span>' +
      '<span class="sub"><em>' + esc(row.category || 'no category') + '</em> · ' + esc((row.chains || []).slice(0, 2).join(', ') || 'no chain') + '</span></div>';
    tr.appendChild(who);
    tr.appendChild(el('td', 'r num', usd(row.tvl_usd)));
    tr.appendChild(el('td', 'r num', usd(row.mcap_usd)));
    tr.appendChild(el('td', 'r num', row.multiple.toFixed(3) + '×'));
    tr.appendChild(el('td', 'r num ' + tone(row.change_7d), pct(row.change_7d)));
    return tr;
  }

  function renderTable() {
    var thead = document.getElementById('thead');
    var tbody = document.getElementById('rows');
    var empty = document.getElementById('empty');
    var table = document.getElementById('table');
    var oldCols = table.querySelector('colgroup');
    if (oldCols) oldCols.remove();
    thead.innerHTML = '';
    tbody.innerHTML = '';

    // Fixed column widths keep the header and the body on the same grid at every stage.
    var widths = state.stage === 'live' ? [58, 0, 140, 150, 120, 100] : [58, 0, 112, 88, 88, 210, 116];
    var colgroup = document.createElement('colgroup');
    widths.forEach(function (w) {
      var col = document.createElement('col');
      if (w > 0) col.style.width = w + 'px';
      colgroup.appendChild(col);
    });
    table.insertBefore(colgroup, table.firstChild);

    if (state.stage === 'live') {
      thead.appendChild(liveHead());
      var live = DATA.live.filter(function (r) {
        if (state.category !== 'all' && r.category !== state.category) return false;
        var q = state.q.trim().toLowerCase();
        if (!q) return true;
        var hay = [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase();
        return q.split(/\s+/).every(function (part) { return hay.indexOf(part) >= 0; });
      });
      live.forEach(function (row, i) { tbody.appendChild(liveRowNode(row, i)); });
      empty.hidden = live.length > 0;
      table.hidden = live.length === 0;
      document.getElementById('count').textContent =
        'Showing ' + live.length + ' of ' + DATA.counts.with_mcap + ' protocols that record a market cap (' + DATA.counts.token_recorded +
        ' record a token) · the board’s multiple is the median of the mcap ÷ TVL column';
      return;
    }

    thead.appendChild(head());
    var rows = visibleRows();
    rows.forEach(function (row) { tbody.appendChild(rowNode(row)); });
    empty.hidden = rows.length > 0;
    table.hidden = rows.length === 0;

    var note = state.stage === 'watch'
      ? 'the 40 the house floor kept'
      : state.stage === 'below'
        ? 'candidates under the $' + (DATA.floor_usd / 1e6).toFixed(0) + 'M floor'
        : 'every protocol that records no token and is not a wrapped or staked product';
    document.getElementById('count').textContent =
      'Showing ' + rows.length + ' of ' + DATA.rows.length + ' candidates · ' + note + ' · snapshot ' + DATA.as_of;
  }

  // ---------------------------------------------------------------- the detail view

  function farmWindowParts(row) {
    var r = DATA.rules;
    var g = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    g = Math.min(r.momentum_cap, Math.max(r.momentum_floor, g));
    var momentum = Math.min(1, Math.max(0, (g + 20) / 80));
    var freshness = Math.min(1, Math.max(0.08, 1 - (row.age_days === null ? r.unknown_age_days : row.age_days) / 1095));
    var size = Math.min(1, Math.max(0, Math.log(Math.max(row.tvl_usd, 1) / 1e6) / Math.log(10) / 3.5));
    return { momentum: momentum, freshness: freshness, size: size };
  }

  function steps(list, from) {
    var ol = el('ol', 'steps');
    list.forEach(function (step, i) {
      var li = el('li', step.phase === 'after' ? 'after' : 'before');
      li.appendChild(el('span', 'n', String(from + i)));
      var body = el('div');
      body.appendChild(el('p', null, esc(step.text)));
      body.appendChild(el('div', 'chips',
        '<span class="chip">Cost <b>' + esc(step.cost) + '</b></span>' +
        '<span class="chip">Time <b>' + esc(step.time) + '</b></span>'));
      li.appendChild(body);
      ol.appendChild(li);
    });
    return ol;
  }

  // How the same formula moves with one input: the detail view's last card, and the model made concrete.
  function sensitivityCard(row) {
    var up = function (factor) { return usd(row.implied_value_usd * factor); };
    var tvl = up(1.1);
    var momentum = up((row.momentum + 0.05) / row.momentum);
    var tenure = up((row.tenure + 0.075) / row.tenure);
    return '<section class="panel card"><h3>What would move it</h3><div class="record">' +
      '<div><span>TVL up 10%</span><b>' + tvl + '</b></div>' +
      '<div><span>7-day change up 10 points</span><b>' + momentum + '</b></div>' +
      '<div><span>Another year on the record</span><b>' + tenure + '</b></div>' +
      '</div><p class="fine">The same arithmetic, one input moved. TVL is the whole value; a week of growth is worth half its move; a year of record adds 0.075 to tenure.</p></section>';
  }

  function renderDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    var host = document.getElementById('detail');
    if (!row) {
      host.hidden = true;
      document.body.classList.remove('detail-open');
      return;
    }
    var before = row.farm.filter(function (s) { return s.phase === 'before'; });
    var after = row.farm.filter(function (s) { return s.phase === 'after'; });
    var parts = farmWindowParts(row);
    var catN = DATA.multiples.category_n[row.category] || 0;
    var mcap = row.mcap_usd === null ? 'none recorded' : usd(row.mcap_usd);
    var since = row.listed_at === null ? 'not reported' : row.listed_at;

    host.innerHTML =
      '<div class="detail-bar">' +
        '<div class="brand mini"><span class="sweep" aria-hidden="true"><i></i></span><b>RADAR</b><span class="crumb">/ protocol detail</span></div>' +
        '<button class="back" type="button" id="back">← Back to the board</button>' +
      '</div>' +
      '<header class="detail-head">' +
        '<div><p class="where">RANK ' + row.rank + ' OF ' + DATA.rows.length + ' · ' + esc(row.slug) + '</p>' +
        '<h2>' + esc(row.name) + '</h2>' +
        '<div class="tags">' +
          '<span class="pill ' + row.window_label + '">' + row.window_label + ' window ' + row.farm_window + '</span>' +
          '<span class="pill">' + esc(row.category || 'no category') + '</span>' +
          '<span class="pill">' + esc((row.chains || []).join(', ') || 'no chain') + '</span>' +
          (row.on_watchlist ? '<span class="tag watch">watchlist</span>' : '<span class="tag">below floor</span>') +
        '</div></div>' +
        '<div class="detail-value"><span>implied value</span><b>' + usd(row.implied_value_usd) + '</b></div>' +
      '</header>' +
      '<div class="detail-grid">' +
        '<div class="detail-col">' +
          '<section class="panel card"><h3>The arithmetic</h3><div class="arith">' +
            '<div><span>TVL</span><b>' + usd(row.tvl_usd) + '</b></div>' +
            '<div><span>× multiple · ' + esc(row.category || 'market') + ' (' + catN + ' live)</span><b>' + row.multiple.toFixed(3) + '×</b></div>' +
            '<div><span>× momentum · 7-day ' + pct(row.change_7d) + '</span><b>' + row.momentum.toFixed(3) + '</b></div>' +
            '<div><span>× tenure · ' + ageShort(row.age_days) + ' tracked</span><b>' + row.tenure.toFixed(3) + '</b></div>' +
            '<div class="total"><span>= implied value</span><b>' + usd(row.implied_value_usd) + '</b></div>' +
          '</div>' +
          '<p class="fine">The multiple is read off the ' + DATA.multiples.live_count + ' protocols in this snapshot that record a market cap and a TVL; ' +
          (catN >= 3
            ? 'this category’s median is taken over ' + catN + ' of them and pulled toward the market’s ' + DATA.multiples.global.toFixed(3) + '×.'
            : 'this category has fewer than three live protocols, so the market’s ' + DATA.multiples.global.toFixed(3) + '× is used unchanged.') +
          '</p></section>' +
          '<section class="panel card"><h3>The record</h3><div class="record">' +
            '<div><span>7-day TVL change</span><b class="' + tone(row.change_7d) + '">' + pct(row.change_7d) + '</b></div>' +
            '<div><span>Tracked since</span><b>' + esc(since) + ' · ' + ageShort(row.age_days) + '</b></div>' +
            '<div><span>Market cap</span><b class="' + (row.mcap_usd === null ? 'none' : '') + '">' + mcap + '</b></div>' +
            '<div><span>CoinGecko id</span><b class="' + (row.gecko_id === null ? 'none' : '') + '">' + esc(row.gecko_id || 'none recorded') + '</b></div>' +
            '<div><span>Symbol</span><b class="' + (row.symbol === null ? 'none' : '') + '">' + esc(row.symbol || 'none recorded') + '</b></div>' +
          '</div><p class="fine">The snapshot records no token for this protocol. That is the record, not proof that a token does not exist.</p></section>' +
          '<section class="panel card"><h3>Farm window</h3>' +
            '<div class="window-head"><b>' + row.farm_window + '</b><i>' + row.window_label + '</i></div>' +
            '<div class="meter"><i style="width:' + row.farm_window + '%"></i></div>' +
            '<div class="inputs">' +
              '<div><span>7-day momentum</span><b>' + parts.momentum.toFixed(2) + ' / 1</b></div>' +
              '<div><span>youth · ' + ageShort(row.age_days) + '</span><b>' + parts.freshness.toFixed(2) + ' / 1</b></div>' +
              '<div><span>size · ' + usd(row.tvl_usd) + '</span><b>' + parts.size.toFixed(2) + ' / 1</b></div>' +
            '</div><p class="fine">Weighted 45 / 35 / 20. It is a timing signal and never moves the rank.</p></section>' +
          sensitivityCard(row) +
        '</div>' +
        '<div class="detail-col">' +
          '<section class="panel plan">' +
            '<div class="plan-head"><h3>Farm plan</h3><p class="fine">' + row.farm.length + ' steps · each with its cost and its clock</p></div>' +
            '<h4>Before a token exists</h4>' +
            steps(before, 1).outerHTML +
            '<h4 class="split">Once it issues</h4>' +
            steps(after, before.length + 1).outerHTML +
            '<p class="fine">Capital, hold and cadence come from this protocol’s TVL and age; the position comes from its category. Two protocols with different figures get different plans.</p>' +
          '</section>' +
        '</div>' +
      '</div>';

    host.hidden = false;
    document.body.classList.add('detail-open');
    document.getElementById('back').addEventListener('click', close);
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- open and close

  function open(slug) {
    state.open = slug;
    writeHash();
    renderDetail(slug);
  }
  function close() {
    state.open = null;
    document.getElementById('detail').hidden = true;
    document.body.classList.remove('detail-open');
    writeHash();
  }

  // ---------------------------------------------------------------- hash state

  function readHash() {
    var raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    var params = new URLSearchParams(raw);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('cat')) state.category = params.get('cat');
    if (params.get('win')) state.window = params.get('win');
    if (['board', 'watch', 'below', 'live'].indexOf(params.get('stage')) >= 0) state.stage = params.get('stage');
    if (params.get('sort') && SORTS[params.get('sort')]) state.sort = params.get('sort');
    if (params.get('dir') === '1' || params.get('dir') === '-1') state.dir = Number(params.get('dir'));
    if (params.get('p')) state.open = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('cat', state.category);
    if (state.window !== 'any') params.set('win', state.window);
    if (state.stage !== 'board') params.set('stage', state.stage);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.dir !== -1) params.set('dir', String(state.dir));
    if (state.open) params.set('p', state.open);
    var next = params.toString();
    var url = next ? '#' + next : window.location.pathname + window.location.search;
    // On a file:// page the history API refuses a new URL; the page still works from its state.
    try { window.history.replaceState(null, '', url); } catch (err) { /* opened from disk */ }
  }

  // ---------------------------------------------------------------- events

  function setSort(key) {
    if (state.sort === key) state.dir = -state.dir;
    else {
      state.sort = key;
      state.dir = key === 'name' || key === 'age' ? 1 : -1;
    }
    syncControls();
    writeHash();
    renderTable();
  }

  function syncControls() {
    document.getElementById('q').value = state.q;
    document.getElementById('cat').value = state.category;
    document.getElementById('win').value = state.window;
    document.getElementById('sort').value = state.sort;
    document.getElementById('dir').textContent = state.dir === -1 ? '↓' : '↑';
    document.querySelectorAll('.tabs button').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.stage === state.stage));
    });
    var liveMode = state.stage === 'live';
    document.getElementById('win').closest('.field').hidden = liveMode;
    document.getElementById('sort').closest('.field').hidden = liveMode;
    document.getElementById('dir').hidden = liveMode;
  }

  function bind() {
    document.getElementById('q').addEventListener('input', function (event) {
      state.q = event.target.value;
      writeHash();
      renderTable();
    });
    document.getElementById('cat').addEventListener('change', function (event) {
      state.category = event.target.value;
      writeHash();
      renderTable();
    });
    document.getElementById('win').addEventListener('change', function (event) {
      state.window = event.target.value;
      writeHash();
      renderTable();
    });
    document.getElementById('sort').addEventListener('change', function (event) {
      state.sort = event.target.value;
      state.dir = state.sort === 'name' || state.sort === 'age' ? 1 : -1;
      syncControls();
      writeHash();
      renderTable();
    });
    document.getElementById('dir').addEventListener('click', function () {
      state.dir = -state.dir;
      syncControls();
      writeHash();
      renderTable();
    });
    document.getElementById('reset').addEventListener('click', function () {
      state.q = '';
      state.category = 'all';
      state.window = 'any';
      state.stage = 'board';
      state.sort = 'implied';
      state.dir = -1;
      syncControls();
      writeHash();
      renderTable();
    });
    document.getElementById('clear').addEventListener('click', function () {
      state.q = '';
      state.category = 'all';
      state.window = 'any';
      syncControls();
      writeHash();
      renderTable();
    });
    document.querySelectorAll('.tabs button').forEach(function (button) {
      button.addEventListener('click', function () {
        state.stage = button.dataset.stage;
        syncControls();
        writeHash();
        renderTable();
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.open) close();
      var tag = document.activeElement ? document.activeElement.tagName : '';
      if (event.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) {
        event.preventDefault();
        document.getElementById('q').focus();
      }
    });
    window.addEventListener('hashchange', function () {
      readHash();
      syncControls();
      renderTable();
      if (state.open) renderDetail(state.open);
      else close();
    });
  }

  // ---------------------------------------------------------------- boot

  readHash();
  renderMeta();
  renderStats();
  renderModel();
  renderCategoryOptions();
  document.getElementById('n-board').textContent = DATA.rows.length;
  document.getElementById('n-watch').textContent = DATA.rows.filter(function (r) { return r.on_watchlist; }).length;
  document.getElementById('n-below').textContent = DATA.rows.filter(function (r) { return !r.above_floor; }).length;
  document.getElementById('n-live').textContent = DATA.counts.token_recorded;
  document.getElementById('board-kicker').textContent =
    DATA.rows.length + ' rows · the ' + DATA.counts.watchlist + ' watchlist slugs · ' + DATA.counts.below_floor +
    ' below the $' + (DATA.floor_usd / 1e6).toFixed(0) + 'M floor · ' + DATA.counts.above_floor_off_list +
    ' above it the list leaves out · ' + DATA.as_of;
  document.getElementById('board-note').textContent =
    'Rank is the model’s claim, not advice. Click any row for its arithmetic, its record and its farm plan.';
  bind();
  syncControls();
  renderTable();
  if (state.open) renderDetail(state.open);
})();
