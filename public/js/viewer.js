// Reads the captured calls back from the server and renders them.
// Captured URLs are untrusted input: everything goes through .text(), never .html().
$(function () {
  let pageId = new URLSearchParams(location.search).get('page_id');
  let pageviews = [];
  let calls = [];
  const expanded = new Set();   // seq numbers of rows whose detail is open

  const isFailed = (call) => Boolean(call.error) || call.status >= 400;
  const clock = (ms) => new Date(ms).toLocaleTimeString();

  function bytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' kB';
    return n + ' B';
  }

  // "http://host/js/demo.js?v=1:42:7" -> "demo.js:42"
  function shortRef(ref) {
    return ref.replace(/:\d+$/, '').replace(/\?[^:]*/, '').split('/').pop() || ref;
  }

  // The scripts on the call stack, innermost first: "jquery.min.js:2 ← demo.js:16".
  // The first one issued the request; the ones after it are who asked for it.
  function initiatorChain(call) {
    const chain = [];
    (call.detail.stack || []).forEach(function (frame) {
      const ref = /\w+:\/\/[^\s()]+/.exec(frame);
      if (!ref) return;
      const short = shortRef(ref[0]);
      const file = short.split(':')[0];
      if (!chain.some((seen) => seen.split(':')[0] === file)) chain.push(short);
    });
    return chain.join(' ← ');
  }

  function sizeLabel(call) {
    if (call.size_bytes > 0) return bytes(call.size_bytes);
    return call.detail.body_size > 0 ? 'cached' : '—';   // "—": not exposed for this cross-origin call
  }

  function statusLabel(call) {
    if (call.status) return String(call.status);
    return call.error ? 'failed' : '—';
  }

  function refresh() {
    return $.getJSON('/api/pageviews').then(function (rows) {
      pageviews = rows;
      if (!pageId && rows.length) pageId = rows[0].page_id;

      const $select = $('#pageview').empty();
      if (pageId && !rows.some((p) => p.page_id === pageId)) {
        $('<option>').val(pageId).text('Waiting for the first batch…').appendTo($select);
      }
      rows.forEach(function (p) {
        $('<option>').val(p.page_id)
          .text(clock(p.started_at) + '  ·  ' + p.page_url + '  ·  ' + p.calls + ' calls')
          .appendTo($select);
      });
      $select.val(pageId);

      return pageId ? $.getJSON('/api/calls', { page_id: pageId }) : [];
    }).then(function (rows) {
      calls = rows;
      render();
    });
  }

  function render() {
    renderSummary();
    renderHosts();
    renderTypeFilter();
    renderCalls();
  }

  function renderSummary() {
    const transferred = calls.reduce((sum, c) => sum + (c.size_bytes || 0), 0);
    const stats = [
      [calls.length, 'calls'],
      [calls.filter((c) => c.third_party).length, 'third-party'],
      [calls.filter(isFailed).length, 'failed'],
      [new Set(calls.map((c) => c.host)).size, 'hosts'],
      [bytes(transferred), 'transferred'],
    ];
    const $summary = $('#summary').empty();
    stats.forEach(function (stat) {
      $('<div class="stat">').append($('<strong>').text(stat[0]), $('<span>').text(stat[1])).appendTo($summary);
    });
  }

  function renderHosts() {
    const byHost = new Map();
    calls.forEach(function (c) {
      const host = byHost.get(c.host) || { thirdParty: c.third_party, calls: 0, failed: 0, size: 0, types: new Set() };
      host.calls++;
      host.failed += isFailed(c) ? 1 : 0;
      host.size += c.size_bytes || 0;
      host.types.add(c.type);
      byHost.set(c.host, host);
    });

    const $body = $('#hosts tbody').empty();
    Array.from(byHost).sort((a, b) => b[1].calls - a[1].calls).forEach(function (entry) {
      const host = entry[1];
      $('<tr>').append(
        $('<td>').text(entry[0] || '(unknown)'),
        $('<td>').append($('<span class="tag">').toggleClass('third', Boolean(host.thirdParty))
          .text(host.thirdParty ? 'third-party' : 'first-party')),
        $('<td class="num">').text(host.calls),
        $('<td class="num">').text(host.failed || ''),
        $('<td class="num">').text(host.size ? bytes(host.size) : '—'),
        $('<td class="muted">').text(Array.from(host.types).sort().join(', '))
      ).appendTo($body);
    });
  }

  function renderTypeFilter() {
    const $type = $('#type');
    const selected = $type.val();
    $type.find('option:not(:first)').remove();
    Array.from(new Set(calls.map((c) => c.type))).sort().forEach(function (type) {
      $('<option>').val(type).text(type).appendTo($type);
    });
    $type.val(selected);
    if ($type.val() === null) $type.val('');
  }

  function renderCalls() {
    const search = $('#search').val().trim().toLowerCase();
    const type = $('#type').val();
    const thirdOnly = $('#third-party').prop('checked');
    const failedOnly = $('#failed').prop('checked');
    const page = pageviews.find((p) => p.page_id === pageId);

    const visible = calls.filter(function (c) {
      if (type && c.type !== type) return false;
      if (thirdOnly && !c.third_party) return false;
      if (failedOnly && !isFailed(c)) return false;
      return !search || ((c.url || '') + ' ' + (c.detail.stack || []).join(' ')).toLowerCase().includes(search);
    });

    const $body = $('#calls tbody').empty();
    visible.forEach(function (c) {
      let path = c.url || '';
      try { const u = new URL(c.url); path = u.pathname + u.search; } catch (e) { /* keep raw */ }

      $('<tr class="call">').toggleClass('failed', isFailed(c)).data('seq', c.seq).append(
        $('<td class="num muted">').text(page ? '+' + ((c.ts - page.started_at) / 1000).toFixed(2) + 's' : ''),
        $('<td>').append($('<span class="tag">').text(c.type), c.frame ? $('<span class="tag frame">').text('iframe') : null),
        $('<td>').text(c.method || ''),
        $('<td class="status">').text(statusLabel(c)),
        $('<td class="url">').attr('title', c.url).append(
          $('<strong>').toggleClass('third', Boolean(c.third_party)).text(c.host || ''), document.createTextNode(path)),
        $('<td class="num">').text(c.duration_ms == null ? '—' : Math.round(c.duration_ms) + ' ms'),
        $('<td class="num">').text(sizeLabel(c)),
        $('<td class="muted">').attr('title', c.initiator || '').text(initiatorChain(c) || '—')
      ).appendTo($body);

      if (expanded.has(c.seq)) detailRow(c).appendTo($body);
    });
    $('#empty').prop('hidden', calls.length > 0);
  }

  function detailRow(c) {
    const facts = [
      ['URL', c.url],
      ['Error', c.error],
      ['Protocol', c.protocol],
      ['Time to first byte', c.detail.ttfb == null ? null : c.detail.ttfb + ' ms'],
      ['Body size', c.detail.body_size ? bytes(c.detail.body_size) : null],
      ['Inside iframe', c.frame],
      ['Call stack', (c.detail.stack || []).join('\n')],
    ];
    const $list = $('<dl>');
    facts.forEach(function (fact) {
      if (fact[1]) $list.append($('<dt>').text(fact[0]), $('<dd>').text(fact[1]));
    });
    return $('<tr class="detail">').append($('<td colspan="8">').append($list));
  }

  $('#calls tbody').on('click', 'tr.call', function () {
    const seq = $(this).data('seq');
    if (!expanded.delete(seq)) expanded.add(seq);
    renderCalls();
  });
  $('#search').on('input', renderCalls);
  $('#type, #third-party, #failed').on('change', renderCalls);
  $('#pageview').on('change', function () {
    pageId = $(this).val();
    expanded.clear();
    refresh();
  });
  $('#refresh').on('click', refresh);
  $('#clear').on('click', function () {
    if (!window.confirm('Delete every captured page view and call?')) return;
    $.ajax({ url: '/api/calls', method: 'DELETE' }).then(function () {
      pageId = null;
      expanded.clear();
      refresh();
    });
  });

  setInterval(function () {
    if ($('#auto').prop('checked')) refresh();
  }, 3000);
  refresh();
});
