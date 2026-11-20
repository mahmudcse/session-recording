// Stand-in for a third-party tag (ad / analytics snippet). Once injected into the
// page it phones home on its own - exactly the kind of call the recorder should
// attribute back to this file via the "initiator" column.
(function () {
  new Image().src = '/mock/pixel.gif?src=third-party-tag&cb=' + Math.random();

  fetch('/mock/json?id=tag-config')
    .then(function (response) { return response.json(); })
    .then(function () {
      navigator.sendBeacon('/mock/echo?tag=impression', JSON.stringify({ impression: 1 }));

      // Tags often pull in further scripts of their own.
      var next = document.createElement('script');
      next.src = 'https://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js';
      document.head.appendChild(next);
    });
})();
