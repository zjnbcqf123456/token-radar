// Token Radar dashboard: board, detail view, live tokens and the model behind them.
// Reads window.RADAR from data.js. No network, no fetch: the whole dataset ships with the page.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) return;
  var watchlist = {};
  (R.watchlist || []).forEach(function (s) { watchlist[s] = true; });
  // Rank 1's implied value: every row's bar is drawn against it.
  var topImplied = R.rows.length ? R.rows[0].implied_value_usd : 1;

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

  // Method in plain words: a regression fitted on the live protocols, tested out of sample.
  var f = R.fit;
  var thinCats = (R.multiples || []).filter(function (m) { return m.n < 5; }).length;
  var catCount = (R.multiples || []).length;
  var maxCatT = Math.max.apply(null, f.categories.map(function (c) { return Math.abs(c.t); }));
  $('methodBlock').innerHTML =
    '<h3>How a value is made</h3>' +
    '<ol class="method-steps">' +
    '<li><b>Learn from the protocols that already trade.</b> The snapshot holds ' + f.n_refs + ' live protocols with a market cap and a TVL. The model fits one regression on them: log(market cap) = ' + f.intercept.toFixed(2) + ' + ' + f.slope_log_tvl.toFixed(2) + ' × log(TVL) + a category effect.</li>' +
    '<li><b>Value grows slower than TVL.</b> The fitted slope is ' + f.slope_log_tvl.toFixed(2) + ', not 1: a protocol with ten times the TVL is priced at about ' + Math.pow(10, f.slope_log_tvl).toFixed(1) + ' times the value, not ten times. That is what the live names show — and it is why the old median multiple, which priced every dollar of TVL the same, is gone.</li>' +
    '<li><b>Categories nudge the price; thin ones do not.</b> Only categories with five or more live names get their own effect; the rest share the intercept. No category effect is statistically strong — the largest t is ' + maxCatT.toFixed(2) + ' — so the effects are small nudges, not the story.</li>' +
    '<li><b>Test it on protocols the fit never saw.</b> Fit on the live protocols listed before ' + f.holdout.split_date + ', predict the ' + f.holdout.n_test + ' listed after: the average miss is ' + f.holdout.mae.toFixed(2) + ' log points (about ' + Math.exp(f.holdout.mae).toFixed(1) + '×), the median miss ' + f.holdout.median_abs_err.toFixed(2) + ' (about ' + Math.exp(f.holdout.median_abs_err).toFixed(1) + '×). The naive median-multiple price misses by more (' + f.baseline_holdout.mae.toFixed(2) + ' log points), so the fit is better — and still weak in absolute terms. Every row carries the holdout band, not just the point.</li></ol>' +
    '<p class="note">What would change a number: fresh TVL, new live names, a new fit. Growth, age and chain count were tested and left out — they do not predict out of sample (see below). Nothing else — no team promises, no social buzz, no hand-written list. ' +
    thinCats + ' of ' + catCount + ' categories rest on fewer than five live names; the table below marks them Low.</p>';

  // Model explainer: the fitted equation and its numbers, then the validation.
  $('modelText').textContent =
    'log(market cap) = ' + f.intercept.toFixed(4) + ' + ' + f.slope_log_tvl.toFixed(4) + ' × log(TVL) + category effect, fitted by least squares on the ' + f.n_refs + ' live protocols in this snapshot (exchanges left out). Only the log-TVL slope is statistically strong (t = ' + f.slope_t.toFixed(2) + '); no category effect reaches |t| = 1.3. In-sample R² = ' + f.r2.toFixed(3) + ', residual σ = ' + f.sigma.toFixed(2) + ' log points.';
  $('validationText').textContent =
    'Out of sample — fit on the ' + f.holdout.n_train + ' live protocols listed before ' + f.holdout.split_date + ', predicted the ' + f.holdout.n_test + ' listed after: R² = ' + f.holdout.r2.toFixed(2) + ', mean absolute error ' + f.holdout.mae.toFixed(2) + ' log points, median ' + f.holdout.median_abs_err.toFixed(2) + '; the 50% and 80% bands cover ' + Math.round(f.holdout.coverage50 * 100) + '% and ' + Math.round(f.holdout.coverage80 * 100) + '% of the holdout. Five-fold cross-check: mean absolute error ' + f.cv.mae_mean.toFixed(2) + ', R² ' + f.cv.r2_mean.toFixed(2) + '. ' +
    'Growth, age and chain count were fitted and rejected: their t values are ' + f.tested.growth_t.toFixed(2) + ', ' + f.tested.age_t.toFixed(2) + ' and ' + f.tested.chains_t.toFixed(2) + ', and adding them makes the holdout error worse (R² ' + f.holdout_full.r2.toFixed(2) + ', error ' + f.holdout_full.mae.toFixed(2) + '). The median-multiple baseline on the same split scores R² ' + f.baseline_holdout.r2.toFixed(2) + ' with error ' + f.baseline_holdout.mae.toFixed(2) + '.';
  var mrows = (R.multiples || []).slice().sort(function (a, b) { return b.n - a.n || (a.category < b.category ? -1 : 1); });
  $('multipleRows').innerHTML = mrows.map(function (m) {
    // The spread is the middle half of the category's live ratios — shown only where five or
    // more names make quartiles mean something; fewer than five is flagged Low instead.
    var spread = m.n >= 5 ? m.q1.toFixed(3) + '–' + m.q3.toFixed(3) : '—';
    var eff = m.n >= 5 ? (m.effect >= 0 ? '+' : '') + m.effect.toFixed(2) : '—';
    var conf = m.n < 5 ? '<span class="lowconf">Low</span>' : '—';
    return '<tr><td>' + esc(m.category) + '</td><td class="num">' + m.n + '</td><td class="num">' +
      m.median.toFixed(3) + '</td><td class="num">' + spread + '</td><td class="num">' + eff + '</td><td class="num">' + m.fitted_multiple_100m.toFixed(3) + '</td><td>' + conf + '</td></tr>';
  }).join('');

  // Worked example, computed live from the top row: the model page shows the same
  // derivation the detail view shows, so the formula is never an empty claim.
  var top = R.rows.length ? R.rows[0] : null;
  if (top) {
    $('workedExample').innerHTML = 'Worked example — the top row, <b>' + esc(top.name) + '</b>: ' +
      'log(value) = ' + top.intercept.toFixed(2) + ' + ' + top.slope_log_tvl.toFixed(2) + ' × ' + top.log_tvl.toFixed(2) +
      ' ' + (top.category_effect >= 0 ? '+ ' : '− ') + Math.abs(top.category_effect).toFixed(2) + ' = ' + top.fitted_log_mcap.toFixed(2) +
      '; exp(' + top.fitted_log_mcap.toFixed(2) + ') = <b>' + money(top.implied_value_usd) + '</b>. ' +
      'The holdout band for this row runs ' + money(top.implied_low_usd) + '–' + money(top.implied_high_usd) + '. ' +
      'Every number above comes from this snapshot, not from a list.';
  }

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

  /** The first two chains, with a count for the rest: a table cell that lists twelve chains is unreadable. */
  function chainList(chains) {
    var shown = chains.slice(0, 2).map(esc).join(', ');
    return chains.length > 2 ? shown + ' +' + (chains.length - 2) : shown;
  }

  function rowHtml(r) {
    var g = r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down';
    var bar = Math.max(2, Math.round((r.implied_value_usd / topImplied) * 100));
    return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
      '<td class="num rank' + (r.rank <= 3 ? ' top3' : '') + '">' + r.rank + '</td>' +
      '<td>' + esc(r.name) + (watchlist[r.slug] ? ' <span class="pill watch">watchlist</span>' : '') + '<br><span class="sym">' + esc(r.slug) + '</span></td>' +
      '<td>' + esc(r.category || '—') + '</td>' +
      '<td>' + chainList(r.chains) + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td>' +
      '<td class="num ' + g + '">' + pct(r.change_7d) + '</td>' +
      '<td class="num">' + age(r.age_days) + '</td>' +
      '<td class="num"><span class="val">' + money(r.implied_value_usd) + '</span><span class="valbar"><span style="width:' + bar + '%"></span></span></td></tr>';
  }

  function render() {
    var list = filtered();
    $('rows').innerHTML = list.map(rowHtml).join('');
    $('count').textContent = list.length + ' of ' + R.rows.length + ' shown';
    document.querySelectorAll('#board thead th').forEach(function (th) {
      var k = th.getAttribute('data-k');
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (k === state.sort) th.classList.add(state.sort === 'rank' ? 'sorted-asc' : 'sorted-desc');
    });
    var showBoard = state.view === 'board';
    $('controls').style.display = showBoard ? '' : 'none';
    $('boardNote').style.display = showBoard ? '' : 'none';
    $('board').style.display = showBoard ? '' : 'none';
    $('liveWrap').hidden = state.view !== 'live';
    $('modelWrap').hidden = state.view !== 'model';
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-view') === state.view);
    });
  }

  function detail(r) {
    state.selected = r.slug;
    // The fitted derivation, in log space: intercept + slope × log(TVL) + category effect.
    var effectCap;
    if (r.category_n === 0) {
      effectCap = 'No fitted effect for ' + esc(r.category || 'Uncategorised') + ': fewer than five live names in this category, so the row takes the intercept — the model admits it does not know this category\u2019s premium.';
    } else {
      effectCap = esc(r.category || 'Uncategorised') + ': ' + r.category_n + ' live names, fitted effect ' +
        (r.category_effect >= 0 ? '+' : '') + r.category_effect.toFixed(2) + ' log points. No category effect is statistically strong, so this is a small nudge, not the story.';
    }
    var tvlCap = 'TVL ' + money(r.tvl_usd) + ', log(TVL) = ' + r.log_tvl.toFixed(2) + '; at the fitted slope ' + r.slope_log_tvl.toFixed(2) +
      ' this contributes ' + (r.slope_log_tvl * r.log_tvl).toFixed(2) + ' log points — value grows slower than TVL.';
    var leftOutCap = 'Growth (' + pct(r.change_7d) + ' over 7 days) and age (' + age(r.age_days) + ') are shown, not used: the fit tested them and they do not predict out of sample (t = ' +
      R.fit.tested.growth_t.toFixed(2) + ' and ' + R.fit.tested.age_t.toFixed(2) + '), so the model leaves them out rather than pretend they help.';
    var shownChains = r.chains.slice(0, 4).map(function (c) { return '<span class="pill">' + esc(c) + '</span>'; }).join('') +
      (r.chains.length > 4 ? '<span class="pill">+' + (r.chains.length - 4) + ' more</span>' : '');
    // Cautions from this row's own record, never from a guess: a sharp TVL fall, or a young
    // listing, earns a line of its own before the standing no-token note.
    var warnNotes = [];
    if (r.change_7d !== null && r.change_7d <= -20) {
      warnNotes.push('TVL fell ' + Math.abs(r.change_7d).toFixed(1) + '% in the last 7 days — check the protocol is still active before you bridge funds in.');
    }
    if (r.age_days !== null && r.age_days < 180) {
      warnNotes.push('Tracked under 180 days — a new listing: confirm the contracts are the protocol\u2019s own before depositing.');
    }
    warnNotes.push('This protocol records no token in the snapshot. That is what the data says, not proof it has none — check its own pages before you farm it.');
    // The band, not just the point: the holdout test's 10th–90th percentile errors, applied to
    // this row's fitted value. The point is a ranking device, not a price.
    var rangeLine = '';
    if (r.implied_low_usd !== null && r.implied_high_usd !== null && r.implied_low_usd < r.implied_high_usd) {
      rangeLine = '<p class="range">The holdout band for this row runs ' +
        money(r.implied_low_usd) + '–' + money(r.implied_high_usd) + ' — ' + money(r.implied_value_usd) +
        ' above is the fitted point, a ranking device, not a price.</p>';
    }
    var effSign = r.category_effect >= 0 ? '+ ' : '− ';
    var tvlTerm = r.slope_log_tvl * r.log_tvl;
    $('detail').innerHTML =
      '<h2>' + esc(r.name) + '</h2>' +
      '<div>' + (r.category ? '<span class="pill">' + esc(r.category) + '</span>' : '') + shownChains +
      (watchlist[r.slug] ? '<span class="pill watch">watchlist</span>' : '') + '</div>' +
      '<div class="facts">' +
      '<div><b>Rank</b>#' + r.rank + ' of ' + R.rows.length + '</div>' +
      '<div><b>Implied value</b>' + money(r.implied_value_usd) + '</div>' +
      '<div><b>Fitted band</b>' + money(r.implied_low_usd) + '–' + money(r.implied_high_usd) + '</div>' +
      '<div><b>TVL</b>' + money(r.tvl_usd) + '</div>' +
      '<div><b>7-day growth</b>' + pct(r.change_7d) + '</div>' +
      '<div><b>Tracked since</b>' + esc(r.listed_at || 'unknown') + ' (' + age(r.age_days) + ')</div>' +
      '<div><b>Token</b>records none</div></div>' +
      '<h3>Why this value</h3>' +
      '<div class="eqn">log(value) = ' + r.intercept.toFixed(2) + ' + ' + r.slope_log_tvl.toFixed(2) + ' × ' + r.log_tvl.toFixed(2) +
      ' ' + effSign + Math.abs(r.category_effect).toFixed(2) + ' = ' + r.fitted_log_mcap.toFixed(2) +
      '; exp(' + r.fitted_log_mcap.toFixed(2) + ') = <b>' + money(r.implied_value_usd) + '</b></div>' + rangeLine +
      // The audit trail: the running log value after each term, so a reader can re-add it.
      '<div class="chain">' +
      '<div><span>Intercept</span><span class="cmult"></span><span class="cval">' + r.intercept.toFixed(2) + '</span></div>' +
      '<div><span>TVL term · ' + r.slope_log_tvl.toFixed(2) + ' × log(TVL)</span><span class="cmult">+ ' + tvlTerm.toFixed(2) + '</span><span class="cval">' + (r.intercept + tvlTerm).toFixed(2) + '</span></div>' +
      '<div><span>Category effect · ' + esc(r.category || 'Uncategorised') + '</span><span class="cmult">' + effSign + Math.abs(r.category_effect).toFixed(2) + '</span><span class="cval">' + r.fitted_log_mcap.toFixed(2) + '</span></div>' +
      '<div><span>Implied value · exp(' + r.fitted_log_mcap.toFixed(2) + ')</span><span class="cmult"></span><span class="cval">' + money(r.implied_value_usd) + '</span></div></div>' +
      '<p class="note">Log values add; the last figure is the model\u2019s exact implied value.</p>' +
      '<div class="factor"><span>TVL term</span><span class="fval">' + r.slope_log_tvl.toFixed(2) + ' × log(TVL)</span><span class="cap">' + tvlCap + '</span></div>' +
      '<div class="factor"><span>Category effect</span><span class="fval">' + (r.category_effect >= 0 ? '+' : '') + r.category_effect.toFixed(2) + '</span><span class="cap">' + effectCap + '</span></div>' +
      '<div class="factor"><span>Left out</span><span class="fval">—</span><span class="cap">' + leftOutCap + '</span></div>' +
      '<h3>Farm plan</h3><ol>' + r.farm_steps.map(function (s) {
        return '<li>' + esc(s).replace(' Cost: ', ' <b>Cost:</b> ').replace(' Time: ', ' <b>Time:</b> ') + '</li>';
      }).join('') + '</ol>' +
      '<p class="warn">' + warnNotes.map(esc).join(' ') + '</p>';
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
