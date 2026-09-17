/**
 * The embeddable widget, served verbatim at GET /widget.js.
 *
 * Constraints that shape this file:
 *  - It runs on someone else's page, so: no globals beyond one guard flag, no
 *    framework, and all UI inside a shadow root so the host's CSS cannot reach
 *    in and ours cannot leak out.
 *  - It is a plain string (not a bundled module) so the Worker can serve it
 *    with no build step and cache it hard.
 *  - It derives both the API origin and the site key from its own <script src>,
 *    so the embed snippet is a single tag with nothing to configure.
 *
 * Kept free of backticks and ${ so it survives being a TS template literal.
 */
export const WIDGET_JS = `(function () {
  'use strict';
  if (window.__fbwidget) return;
  window.__fbwidget = true;

  var script = document.currentScript;
  if (!script) {
    var all = document.querySelectorAll('script[src*="widget.js"]');
    script = all[all.length - 1];
  }
  if (!script) return;

  var src = new URL(script.src, location.href);
  var key = src.searchParams.get('key') || script.getAttribute('data-key');
  var api = src.origin + '/api/report';
  if (!key) { console.warn('[fbwidget] missing ?key= on script tag'); return; }

  var LABEL = script.getAttribute('data-label') || 'Feedback';
  var TYPES = [
    { id: 'bug', label: 'Bug' },
    { id: 'idea', label: 'Idea' },
    { id: 'praise', label: 'Praise' }
  ];

  var host = document.createElement('div');
  host.setAttribute('data-fbwidget', '');
  var root = host.attachShadow({ mode: 'open' });
  var css = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    '.wrap{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:10px}',
    '.btn{border:0;border-radius:999px;background:#111827;color:#fff;padding:11px 18px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.18)}',
    '.btn:hover{background:#1f2937}',
    '.panel{width:320px;max-width:calc(100vw - 32px);background:#fff;color:#111827;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.22);padding:16px;display:none}',
    '.panel.open{display:block}',
    '.row{display:flex;gap:8px;margin-bottom:10px}',
    '.chip{flex:1;border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:7px 0;font-size:13px;cursor:pointer;color:#374151}',
    '.chip[aria-pressed="true"]{border-color:#111827;background:#111827;color:#fff}',
    'textarea,input{width:100%;border:1px solid #d1d5db;border-radius:8px;padding:9px;font-size:14px;color:#111827;background:#fff}',
    'textarea{min-height:96px;resize:vertical;margin-bottom:8px}',
    'input{margin-bottom:10px}',
    'textarea:focus,input:focus{outline:2px solid #111827;outline-offset:-1px}',
    '.send{width:100%;border:0;border-radius:8px;background:#111827;color:#fff;padding:10px;font-size:14px;font-weight:600;cursor:pointer}',
    '.send[disabled]{opacity:.55;cursor:default}',
    '.head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}',
    '.title{font-size:15px;font-weight:600}',
    '.x{border:0;background:none;font-size:18px;line-height:1;cursor:pointer;color:#6b7280;padding:0 2px}',
    '.msg{font-size:12px;margin-top:8px;min-height:15px}',
    '.err{color:#b91c1c}.ok{color:#047857}',
    '.count{font-size:11px;color:#6b7280;text-align:right;margin:-4px 0 8px}'
  ].join('');

  root.innerHTML =
    '<style>' + css + '</style>' +
    '<div class="wrap">' +
      '<div class="panel" part="panel" role="dialog" aria-label="Send feedback">' +
        '<div class="head"><span class="title">Send feedback</span>' +
        '<button class="x" type="button" aria-label="Close">&times;</button></div>' +
        '<div class="row">' +
          TYPES.map(function (t) {
            return '<button class="chip" type="button" data-type="' + t.id + '" aria-pressed="' +
              (t.id === 'bug' ? 'true' : 'false') + '">' + t.label + '</button>';
          }).join('') +
        '</div>' +
        '<textarea maxlength="2000" placeholder="What happened, or what would you like?"></textarea>' +
        '<div class="count">0 / 2000</div>' +
        '<input type="email" placeholder="Email (optional)" />' +
        '<button class="send" type="button">Send</button>' +
        '<div class="msg"></div>' +
      '</div>' +
      '<button class="btn" type="button">' + LABEL + '</button>' +
    '</div>';

  var q = function (s) { return root.querySelector(s); };
  var panel = q('.panel'), textarea = q('textarea'), email = q('input');
  var send = q('.send'), msg = q('.msg'), count = q('.count');
  var chips = root.querySelectorAll('.chip');
  var type = 'bug';

  function setMsg(text, cls) { msg.textContent = text; msg.className = 'msg ' + (cls || ''); }
  function toggle(open) {
    panel.classList.toggle('open', open);
    if (open) { setMsg(''); textarea.focus(); }
  }

  q('.btn').addEventListener('click', function () { toggle(!panel.classList.contains('open')); });
  q('.x').addEventListener('click', function () { toggle(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') toggle(false); });

  Array.prototype.forEach.call(chips, function (chip) {
    chip.addEventListener('click', function () {
      type = chip.getAttribute('data-type');
      Array.prototype.forEach.call(chips, function (c) {
        c.setAttribute('aria-pressed', String(c === chip));
      });
    });
  });

  textarea.addEventListener('input', function () {
    count.textContent = textarea.value.length + ' / 2000';
  });

  send.addEventListener('click', function () {
    var message = textarea.value.trim();
    if (!message) { setMsg('Please write a message first.', 'err'); return; }
    send.disabled = true;
    setMsg('Sending...');
    fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: key,
        type: type,
        message: message,
        email: email.value.trim() || null,
        pageUrl: location.href,
        viewport: window.innerWidth + 'x' + window.innerHeight
      })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.error || 'Request failed (' + r.status + ')');
        return b;
      });
    }).then(function () {
      setMsg('Thanks! Your feedback was sent.', 'ok');
      textarea.value = ''; email.value = ''; count.textContent = '0 / 2000';
      setTimeout(function () { toggle(false); }, 1400);
    }).catch(function (e) {
      setMsg(e.message || 'Could not send. Please try again.', 'err');
    }).then(function () {
      send.disabled = false;
    });
  });

  (document.body || document.documentElement).appendChild(host);
})();
`
