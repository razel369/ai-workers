// Embeddable chat widget — served at GET /embed.js

export function buildEmbedScript(baseUrl) {
  const origin = JSON.stringify(baseUrl.replace(/\/$/, ''));
  return `(function(){
	  var s = document.currentScript;
	  var workerId = s && s.getAttribute('data-worker');
	  var label = (s && s.getAttribute('data-label')) || 'צ\\'אט';
  var pos = (s && s.getAttribute('data-position')) || 'right';
  if (!workerId) { console.warn('[ai-workers] embed.js: missing data-worker'); return; }
  var base = ${origin};
	  var root = document.createElement('div');
	  root.id = 'aiw-embed-root';
	  root.setAttribute('dir', 'rtl');
	  var style = document.createElement('style');
	  style.textContent = '#aiw-embed-root{position:fixed;bottom:20px;z-index:2147483000;font-family:system-ui,sans-serif}' +
	    '#aiw-embed-root[data-pos=left]{left:20px;right:auto}#aiw-embed-root[data-pos=right]{right:20px;left:auto}' +
	    '#aiw-embed-btn{background:#d4a24a;color:#111;border:none;border-radius:999px;padding:14px 20px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25)}' +
	    '#aiw-embed-panel{display:none;position:absolute;bottom:56px;width:min(360px,calc(100vw - 40px));height:420px;background:#1a1a1f;border:1px solid #333;border-radius:16px;overflow:hidden;flex-direction:column}' +
	    '#aiw-embed-panel.open{display:flex}#aiw-embed-head{padding:12px 14px;background:#222;color:#fff;font-size:14px;font-weight:600}' +
	    '#aiw-embed-msgs{flex:1;overflow:auto;padding:12px;font-size:13px;color:#e8e8e8}' +
	    '#aiw-embed-msgs .u{text-align:left;color:#9cf;margin:8px 0}#aiw-embed-msgs .a{text-align:right;margin:8px 0}' +
	    '#aiw-embed-foot{display:flex;gap:8px;padding:10px;border-top:1px solid #333}#aiw-embed-input{flex:1;border:1px solid #444;background:#111;color:#fff;border-radius:8px;padding:8px 10px}' +
	    '#aiw-embed-send{background:#d4a24a;border:none;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer}';
	  var btn = document.createElement('button');
	  btn.type = 'button'; btn.id = 'aiw-embed-btn';
	  var panel = document.createElement('div'); panel.id = 'aiw-embed-panel';
	  var head = document.createElement('div'); head.id = 'aiw-embed-head';
	  var msgs = document.createElement('div'); msgs.id = 'aiw-embed-msgs';
	  var foot = document.createElement('div'); foot.id = 'aiw-embed-foot';
	  var input = document.createElement('input'); input.id = 'aiw-embed-input'; input.placeholder = 'כתוב הודעה...';
	  var sendBtn = document.createElement('button'); sendBtn.type = 'button'; sendBtn.id = 'aiw-embed-send'; sendBtn.textContent = 'שלח';
	  foot.append(input, sendBtn); panel.append(head, msgs, foot); root.append(style, btn, panel);
	  document.body.appendChild(root);
	  root.setAttribute('data-pos', pos === 'left' ? 'left' : 'right');
	  btn.textContent = label;
	  var sessionToken = '';
	  var sessionPromise = null;
	  var workerName = label;
	  function ensureSession(force) {
	    if (force) { sessionToken = ''; sessionPromise = null; }
	    if (sessionToken) return Promise.resolve(sessionToken);
	    if (sessionPromise) return sessionPromise;
	    sessionPromise = fetch(base + '/api/embed/session', {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ workerId: workerId })
	    }).then(function(r){
	      return r.json().then(function(j){
	        if (!r.ok || !j.sessionToken) throw new Error(j.error || 'session_failed');
	        sessionToken = j.sessionToken;
	        return sessionToken;
	      });
	    }).finally(function(){ sessionPromise = null; });
	    return sessionPromise;
	  }
	  fetch(base + '/api/embed/config?workerId=' + encodeURIComponent(workerId))
	    .then(function(r){ return r.json(); })
	    .then(function(j){
	      if (j.name) { workerName = j.name; head.textContent = j.name; btn.textContent = j.name; }
	      else { head.textContent = label; }
	      return ensureSession(false);
	    })
	    .catch(function(){ head.textContent = label; append('assistant', 'הצ\\'אט אינו זמין כרגע'); });
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
    var requestKey = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
      ? globalThis.crypto.randomUUID()
      : 'embed-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    input.value = '';
    append('user', text);
	    ensureSession(false).then(function(token){
	      return fetch(base + '/api/embed/chat', {
	        method: 'POST',
	        headers: { 'content-type': 'application/json', authorization: 'Embed ' + token, 'x-idempotency-key': requestKey },
	        body: JSON.stringify({ message: text })
	      });
	    }).then(function(r){
	      if (r.status === 401) return ensureSession(true).then(function(token){
	        return fetch(base + '/api/embed/chat', {
	          method: 'POST',
	          headers: { 'content-type': 'application/json', authorization: 'Embed ' + token, 'x-idempotency-key': requestKey },
	          body: JSON.stringify({ message: text })
	        });
	      });
	      return r;
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
