/*!
 * Network call recorder.
 *
 * Captures every network call the page makes and posts them in batches to a
 * collector. Load it as the FIRST script in <head> so it can hook fetch / XHR
 * before any other script (including third-party tags) gets to run:
 *
 *   <script src="/js/recorder.js" data-endpoint="/collect"></script>
 *
 * How it sees calls:
 *   1. Resource Timing (PerformanceObserver) is the source of truth: the browser
 *      reports every request there, whoever made it - markup, CSS, or any script.
 *   2. Hooks on fetch / XHR / sendBeacon / element src setters add what Resource
 *      Timing lacks: HTTP method, status, errors, and the call stack that says
 *      WHICH script triggered the call. Both are merged into one record per call.
 *   3. WebSocket / EventSource are not in Resource Timing, so hooks record them.
 *
 * Same-origin iframes get the same instrumentation. Cross-origin iframes are
 * off limits to the parent page: only the iframe document's own load is seen.
 */
(function () {
  'use strict';
  if (window.netRecorder) return;   // included twice

  const script = document.currentScript;
  const SELF = script ? script.src : '';
  const ENDPOINT = new URL((script && script.dataset.endpoint) || '/collect', SELF || location.href).href;
  const FLUSH_MS = 2000;
  const BATCH_SIZE = 40;      // keeps each upload well under the 64 KB sendBeacon limit
  const MAX_PENDING = 2000;   // stop re-queueing failed uploads beyond this (collector down)
  const SETTLE_MS = 1000;     // how long a finished call waits for its Resource Timing entry

  // Natives, saved before patching so the recorder's own uploads are not recorded.
  const nativeFetch = window.fetch.bind(window);
  const nativeBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);

  const meta = {
    session_id: sessionId(),
    page_id: randomId(),
    page_url: location.href,
    referrer: document.referrer,
    started_at: Math.round(performance.timeOrigin),
  };

  let seq = 0;
  let navigation = null;        // the record for the page document itself
  const pending = new Set();    // records to upload; a record is re-added whenever it gains detail
  const awaiting = new Map();   // url -> hook records waiting for their Resource Timing entry
  const timed = new WeakSet();  // records that already have their Resource Timing entry
  const hookedWindows = new WeakSet();
  const watchedDocuments = new WeakSet();
  const scriptedElements = new WeakSet();   // elements whose URL was set from JavaScript

  function randomId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function sessionId() {
    try {
      return sessionStorage.netRecorderSession || (sessionStorage.netRecorderSession = randomId());
    } catch (e) {
      return randomId();   // storage blocked
    }
  }

  function absolute(win, url) {
    try {
      return new URL(String(url), win.document.baseURI).href.split('#')[0];
    } catch (e) {
      return String(url);
    }
  }

  // Stack frames of whoever called into a hook, without the recorder's own frames.
  function callStack() {
    return String(new Error().stack || '').split('\n')
      .map((line) => line.trim().replace(/^at /, ''))
      .filter((line) => /:\d+/.test(line) && (!SELF || line.indexOf(SELF) === -1))
      .slice(0, 8);
  }

  // ---- records ------------------------------------------------------------

  function record(win, type, url, method) {
    return {
      seq: ++seq,
      ts: Date.now(),
      type: type,
      url: absolute(win, url),
      method: method ? String(method).toUpperCase() : null,
      frame: win === window ? null : win.location.href,
    };
  }

  // A record for a call made from JavaScript: remember which script asked for it.
  function scripted(win, type, url, method) {
    const rec = record(win, type, url, method);
    rec.stack = callStack();
    const from = /\w+:\/\/[^\s()]+/.exec(rec.stack.join(' '));
    rec.initiator = from ? from[0] : null;
    return rec;
  }

  // Park a hook record until the browser's timing entry for the same URL shows up.
  function expectTiming(rec) {
    if (awaiting.size > 1000) awaiting.delete(awaiting.keys().next().value);
    const list = awaiting.get(rec.url) || [];
    list.push(rec);
    awaiting.set(rec.url, list);
    return rec;
  }

  function claim(url, rec) {
    const list = awaiting.get(url);
    const index = !list ? -1 : rec ? list.indexOf(rec) : 0;
    if (index === -1) return null;
    const found = list.splice(index, 1)[0];
    if (!list.length) awaiting.delete(url);
    return found;
  }

  // A hooked call finished. Normally its timing entry is here already or arrives
  // within moments; if not (request blocked, never left the browser, still
  // streaming) upload what we know. A later entry still merges into the same row.
  function settle(rec, status, error) {
    if (status) rec.status = status;
    if (error) rec.error = error;
    if (timed.has(rec)) return pending.add(rec);
    setTimeout(function () {
      if (timed.has(rec)) return;
      if (rec.error) claim(rec.url, rec);   // failed: no entry is coming, stop waiting
      pending.add(rec);
    }, SETTLE_MS);
  }

  // Time-to-response as seen by a hook. Used until the browser's own timing
  // arrives - which it never does for a fetch whose body is not read.
  function elapsed(rec) {
    if (!timed.has(rec)) rec.duration = Date.now() - rec.ts;
    return rec;
  }

  function onTimingEntry(win, entry) {
    const url = entry.name.split('#')[0];
    if (url.indexOf(ENDPOINT) === 0) return;   // the recorder's own uploads
    const type = entry.initiatorType === 'xmlhttprequest' ? 'xhr' : entry.initiatorType || 'other';
    let rec;
    if (entry.entryType === 'navigation') {
      // Delivered once while the page is loading and again when it is complete.
      rec = navigation || (navigation = record(win, type, url));
    } else {
      rec = claim(url) || record(win, type, url);   // a hook's record keeps its own, more specific type
    }
    rec.ts = Math.round(win.performance.timeOrigin + entry.startTime);
    rec.duration = Math.round(entry.duration * 10) / 10;
    rec.size = entry.transferSize;
    rec.bodySize = entry.decodedBodySize;
    rec.protocol = entry.nextHopProtocol || null;
    if (entry.responseStatus) rec.status = entry.responseStatus;
    if (entry.responseStart > 0) rec.ttfb = Math.round((entry.responseStart - entry.startTime) * 10) / 10;
    timed.add(rec);
    pending.add(rec);
  }

  // ---- instrumentation (applied to the page and every same-origin iframe) ---

  function instrument(win) {
    const doc = win.document;   // throws for cross-origin frames; callers catch

    if (!hookedWindows.has(win)) {
      hookedWindows.add(win);
      const observer = new win.PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) { onTimingEntry(win, entry); });
      });
      observer.observe({ type: 'resource', buffered: true });
      if (win === window) observer.observe({ type: 'navigation', buffered: true });

      hookFetch(win);
      hookXhr(win);
      hookBeacon(win);
      hookSockets(win);
      hookElements(win);
    }
    // A frame can keep its window while getting a new document, so track both.
    if (!watchedDocuments.has(doc)) {
      watchedDocuments.add(doc);
      watchFrames(win);
    }
  }

  function hookFetch(win) {
    const fetch = win.fetch;
    if (!fetch) return;
    win.fetch = function (input, init) {
      const isRequest = input && typeof input === 'object' && 'url' in input;
      const method = (init && init.method) || (isRequest && input.method) || 'GET';
      const rec = expectTiming(scripted(win, 'fetch', isRequest ? input.url : input, method));
      return fetch.apply(this, arguments).then(
        function (response) { settle(elapsed(rec), response.status); return response; },
        function (err) { settle(elapsed(rec), null, String((err && err.message) || err)); throw err; });
    };
  }

  function hookXhr(win) {
    const proto = win.XMLHttpRequest.prototype;
    const open = proto.open;
    const send = proto.send;
    const opened = new WeakMap();
    proto.open = function (method, url) {
      opened.set(this, { method: method, url: url });
      return open.apply(this, arguments);
    };
    proto.send = function () {
      const xhr = this;
      const call = opened.get(xhr);
      if (call) {
        const rec = expectTiming(scripted(win, 'xhr', call.url, call.method));
        ['error', 'abort', 'timeout'].forEach(function (failure) {
          xhr.addEventListener(failure, function () { rec.error = failure; });
        });
        xhr.addEventListener('loadend', function () { settle(elapsed(rec), xhr.status); });
      }
      return send.apply(xhr, arguments);
    };
  }

  function hookBeacon(win) {
    const beacon = win.navigator.sendBeacon;
    if (!beacon) return;
    win.navigator.sendBeacon = function (url) {
      const queued = beacon.apply(this, arguments);
      settle(expectTiming(scripted(win, 'beacon', url, 'POST')), null, queued ? null : 'rejected by browser');
      return queued;
    };
  }

  function hookSockets(win) {
    ['WebSocket', 'EventSource'].forEach(function (name) {
      if (!win[name]) return;
      win[name] = new Proxy(win[name], {
        construct: function (target, args, newTarget) {
          const connection = Reflect.construct(target, args, newTarget);
          const rec = scripted(win, name.toLowerCase(), args[0]);
          // Upload right away: these stay open indefinitely. An event stream does
          // get a timing entry once it closes; a WebSocket never does.
          pending.add(name === 'EventSource' ? expectTiming(rec) : rec);
          return connection;
        },
      });
    });
  }

  // Requests started by pointing an element at a URL from JavaScript:
  // new Image().src = ..., injected <script> / <iframe> / <link> tags.
  // The request itself shows up in Resource Timing; this only adds the initiator.
  function hookElements(win) {
    const urlAttr = { IMG: 'src', SCRIPT: 'src', IFRAME: 'src', LINK: 'href' };
    const remember = function (el, value) {
      const rec = scripted(win, el.tagName.toLowerCase(), value);
      if (!/^https?:/.test(rec.url)) return;
      expectTiming(rec);
      scriptedElements.add(el);
      // A failed cross-origin load looks like a successful one in Resource Timing,
      // so the element's own error event is the only way to tell.
      el.addEventListener('error', function () {
        if (absolute(win, el.src || el.href) === rec.url) settle(rec, null, 'load failed');
      }, { once: true });
    };

    ['HTMLImageElement', 'HTMLScriptElement', 'HTMLIFrameElement', 'HTMLLinkElement'].forEach(function (cls) {
      const proto = win[cls].prototype;
      const prop = cls === 'HTMLLinkElement' ? 'href' : 'src';
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) return;
      Object.defineProperty(proto, prop, Object.assign({}, desc, {
        set: function (value) { remember(this, value); return desc.set.call(this, value); },
      }));
    });

    const setAttribute = win.Element.prototype.setAttribute;
    win.Element.prototype.setAttribute = function (name, value) {
      if (urlAttr[this.tagName] === String(name).toLowerCase()) remember(this, value);
      return setAttribute.apply(this, arguments);
    };

    // Elements from the page markup that failed without leaving a Resource Timing
    // entry (blocked by an ad blocker / CSP, for instance) would otherwise go unseen.
    win.addEventListener('error', function (event) {
      const el = event.target;
      const url = el && el !== win && !scriptedElements.has(el) && (el.src || el.href);
      if (typeof url !== 'string' || !/^https?:/.test(url)) return;   // a JS error, not a resource
      const clean = url.split('#')[0];
      if (win.performance.getEntriesByName(clean).length) return;    // already reported by the browser
      settle(expectTiming(record(win, el.tagName.toLowerCase(), clean)), null, 'load failed');
    }, true);
  }

  function watchFrames(win) {
    const adopt = function (frame) {
      const tryInstrument = function () {
        try { instrument(frame.contentWindow); } catch (e) { /* cross-origin frame */ }
      };
      // A navigation swaps in a fresh window, so hook again on every load. Calls a
      // frame makes before that are still captured (buffered timing entries), only
      // without method / initiator.
      frame.addEventListener('load', tryInstrument);
      tryInstrument();
    };
    new win.MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.tagName === 'IFRAME') adopt(node);
          else if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(adopt);
        });
      });
    }).observe(win.document, { childList: true, subtree: true });
    win.document.querySelectorAll('iframe').forEach(adopt);
  }

  // ---- upload -------------------------------------------------------------

  function flush(isFinal) {
    const records = Array.from(pending);
    pending.clear();
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      // A string body goes out as text/plain: no CORS preflight when the
      // collector lives on another origin.
      const body = JSON.stringify(Object.assign({ events: chunk }, meta));
      if (isFinal === true && nativeBeacon) {
        nativeBeacon(ENDPOINT, body);   // survives the page being closed
      } else {
        nativeFetch(ENDPOINT, { method: 'POST', body: body, credentials: 'omit' }).catch(function () {
          // Collector unreachable: try again on the next tick (rows are upserted, so resending is safe).
          if (pending.size < MAX_PENDING) chunk.forEach(function (rec) { pending.add(rec); });
        });
      }
    }
  }

  instrument(window);
  setInterval(flush, FLUSH_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', function () { flush(true); });

  window.netRecorder = { pageId: meta.page_id, flush: flush };
})();
