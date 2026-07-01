// Embeddable chat widget — served at GET /embed.js

export function buildEmbedScript(baseUrl) {
  const origin = JSON.stringify(baseUrl.replace(/\/$/, ''));
  return `(function(){
  var s = document.currentScript;
  var workerId = s && s.getAttribute('data-worker');
  var apiKey = s && s.getAttribute('data-key');
  var label = (s && s.getAttribute('data-label')) || 'צ\\'אט';
  var pos = (s && s.getAttribute('data-position')) || 'right';
  if (!workerId) { console.warn('[ai-workers] embed.js: missing data-worker'); return; }
  var base = ${origin};
  var root = document.createElement('div');
  root.id = 'aiw-embed-root';
  root.setAttribute('dir', 'rtl');
  root.innerHTML = '<style>#aiw-embed-root{position:fixed;bottom:20px;z-index:2147483000;font-family:system-ui,sans-serif}' +
    '#aiw-embed-root[data-pos=left]{left:20px;right:auto}#aiw-embed-root[data-pos=right]{right:20px;left:auto}' +
    '#aiw-embed-btn{background:#d4a24a;color:#111;border:none;border-radius:999px;padding:14px 20px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25)}' +
    '#aiw-embed-panel{display:none;position:absolute;bottom:56px;width:min(360px,calc(100vw - 40px));height:420px;background:#1a1a1f;border:1px solid #333;border-radius:16px;overflow:hidden;flex-direction:column}' +
    '#aiw-embed-panel.open{display:flex}#aiw-embed-head{padding:12px 14px;background:#222;color:#fff;font-size:14px;font-weight:600}' +
    '#aiw-embed-msgs{flex:1;overflow:auto;padding:12px;font-size:13px;color:#e8e8e8}' +
    '#aiw-embed-msgs .u{text-align:left;color:#9cf;margin:8px 0}#aiw-embed-msgs .a{text-align:right;margin:8px 0}' +
    '#aiw-embed-foot{display:flex;gap:8px;padding:10px;border-top:1px solid #333}#aiw-embed-input{flex:1;border:1px solid #444;background:#111;color:#fff;border-radius:8px;padding:8px 10px}' +
    '#aiw-embed-send{background:#d4a24a;border:none;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer}</style>' +
    '<button type="button" id="aiw-embed-btn"></button><div id="aiw-embed-panel"><div id="aiw-embed-head"></div><div id="aiw-embed-msgs"></div><div id="aiw-embed-foot"><input id="aiw-embed-input" placeholder="כתוב הודעה..." /><button type="button" id="aiw-embed-send">שלח</button></div></div>';
  document.body.appendChild(root);
  root.setAttribute('data-pos', pos === 'left' ? 'left' : 'right');
  var btn = root.querySelector('#aiw-embed-btn');
  var panel = root.querySelector('#aiw-embed-panel');
  var head = root.querySelector('#aiw-embed-head');
  var msgs = root.querySelector('#aiw-embed-msgs');
  var input = root.querySelector('#aiw-embed-input');
  var sendBtn = root.querySelector('#aiw-embed-send');
  btn.textContent = label;
  var customerId = 'embed_' + Math.random().toString(36).slice(2, 10);
  var workerName = label;
  fetch(base + '/api/embed/config?workerId=' + encodeURIComponent(workerId))
    .then(function(r){ return r.json(); })
    .then(function(j){ if (j.name) { workerName = j.name; head.textContent = j.name; btn.textContent = j.name; } else { head.textContent = label; } })
    .catch(function(){ head.textContent = label; });
  btn.onclick = function(){ panel.classList.toggle('open'); };
  function append(role, text) {
    var d = document.createElement('div');
    d.className = role === 'user' ? 'u' : 'a';
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function sendMsg() {
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    append('user', text);
    var headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    fetch(base + '/api/embed/chat', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ workerId: workerId, message: text, customerId: customerId })
    }).then(function(r){ return r.json(); })
      .then(function(j){
        if (j.reply) append('assistant', j.reply);
        else append('assistant', j.message || j.error || 'שגיאה בשליחה');
      })
      .catch(function(){ append('assistant', 'לא ניתן להתחבר לשרת'); });
  }
  sendBtn.onclick = sendMsg;
  input.addEventListener('keydown', function(e){ if (e.key === 'Enter') sendMsg(); });
})();`;
}
