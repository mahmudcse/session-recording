// Fires many different kinds of network calls so the recorder has something to capture.
$(function () {
  const API = 'https://jsonplaceholder.typicode.com';
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs';
  const DEAD = 'https://tracker.invalid';   // .invalid never resolves: a guaranteed network failure
  const started = Date.now();
  let run = 0;

  function log(text) {
    $('<li>').text('+' + ((Date.now() - started) / 1000).toFixed(1) + 's  ' + text).appendTo('#log');
  }

  const actions = {
    ajax: function () {
      log('jQuery AJAX: 8 calls (GET / POST / PUT, slow, 404, 500, cross-origin API)');
      $.getJSON('/mock/json', { id: 'ajax-' + run });
      $.getJSON('/mock/json', { id: 'slow-' + run, delay: 800 });
      $.post('/mock/echo', { hello: 'world' });
      $.ajax({ url: '/mock/echo', method: 'PUT', contentType: 'application/json', data: JSON.stringify({ run: run }) });
      $.get('/mock/status/404');
      $.get('/mock/status/500');
      $.getJSON(API + '/posts/1');
      $.getJSON(API + '/users', { _limit: 3 });
    },

    fetches: function () {
      log('fetch(): 5 calls (GET, POST, cross-origin, opaque no-cors, DNS failure)');
      fetch('/mock/json?id=fetch-' + run);
      fetch('/mock/echo', { method: 'POST', body: JSON.stringify({ from: 'fetch' }) });
      fetch(API + '/todos/1');
      fetch('https://example.com/', { mode: 'no-cors' }).catch($.noop);
      fetch(DEAD + '/collect?uid=42').catch($.noop);
    },

    images: function () {
      log('Images: 4 injected <img>, 2 tracking pixels via new Image(), 1 broken image');
      for (let i = 1; i <= 4; i++) {
        $('<img>', { src: 'https://picsum.photos/seed/run' + run + '-' + i + '/160/100', alt: '' }).appendTo('#gallery');
      }
      new Image().src = '/mock/pixel.gif?event=pageview&run=' + run;
      new Image().src = DEAD + '/pixel.gif?uid=42&run=' + run;
      $('<img>', { src: '/mock/status/404?broken-image-' + run, alt: '' }).appendTo('#gallery');
    },

    cdn: function () {
      log('CDN: script via $.getScript + stylesheet via injected <link>');
      $.getScript(CDN + '/dayjs/1.11.13/dayjs.min.js');
      $('<link>', { rel: 'stylesheet', href: CDN + '/animate.css/4.1.1/animate.min.css' }).appendTo('head');
    },

    tag: function () {
      log('Injected js/third-party-tag.js, which makes its own calls (pixel, fetch, beacon, another script)');
      const tag = document.createElement('script');
      tag.src = 'js/third-party-tag.js?run=' + run;
      tag.async = true;
      document.head.appendChild(tag);
    },

    beacon: function () {
      log('navigator.sendBeacon: 1 call');
      navigator.sendBeacon('/mock/echo?beacon=' + run, JSON.stringify({ event: 'heartbeat', run: run }));
    },

    frames: function () {
      log('Iframes: same-origin frame.html (makes its own calls) + cross-origin example.com');
      $('#frames').empty()
        .append($('<iframe>', { src: 'frame.html?run=' + run, title: 'Same-origin frame' }))
        .append($('<iframe>', { src: 'https://example.com/', title: 'Cross-origin frame' }));
    },

    sockets: function () {
      log('WebSocket to /mock/ws + EventSource on /mock/sse');
      new WebSocket('ws://' + location.host + '/mock/ws?run=' + run);
      const stream = new EventSource('/mock/sse?run=' + run);
      let ticks = 0;
      stream.onmessage = function () { if (++ticks === 3) stream.close(); };
      stream.onerror = function () { stream.close(); };
    },

    polling: function () {
      log('Polling: 5 calls, one every 2 seconds');
      const thisRun = run;
      let n = 0;
      const timer = setInterval(function () {
        $.getJSON('/mock/json', { poll: thisRun + '-' + (++n) });
        if (n === 5) clearInterval(timer);
      }, 2000);
    },
  };

  function fire(name) {
    run++;
    actions[name]();
  }

  $('.actions').on('click', 'button', function () { fire($(this).data('action')); });
  $('#viewer-link').attr('href', 'viewer.html?page_id=' + encodeURIComponent(window.netRecorder.pageId));

  // Everything runs once on its own, spread over the first few seconds after load.
  ['ajax', 'fetches', 'images', 'cdn', 'tag', 'beacon', 'frames', 'sockets', 'polling'].forEach(function (name, i) {
    setTimeout(function () { fire(name); }, i * 400);
  });
});
