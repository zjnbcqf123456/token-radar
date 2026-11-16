// Token Radar dashboard: board, detail view, live tokens and the model behind them.
// Reads window.RADAR from data.js. No network, no fetch: the whole dataset ships with the page.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) return;
  var watchlist = {};
  (R.watchlist || []).forEach(function (s) { watchlist[s] = true; });

  function $(id) { return document.getElementById(id); }
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    if (n === null || n === undefined) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function age(n) {
    if (n === null || n === undefined) return '—';
    if (n < 365) return n + 'd';
    return (n / 365).toFixed(1) + 'y';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Header numbers.
  $('meta').innerHTML =
    'Snapshot <b>' + esc(R.as_of) + '</b><br>' +
    '<b>' + R.board_size + '</b> ranked · <b>' + R.watchlist_size + '</b> watchlist · model <b>' + esc(R.model_version) + '</b>';

  // Filter options.
  var chains = {}, cats = {};
  R.rows.forEach(function (r) {
    r.chains.forEach(function (c) { chains[c] = true; });
    if (r.category) cats[r.category] = true;
  });
  Object.keys(chains).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; $('chain').appendChild(o);
  });
  Object.keys(cats).sort().forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; $('category').appendChild(o);
  });

  // Model explainer.
  $('modelText').textContent =
    'Implied value = TVL × category multiple × growth × maturity × chains. The category multiple is the median ' +
    'market-cap-per-TVL of that category\u2019s live protocols in this same snapshot (global median $' +
    R.global_median.toFixed(3) + ' per $1 of TVL where a category has no live names), winsorised to 0.02–1.00 and ' +
    'shrunk toward the global median. Growth is the 7-day TVL change, clamped to −60…+120% at half weight. ' +
    'Maturity rises from 0.60 to 1.00 over three years tracked. Multi-chain adds 0.03 per extra chain, up to 0.12.';
  var mrows = (R.multiples || []).slice().sort(function (a, b) { return b.n - a.n || (a.category < b.category ? -1 : 1); });
  $('multipleRows').innerHTML = mrows.map(function (m) {
    return '<tr><td>' + esc(m.category) + '</td><td class="num">' + m.n + '</td><td class="num">' +
      m.median.toFixed(3) + '</td><td class="num">' + m.multiple.toFixed(3) + '</td></tr>';
  }).join('');

  // Live tokens.
  $('liveRows').innerHTML = R.live.map(function (p) {
    return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.category || '—') + '</td><td>' +
      chainList(p.chains) + '</td><td class="num">' + money(p.tvl_usd) + '</td><td class="num">' +
      (p.mcap_usd === null ? '—' : money(p.mcap_usd)) + '</td><td class="num ' +
      (p.change_7d === null ? '' : p.change_7d >= 0 ? 'up' : 'down') + '">' + pct(p.change_7d) + '</td></tr>';
  }).join('');

  var state = { q: '', chain: '', category: '', watchlistOnly: false, newOnly: false, sort: 'rank', view: 'board', selected: null };

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = R.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.category && r.category !== state.category) return false;
      if (state.watchlistOnly && !watchlist[r.slug]) return false;
      if (state.newOnly && (r.age_days === null || r.age_days >= 180)) return false;
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === 'implied') return b.implied_value_usd - a.implied_value_usd;
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'growth') return (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d);
      if (key === 'age') return (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days);
      return a.rank - b.rank;
    });
    return list;
  }

  /** The first three chains, with a count for the rest: a table cell that lists twelve chains is unreadable. */
  function chainList(chains) {
    var shown = chains.slice(0, 3).map(esc).join(', ');
    return chains.length > 3 ? shown + ' +' + (chains.length - 3) : shown;
  }

  function rowHtml(r) {
    var g = r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down';
    return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
      '<td class="num">' + r.rank + '</td>' +
      '<td>' + esc(r.name) + (watchlist[r.slug] ? ' <span class="pill watch">watchlist</span>' : '') + '<br><span class="sym">' + esc(r.slug) + '</span></td>' +
      '<td>' + esc(r.category || '—') + '</td>' +
      '<td>' + chainList(r.chains) + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' +
      '<td class="num ' + g + '">' + pct(r.change_7d) + '</td>' +
      '<td class="num">' + age(r.age_days) + '</td>' +
      '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td></tr>';
  }

  function render() {
    var list = filtered();
    $('rows').innerHTML = list.map(rowHtml).join('');
    $('count').textContent = list.length + ' of ' + R.rows.length + ' shown';
    var showBoard = state.view === 'board';
    $('controls').style.display = showBoard ? '' : 'none';
    $('board').style.display = showBoard ? '' : 'none';
    $('liveWrap').hidden = state.view !== 'live';
    $('modelWrap').hidden = state.view !== 'model';
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-view') === state.view);
    });
  }

  function detail(r) {
    state.selected = r.slug;
    var mult = r.multiple;
    var base = Math.round(r.tvl_usd * mult);
    $('detail').innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<div>' + (r.category ? '<span class="pill">' + esc(r.category) + '</span>' : '') +
      r.chains.map(function (c) { return '<span class="pill">' + esc(c) + '</span>'; }).join('') +
      (watchlist[r.slug] ? '<span class="pill watch">watchlist</span>' : '') + '</div>' +
      '<div class="facts">' +
      '<div><b>Rank</b>#' + r.rank + ' of ' + R.rows.length + '</div>' +
      '<div><b>Implied value</b>' + money(r.implied_value_usd) + '</div>' +
      '<div><b>TVL</b>' + money(r.tvl_usd) + '</div>' +
      '<div><b>7-day growth</b>' + pct(r.change_7d) + '</div>' +
      '<div><b>Tracked since</b>' + esc(r.listed_at || 'unknown') + ' (' + age(r.age_days) + ')</div>' +
      '<div><b>Token</b>records none</div></div>' +
      '<h3>How the value is built</h3>' +
      '<table><tbody>' +
      '<tr><td>TVL × category multiple</td><td>' + money(r.tvl_usd) + ' × ' + mult.toFixed(3) + ' = ' + money(base) + '</td></tr>' +
      '<tr><td>Category median (live names)</td><td>' + r.category_median.toFixed(3) + ' over ' + r.multiple_n + ' live</td></tr>' +
      '<tr><td>Growth multiplier</td><td>× ' + r.growth_multiplier.toFixed(3) + '</td></tr>' +
      '<tr><td>Maturity multiplier</td><td>× ' + r.maturity_multiplier.toFixed(3) + '</td></tr>' +
      '<tr><td>Multi-chain multiplier</td><td>× ' + r.chains_multiplier.toFixed(3) + '</td></tr>' +
      '<tr><td><b>Implied value</b></td><td><b>' + money(r.implied_value_usd) + '</b></td></tr>' +
      '</tbody></table>' +
      '<h3>Farm plan</h3><ol>' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="warn">This protocol records no token in the snapshot. That is what the data says, not proof it has none — check its own pages before you farm it.</p>';
    render();
  }

  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    var slug = tr.getAttribute('data-slug');
    var found = null;
    R.rows.forEach(function (r) { if (r.slug === slug) found = r; });
    if (found) detail(found);
  });

  $('q').addEventListener('input', function () { state.q = this.value; render(); });
  $('chain').addEventListener('change', function () { state.chain = this.value; render(); });
  $('category').addEventListener('change', function () { state.category = this.value; render(); });
  $('watchlistOnly').addEventListener('change', function () { state.watchlistOnly = this.checked; render(); });
  $('newOnly').addEventListener('change', function () { state.newOnly = this.checked; render(); });
  $('sort').addEventListener('change', function () { state.sort = this.value; render(); });
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { state.view = t.getAttribute('data-view'); render(); });
  });
  document.querySelectorAll('#board thead th').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (k === 'rank' || k === 'implied' || k === 'tvl' || k === 'growth' || k === 'age') {
        state.sort = k === 'rank' ? 'rank' : k; $('sort').value = state.sort; render();
      }
    });
  });

  // Deep links for screenshots: ?slug=<slug> opens the detail, ?chain= / ?category= / ?q= prefilter.
  var params = new URLSearchParams(window.location.search);
  if (params.get('chain')) { state.chain = params.get('chain'); $('chain').value = state.chain; }
  if (params.get('category')) { state.category = params.get('category'); $('category').value = state.category; }
  if (params.get('q')) { state.q = params.get('q'); $('q').value = state.q; }
  if (params.get('watchlist')) { state.watchlistOnly = true; $('watchlistOnly').checked = true; }
  if (params.get('new')) { state.newOnly = true; $('newOnly').checked = true; }
  if (params.get('view')) { state.view = params.get('view'); }

  render();
  var slug = params.get('slug');
  if (slug) {
    var found = null;
    R.rows.forEach(function (r) { if (r.slug === slug) found = r; });
    if (found) detail(found);
  }
})();
