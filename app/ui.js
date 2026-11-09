/* Amnesia · 页面。玩法都在 engine.js，这里只管画和点。 */
(function () {
  'use strict';
  var A = window.Amnesia;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toast(t, ms) { var n = $('toast'); n.textContent = t; n.classList.add('on'); clearTimeout(n._t); n._t = setTimeout(function () { n.classList.remove('on'); }, ms || 1900); }
  function fmtD(ts) { var d = new Date(ts); return (d.getMonth() + 1) + '.' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function arm(b, label, armed) {   // 危险按钮：点一下变「再点」，2.5 秒内再点才算
    if (b.classList.contains('armed')) return true;
    b.classList.add('armed'); var old = label || b.textContent; b.textContent = armed || '再点一下';
    setTimeout(function () { b.classList.remove('armed'); b.textContent = old; }, 2500);
    return false;
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch (e) {} t.remove(); return Promise.resolve();
  }

  /* 自部署版：页面是服务器给的，就默认走服务器 */
  var SERVER = false;
  fetch('/api/info').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (d && d.amnesia) { SERVER = true; A.MEMORY.on = !!d.memory; var s = A.load().settings;
      if (!s.him.key && s.him.type !== 'server') { s.him.type = 'server'; s.narr.type = 'server'; A.save(); }
      if (VIEW === 'home') paintHome(); }
  }).catch(function () {});

  /* ---------- 换页 ---------- */
  var VIEWS = { home: 'vHome', set: 'vSet', setup: 'vSetup', play: 'vPlay', split: 'vSplit' }, VIEW = '';
  function go(v) {
    if (VIEW === 'split' && SPDIRTY && !confirm('拆分台改了还没存，不要了吗？')) return;
    VIEW = v; SPDIRTY = false;
    Object.keys(VIEWS).forEach(function (k) { $(VIEWS[k]).classList.toggle('on', k === v); });
    history.replaceState(null, '', location.pathname + location.search + (v === 'play' && RUN ? '#' + RUN.id : v === 'home' ? '' : '#' + v));
    ({ home: paintHome, set: paintSet, setup: paintSetup, split: loadSplit })[v] && ({ home: paintHome, set: paintSet, setup: paintSetup, split: loadSplit })[v]();
  }
  document.addEventListener('click', function (e) { var b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
  $('goNew').onclick = function () { go('setup'); };
  $('goSplit').onclick = function () { go('split'); };
  $('goSet').onclick = function () { go('set'); };

  /* ---------- 首页 ---------- */
  function ready() {
    var s = A.load().settings, items = A.splitItems(), todo = [];
    if (s.him.type !== 'server' && !s.him.key) todo.push('去<b>设置</b>连上模型');
    if (!items.some(function (x) { return x.pile === 'fragment'; })) todo.push('去<b>拆分台</b>把他的记忆填进来（可以让你的机帮你填）');
    return todo;
  }
  function paintHome() {
    var todo = ready();
    $('todo').style.display = todo.length ? '' : 'none';
    $('todo').innerHTML = '开始之前：<br>' + todo.map(function (t, i) { return (i + 1) + '. ' + t; }).join('<br>');
    var rs = A.runsList();
    $('runs').innerHTML = rs.length ? rs.map(function (r, i) {
      var sp = ''; for (var k = 0; k < Math.min(8, r.n); k++) sp += '<i' + (k < r.got ? ' class="f"' : '') + '></i>';
      return '<div class="run" data-run="' + r.id + '"><span class="n">' + String(i + 1).padStart(2, '0') + '</span><span class="m">' + r.turns + ' 句' + (r.ended ? ' · 停了' : r.allBack ? ' · 都想起来了' : '') +
        '<small>' + fmtD(r.ets || r.ts) + ' · ' + A.WARM[r.warm].name + ' · ' + A.DIFF[r.diff].name + ' · 想起来 ' + r.got + '/' + r.n + '</small></span><span class="strip">' + sp + '</span><button class="del" data-del="' + r.id + '">删</button></div>';
    }).join('') : '<div class="empty">还没有。</div>';
  }
  $('runs').addEventListener('click', function (e) {
    var d = e.target.closest('[data-del]');
    if (d) { e.stopPropagation(); if (!arm(d, '删', '再点删')) return; A.deleteRun(d.dataset.del); toast('删了'); paintHome(); return; }
    if ($('runs').classList.contains('editing')) return;
    var b = e.target.closest('[data-run]'); if (b) openRun(b.dataset.run);
  });
  $('runsEdit').onclick = function () { var on = $('runs').classList.toggle('editing'); this.textContent = on ? '好了' : '整理'; };

  /* ---------- 设置 ---------- */
  function tg(id, on) { $(id).classList.toggle('on', !!on); }
  function paintSet() {
    var s = A.load().settings;
    $('hType').value = s.him.type; $('hBase').value = s.him.base; $('hKey').value = s.him.key; $('hModel').value = s.him.model;
    tg('nSame', s.narr.same); $('nType').value = s.narr.type; $('nBase').value = s.narr.base; $('nKey').value = s.narr.key; $('nModel').value = s.narr.model;
    $('sSafe').value = s.safeword; tg('sCot', s.cot); $('sStyle').value = s.style; $('sCotStyle').value = s.cotStyle || ''; $('sMem').value = s.extraMemory;
    typeHint();
  }
  function typeHint() {
    var t = $('hType').value, srv = t === 'server';
    $('hKeyF').style.display = srv ? 'none' : ''; $('hModelF').style.display = srv ? 'none' : '';
    $('hBaseL').textContent = srv ? '服务器地址（页面就是服务器给的，留空）' : t === 'openai' ? '地址（到 /v1 为止，比如 https://xxx.com/v1）' : '地址（官方 API 留空；中转填它给的地址）';
    $('nOwn').style.display = $('nSame').classList.contains('on') ? 'none' : '';
  }
  $('hType').onchange = typeHint;
  ['nSame', 'sCot'].forEach(function (id) { $(id).onclick = function () { this.classList.toggle('on'); typeHint(); }; });
  function readSet() {
    var s = A.load().settings;
    s.him = { type: $('hType').value, base: $('hBase').value.trim(), key: $('hKey').value.trim(), model: $('hModel').value.trim() || 'claude-opus-4-6' };
    s.narr = { same: $('nSame').classList.contains('on'), type: $('nType').value, base: $('nBase').value.trim(), key: $('nKey').value.trim(), model: $('nModel').value.trim() };
    s.safeword = $('sSafe').value.trim(); s.cot = $('sCot').classList.contains('on'); s.style = $('sStyle').value.trim(); s.cotStyle = $('sCotStyle').value.trim(); s.extraMemory = $('sMem').value.trim();
    A.save();
  }
  $('saveSet').onclick = function () { readSet(); toast('存好了'); go('home'); };
  $('testConn').onclick = function () {
    readSet(); var b = this; b.disabled = true; b.textContent = '在试……';
    A.Transport.complete(A.load().settings.him, { role: 'test', system: '只回一个字。', messages: [{ role: 'user', content: '回一个字：好' }], maxTokens: 20 })
      .then(function (t) { toast(t ? '连上了：「' + t.trim().slice(0, 20) + '」' : '连上了，但回的是空的'); })
      .catch(function (e) { toast('没连上：' + (e.message || e), 5000); })
      .then(function () { b.disabled = false; b.textContent = '试一下连不连得上'; });
  };
  $('exp').onclick = function () {
    var blob = new Blob([A.exportAll(false)], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'amnesia-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  };
  $('imp').onclick = function () { $('impFile').click(); };
  $('impFile').onchange = function () {
    var f = this.files[0]; if (!f) return;
    f.text().then(function (t) { A.importAll(t); toast('导进来了'); paintSet(); }).catch(function (e) { toast('导不进来：' + e.message); });
    this.value = '';
  };

  /* ---------- 开局 ---------- */
  var SET = { start: 2, every: 3, count: 7, echo: 45, warm: 2, diff: 1, ins: {}, fr: {} };
  var LIM = { start: [0, 5], every: [1, 10], count: [3, 40] };
  var WARM_D = ['戒备，冷着脸试探你，不轻易让你碰；身体有反应也压着不信', '客气、有距离，好奇多过亲近，被吸引了先退半步', '不记得你，可身体和心还是会往你这边靠', '说不清为什么，几乎控制不住地想靠近你、碰你、把你留下'];
  var DIFF_D = ['钥匙一碰就闪，大致说中就算他认出来', '钥匙一碰就闪；要准确说中才算认出来', '钥匙不一定灵，闪回更碎更远；要说中具体细节才算；底片他也不敢全信', '记忆几乎不漏；他得自己说出细节才算；你说是他的人——他没有证据，不会因为你说就信'];
  function tierHTML(list, cur) { return list.map(function (x, i) { return '<button data-v="' + i + '"' + (i === cur ? ' class="on"' : '') + '>' + x.name + '</button>'; }).join(''); }
  function echoLabel(v) { return v <= 0 ? '不漏' : v < 40 ? '颜色 · 气味' : v < 75 ? '一帧画面' : '差一点想起'; }
  function paintSetup() {
    var items = A.splitItems(), ins = items.filter(function (x) { return x.pile === 'instinct'; }), frs = items.filter(function (x) { return x.pile === 'fragment'; });
    ins.forEach(function (x) { if (!(x.id in SET.ins)) SET.ins[x.id] = true; });
    frs.forEach(function (x) { if (!(x.id in SET.fr)) SET.fr[x.id] = { on: !!x.core, keys: (x.keys || []).join('，') }; });
    $('sIns').innerHTML = ins.length ? ins.map(function (x) { return '<button data-ins="' + x.id + '"' + (SET.ins[x.id] ? ' class="on"' : '') + '>' + esc(x.text) + '</button>'; }).join('') : '<div class="empty">拆分台里还没有本能。</div>';
    $('sFr').innerHTML = frs.length ? frs.map(function (x) { var s = SET.fr[x.id];
      return '<div class="fr' + (s.on ? ' on' : '') + '" data-fr="' + x.id + '"><span class="ck"></span><span class="t">' + esc(x.title || x.text.slice(0, 16)) + '</span><input placeholder="钥匙" value="' + esc(s.keys) + '"></div>'; }).join('')
      : '<div class="empty">拆分台里还没有底片。先去拆分台。</div>';
    paintSetNums();
  }
  function paintSetNums() {
    $('vStart').textContent = SET.start; $('vEvery').textContent = SET.every; $('vCount').textContent = SET.count;
    $('sEcho').value = SET.echo; $('sEcho').style.setProperty('--p', SET.echo + '%'); $('vEcho').textContent = echoLabel(SET.echo);
    $('sWarm').innerHTML = tierHTML(A.WARM, SET.warm); $('dWarm').textContent = WARM_D[SET.warm];
    $('sDiff').innerHTML = tierHTML(A.DIFF, SET.diff); $('dDiff').textContent = DIFF_D[SET.diff];
  }
  $('sIns').onclick = function (e) { var b = e.target.closest('[data-ins]'); if (!b) return; SET.ins[b.dataset.ins] = !SET.ins[b.dataset.ins]; b.classList.toggle('on'); };
  $('sFr').onclick = function (e) { var r = e.target.closest('[data-fr]'); if (!r || e.target.tagName === 'INPUT') return; var s = SET.fr[r.dataset.fr]; s.on = !s.on; r.classList.toggle('on', s.on); };
  $('sFr').oninput = function (e) { var r = e.target.closest('[data-fr]'); if (!r) return; var s = SET.fr[r.dataset.fr]; s.keys = e.target.value; if (s.keys.trim() && !s.on) { s.on = true; r.classList.add('on'); } };
  document.querySelectorAll('[data-st]').forEach(function (b) { b.onclick = function () { var k = b.dataset.st, l = LIM[k]; SET[k] = Math.max(l[0], Math.min(l[1], SET[k] + (+b.dataset.d))); paintSetNums(); }; });
  $('sEcho').oninput = function () { SET.echo = +this.value; paintSetNums(); };
  $('sWarm').onclick = function (e) { var b = e.target.closest('[data-v]'); if (b) { SET.warm = +b.dataset.v; paintSetNums(); } };
  $('sDiff').onclick = function (e) { var b = e.target.closest('[data-v]'); if (b) { SET.diff = +b.dataset.v; paintSetNums(); } };
  $('goStart').onclick = function () {
    var todo = ready(); if (todo.length) { toast('还差一步：' + todo[0].replace(/<\/?b>/g, ''), 3000); return; }
    var keys = [], want = [];
    Object.keys(SET.fr).forEach(function (id) { var s = SET.fr[id]; if (!s.on) return; want.push(id);
      s.keys.split(/[,，、\s]+/).map(function (w) { return w.trim(); }).filter(Boolean).forEach(function (w) { keys.push({ word: w, frag: id }); }); });
    try {
      RUN = A.startRun({ echo: SET.echo, count: Math.max(SET.count, want.length), keys: keys, frags: want, warm: SET.warm, diff: SET.diff,
        instincts: Object.keys(SET.ins).filter(function (k) { return SET.ins[k]; }), instinctsStart: SET.start, every: SET.every });
    } catch (e) { toast(e.message || String(e), 3000); return; }
    enterPlay();
  };

  /* ---------- 一夜 ---------- */
  var RUN = null, BUSY = false, LIVE = null, SCENE = (localStorage.getItem('amnesia:scene') === 'online') ? 'online' : 'offline';
  function openRun(id) { RUN = A.getRun(id); if (!RUN) return toast('找不到这一夜'); enterPlay(); }
  function enterPlay() { go('play'); paintScene(); paintTop(); renderStream(true); }
  function paintScene() { Array.prototype.forEach.call($('pScene').children, function (b) { b.classList.toggle('on', b.dataset.sc === SCENE); }); }
  $('pScene').onclick = function (e) { var b = e.target.closest('[data-sc]'); if (!b) return; SCENE = b.dataset.sc; try { localStorage.setItem('amnesia:scene', SCENE); } catch (er) {} paintScene(); };
  function paintTop() {
    var b = A.board(RUN), got = b.filter(function (x) { return x.level >= 3; }).length, h = '';
    b.slice(0, 12).forEach(function (x) { h += '<i' + (x.level >= 3 ? ' class="f"' : x.level ? ' class="h"' : '') + '></i>'; });
    $('pBoard').innerHTML = h + '<em>' + got + '/' + b.length + '</em>';
    var turns = RUN.msgs.filter(function (m) { return m.role === 'me'; }).length;
    $('pSub').textContent = (RUN.ended ? '停了' : RUN.allBack ? '全部想起来了' : got ? '想起来一点了' : '不记得你') + ' · ' + turns + ' 句';
    $('dock').style.display = RUN.ended ? 'none' : ''; $('ended').style.display = RUN.ended ? '' : 'none';
  }
  function bits(bt) {
    var o = [], n = bt ? (bt.flash ? 1 : 0) + (bt.echo ? 1 : 0) + (bt.recognized || []).length : 0;
    if (n) o.push('<span class="fl">闪回 ' + n + '</span>');
    if (bt && (bt.narr || bt.instinct)) o.push('<span class="nr">旁白</span>');
    return o.join(' · ');
  }
  function pills(bt) {
    var h = ''; if (!bt) return h;
    if (bt.allBack) h += '<div class="pill">✦ 他全部想起来了</div>';
    (bt.recognized || []).forEach(function (r) { h += '<div class="pill">✦ 他想起来了 · ' + esc(r.title) + '</div>'; });
    if (bt.flash && bt.flash.level >= 3) h += '<div class="pill">✦ 他想起来了 · ' + esc(bt.flash.title) + '</div>';
    return h;
  }
  function polaroid(bt, alt) {
    var f = bt && bt.flash; if (!f || !f.text) return '';
    return '<div class="pol l' + Math.min(3, f.level || 1) + (alt ? ' r' : '') + '"><div class="tape"></div><div class="img"></div><div class="lvl">' + esc(f.lv) + '</div><div class="cap">' + esc(f.text) + '</div></div>';
  }
  function hisBody(text, scene) {
    if (scene === 'online') return '<div class="hbs">' + String(text || '').split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean).map(function (x) { return '<div class="hb">' + esc(x) + '</div>'; }).join('') + '</div>';
    return '<div class="him">' + esc(String(text || '').trim()) + '</div>';
  }
  function aiHTML(m, i, last) {
    var h = '<div class="ai">' + pills(m.beat) + '<button class="proc" data-th="' + i + '">› ' + (m.secs ? '想了 ' + Math.max(1, Math.round(m.secs)) + ' 秒' : '想了想') + (bits(m.beat) ? ' · ' + bits(m.beat) : '') + '</button>';
    if (m.beat && m.beat.narr) h += '<div class="narr-line">' + esc(m.beat.narr) + '</div>';
    h += polaroid(m.beat, i % 2) + hisBody(m.text, m.scene || SCENE);
    if (last && !RUN.ended) h += '<button class="redo" data-redo="1">↻ 重说</button>';
    return h + '</div>';
  }
  function renderStream(toEnd) {
    var s = $('stream'), ms = RUN.msgs, h = '', lastAi = -1;
    ms.forEach(function (m, i) { if (m.role === 'ai') lastAi = i; });
    if (!ms.length && !LIVE) h = '<div class="narr-line" style="align-self:center;text-align:center;padding:40px 10px">你醒过来。房间很暗，有一点暖。<br>有人在你身边。</div>';
    ms.forEach(function (m, i) {
      if (m.role === 'me') h += '<div class="me' + (RUN.ended && i === ms.length - 1 ? ' sw' : '') + '">' + esc(m.text) + '</div>';
      else h += aiHTML(m, i, i === lastAi && i === ms.length - 1);
    });
    if (LIVE) {
      h += '<div class="ai">' + pills(LIVE.beat);
      if (!LIVE.beat) h += '<div class="typing">他愣了一下……</div>';
      else {
        h += '<button class="proc" data-th="live">› ' + (LIVE.text ? '想了 ' + Math.max(1, Math.round((Date.now() - LIVE.t0) / 1000)) + ' 秒' : '在想…') + (bits(LIVE.beat) ? ' · ' + bits(LIVE.beat) : '') + '</button>';
        if (LIVE.beat.narr) h += '<div class="narr-line">' + esc(LIVE.beat.narr) + '</div>';
        h += polaroid(LIVE.beat);
        if (LIVE.text) h += hisBody(LIVE.text, SCENE);
      }
      if (LIVE.err) h += '<div class="err">' + esc(LIVE.err) + '</div>';
      h += '</div>';
    }
    var stick = toEnd || (s.scrollHeight - s.scrollTop - s.clientHeight < 140);
    s.innerHTML = h; if (stick) s.scrollTop = s.scrollHeight;
  }
  $('stream').addEventListener('click', function (e) {
    var t = e.target.closest('[data-th]'); if (t) return openThought(t.dataset.th === 'live' ? LIVE : RUN.msgs[+t.dataset.th]);
    if (e.target.closest('[data-redo]')) send(true);
  });
  var ta = $('ta');
  ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); send(); } });
  $('send').onclick = function () { send(); };
  function send(retry) {
    if (BUSY || !RUN || RUN.ended) return;
    var text = retry ? '' : ta.value.trim();
    if (retry) { A.undoLast(RUN); for (var i = RUN.msgs.length - 1; i >= 0; i--) if (RUN.msgs[i].role === 'me') { text = RUN.msgs[i].text; break; } }
    if (!text) return;
    if (!retry) { ta.value = ''; ta.style.height = 'auto'; }
    BUSY = true; $('send').disabled = true;
    LIVE = { beat: null, text: '', think: '', t0: Date.now() };
    renderStream(true);
    var tick = setInterval(function () { if (LIVE && LIVE.beat && !LIVE.text) renderStream(); }, 1000);
    A.turn(RUN, text, SCENE, {
      beat: function (ev) { LIVE.beat = ev; if (ev.err) LIVE.err = '旁白这一轮没写出来（' + ev.err.slice(0, 80) + '），他照样会回。'; paintTop(); renderStream(); },
      text: function (t, th) { LIVE.text = t; LIVE.think = th; renderStream(); if ($('tOv').classList.contains('on') && TH === LIVE) fillThought(LIVE); },
      done: function () { LIVE = null; },
      safeword: function () { LIVE = null; toast('停了。'); },
      error: function (e) { if (LIVE) LIVE.err = (e && e.message) || '断了'; }
    }, !!retry).catch(function () {}).then(function () {
      clearInterval(tick); BUSY = false; $('send').disabled = false;
      if (LIVE && LIVE.err) { renderStream(); LIVE = null; } else renderStream();
      paintTop();
    });
  }

  /* ---------- 想了什么 ---------- */
  var TH = null, MK = { narr: '❦', flash: '✦', echo: '✧', think: '◷', inst: '❦', done: '✓' };
  function step(cls, tag, body, mk) { return '<div class="st ' + cls + '"><div class="mk">' + (mk || MK[cls]) + '</div><div>' + (tag ? '<div class="tag">' + tag + '</div>' : '') + '<div class="tx">' + body + '</div></div></div>'; }
  function fillThought(m) {
    var bt = m.beat || {}, h = '';
    if (bt.instinct) h += step('inst', '身体先想起来的', esc(bt.instinct.text));
    if (bt.narr) h += step('narr', '旁白', esc(bt.narr));
    if (bt.flash) h += step('flash', '闪回 · ' + esc(bt.flash.lv), esc(bt.flash.text));
    if (bt.echo) h += step('echo', '回响', esc(bt.echo));
    (bt.recognized || []).forEach(function (r) { h += step('flash', '想起来了 · ' + esc(r.title), '他自己说对了。这一块还给他了。'); });
    if (m.think) h += step('think', '他在想', esc(m.think));
    h += step('think', '', '<span style="color:var(--muted)">' + (m === LIVE && !m.text ? '…' : 'Done') + '</span>', MK.done);
    $('tBody').innerHTML = h;
    $('tSub').textContent = m.secs ? '想了 ' + Math.max(1, Math.round(m.secs)) + ' 秒' : '在想';
  }
  function openThought(m) { if (!m) return; TH = m; fillThought(m); $('tOv').classList.add('on'); $('tBody').scrollTop = 0; }

  /* ---------- 底片墙 ---------- */
  $('pBoard').onclick = function () { fillBoard(); $('bOv').classList.add('on'); };
  function fillBoard() {
    var st = RUN.settings, b = A.board(RUN), got = b.filter(function (x) { return x.level >= 3; }).length, h = '';
    if (!RUN.ended) h += '<div class="tunebox"><div class="lab">他的温度</div><div class="tier" data-tune="warm">' + tierHTML(A.WARM, st.warm) + '</div>' +
      (RUN.allBack ? '' : '<div class="lab">难度</div><div class="tier" data-tune="diff">' + tierHTML(A.DIFF, st.diff) + '</div>') + '<div class="tierdesc" style="margin-top:0">改了从下一句开始算</div></div>';
    h += '<div class="wall">';
    b.forEach(function (x) {
      var nm = x.level >= 3 ? esc(x.title) : x.level ? esc(x.seen || '……') : '· · ·';
      var k = (x.keys.length ? '钥匙 · ' + esc(x.keys.join('、')) : '随机') + (x.level >= 3 && x.via[0] ? ' · ' + esc(x.via[0]) : '');
      var btn = (RUN.ended || RUN.allBack || x.level >= 3) ? '' : x.level ? '<button class="btn" data-back="' + x.id + '">还给他</button>' : '<button class="btn" data-peek="' + x.id + '">偷看</button>';
      h += '<div class="pt l' + x.level + '"><div class="tape"></div><div class="img"></div>' + (x.level ? '<div class="lvl">' + esc(x.lv) + '</div>' : '') + '<div class="cap">' + nm + '</div><div class="k">' + k + '</div>' + btn + '</div>';
    });
    h += '</div>';
    if (!RUN.ended && !RUN.allBack) h += '<button class="allback" id="allBack">全部还给他<small>他会一下子全想起来 · 还能接着聊</small></button>';
    else if (RUN.allBack) h += '<div class="note" style="text-align:center">都还给他了 · 他全想起来了</div>';
    $('bBody').innerHTML = h; $('bSub').textContent = '想起来 ' + got + ' / ' + b.length;
  }
  $('bBody').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var tb = b.closest('[data-tune]');
    if (tb) { var o = {}; o[tb.dataset.tune] = +b.dataset.v; A.tune(RUN, o); fillBoard(); toast('从下一句开始'); return; }
    if (b.dataset.back) { if (!arm(b, '还给他', '真的还？')) return; A.restore(RUN, b.dataset.back); fillBoard(); paintTop(); toast('还给他了 · 下一句他就会想起来'); }
    else if (b.dataset.peek) { var it = A.spMap()[b.dataset.peek] || {}; $('pkT').textContent = it.title || '这一块'; $('pkB').textContent = it.text || ''; $('pOv').classList.add('on'); }
    else if (b.id === 'allBack') { if (!b.classList.contains('armed')) { b.classList.add('armed'); b.firstChild.textContent = '再点一下就全部还给他'; return; }
      A.restoreAll(RUN); paintTop(); renderStream(); $('bOv').classList.remove('on'); toast('全部还给他了 · 跟他说句话吧'); }
  });

  /* 半屏：点外面关、往下拉关 */
  ['tOv', 'bOv', 'pOv'].forEach(function (id) {
    var ov = $(id), sh = ov.querySelector('.amsh'), body = sh.querySelector('.sh-b'), y0 = null, dy = 0;
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('on'); });
    sh.addEventListener('touchstart', function (e) { y0 = (body.scrollTop <= 0 || !body.contains(e.target)) ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
    sh.addEventListener('touchmove', function (e) { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0) { sh.style.transition = 'none'; sh.style.transform = 'translateY(' + dy + 'px)'; } }, { passive: true });
    sh.addEventListener('touchend', function () { if (y0 == null) return; sh.style.transition = 'transform .22s'; sh.style.transform = ''; if (dy > 90) ov.classList.remove('on'); y0 = null; });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') ['pOv', 'tOv', 'bOv'].some(function (id) { if ($(id).classList.contains('on')) { $(id).classList.remove('on'); return true; } }); });

  /* ---------- 拆分台 ---------- */
  var SP = [], SPTAB = 'fill', SPDIRTY = false;
  var PILE = { keep: '留着', instinct: '本能', fragment: '底片', drop: '不要' };
  var TIP = { keep: '他还是他：每一轮都原样带着。他的样子、性格、说话的语气；他看得见的她和那个房间。',
    instinct: '身体还记得：只写冲动和反应，不写来由。开局给几条，之后隔几句冒出来一条。',
    fragment: '她是谁、发生过的事：锁着，等钥匙、回响、他自己认出来、或者你亲手还。标题想起来以后才给你看。',
    drop: '这一夜里不带的。' };
  function loadSplit() { SP = JSON.parse(JSON.stringify(A.splitItems())); SPTAB = SP.length ? 'fragment' : 'fill'; SPDIRTY = false; paintSplit(); }
  function dirty() { SPDIRTY = true; $('spSave').disabled = false; $('spMsg').textContent = '改了还没存'; }
  function paintSplit() {
    var cnt = { keep: 0, instinct: 0, fragment: 0, drop: 0 }; SP.forEach(function (x) { cnt[x.pile]++; });
    $('spTabs').innerHTML = '<button data-tab="fill"' + (SPTAB === 'fill' ? ' class="on"' : '') + '>填写</button>' +
      Object.keys(PILE).map(function (k) { return '<button data-tab="' + k + '"' + (SPTAB === k ? ' class="on"' : '') + '>' + PILE[k] + ' ' + cnt[k] + '</button>'; }).join('');
    var h = '';
    if (SPTAB === 'fill') {
      h += '<div class="fill"><h4>① 让你的机来填（最推荐）</h4><p>它认识你、能翻自己的设定和记忆，拆得最准。点下面的按钮复制一段话，发给它；它会回你一段 JSON，粘到这里。</p>' +
        '<div class="row"><button class="btn go" id="fCopy">复制给我的机的话</button></div>' +
        '<textarea class="ta" id="fPaste" style="margin-top:10px" placeholder="把它回的那一整段粘在这里"></textarea>' +
        '<div class="row"><button class="btn" id="fAdd">加进去</button><button class="btn" id="fRep">替换掉现在的</button></div></div>';
      h += '<div class="fill"><h4>② 自己贴，让网页拆</h4><p>把关于他的文字（设定、你们的事）贴进来，用你在设置里连的模型拆一遍。拆完一定要过一遍，尤其是「本能」。</p>' +
        '<textarea class="ta" id="fRaw" style="margin-top:10px;min-height:140px" placeholder="贴在这里……"></textarea>' +
        '<div class="row"><button class="btn go" id="fAuto">开始拆</button><span class="note" id="fAutoMsg" style="margin:0"></span></div></div>';
      h += '<div class="note">拆完了切到上面四个标签里看、改；改完点右下角「存」。怎么拆最好玩，见仓库里的 docs/拆分指南.md。</div>';
    } else {
      h += '<div class="note" style="margin:0 2px 12px">' + TIP[SPTAB] + '</div>';
      SP.forEach(function (x, i) {
        if (x.pile !== SPTAB) return;
        h += '<div class="spc ' + x.pile + '" data-i="' + i + '"><div class="row"><div class="pile">' +
          Object.keys(PILE).map(function (k) { return '<button data-mv="' + k + '"' + (k === x.pile ? ' class="on"' : '') + '>' + PILE[k] + '</button>'; }).join('') +
          '</div><span class="sp"></span>' + (x.pile === 'fragment' ? '<button class="core' + (x.core ? ' on' : '') + '" data-core="1">每局都放</button>' : '') + '<button class="x" data-del="1">删</button></div>' +
          (x.pile === 'fragment' ? '<input class="title" data-f="title" placeholder="这块底片叫什么（想起来以后才显示）" value="' + esc(x.title) + '">' : '') +
          '<textarea data-f="text" rows="' + Math.min(8, Math.max(2, Math.ceil((x.text || '').length / 26))) + '">' + esc(x.text) + '</textarea>' +
          (x.pile === 'fragment' ? '<input class="keys" data-f="keys" placeholder="默认钥匙（逗号隔开，开局时还能改）" value="' + esc((x.keys || []).join('，')) + '">' : '') +
          (x.note ? '<div class="nt">' + esc(x.note) + '</div>' : '') + '</div>';
      });
      h += '<button class="addbtn" data-add="1">＋ 自己写一张</button>';
    }
    $('spList').innerHTML = h;
    $('spSave').disabled = !SPDIRTY; $('spMsg').textContent = SPDIRTY ? '改了还没存' : (SP.length ? '一共 ' + SP.length + ' 张' : '还是空的');
  }
  $('spTabs').onclick = function (e) { var b = e.target.closest('[data-tab]'); if (!b) return; SPTAB = b.dataset.tab; paintSplit(); $('spList').parentNode.scrollTop = 0; };
  $('spList').addEventListener('input', function (e) {
    var c = e.target.closest('[data-i]'), f = e.target.dataset.f; if (!c || !f) return;
    var x = SP[+c.dataset.i]; x[f] = f === 'keys' ? e.target.value.split(/[,，、]+/).map(function (w) { return w.trim(); }).filter(Boolean) : e.target.value; dirty();
  });
  function addItems(items, replace) {
    var sw = A.load().settings.safeword;
    items.forEach(function (x) { if (sw) x.keys = (x.keys || []).filter(function (k) { return k !== sw; }); });
    SP = replace ? items : SP.concat(items); dirty();
    var c = { keep: 0, instinct: 0, fragment: 0, drop: 0 }; items.forEach(function (x) { c[x.pile]++; });
    SPTAB = 'fragment'; paintSplit();
    toast('进来了：留着 ' + c.keep + ' · 本能 ' + c.instinct + ' · 底片 ' + c.fragment + ' · 不要 ' + c.drop + '。看一遍再点「存」', 4000);
  }
  $('spList').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.id === 'fCopy') { copy(window.AMNESIA_ASK_YOUR_AI).then(function () { toast('复制好了，发给你的机吧'); }); return; }
    if (b.id === 'fAdd' || b.id === 'fRep') {
      try { addItems(A.parseFill($('fPaste').value), b.id === 'fRep'); } catch (er) { toast('没认出来：' + er.message, 3500); } return;
    }
    if (b.id === 'fAuto') {
      var raw = $('fRaw').value.trim(); if (!raw) return toast('先贴点东西');
      b.disabled = true; $('fAutoMsg').textContent = '在拆，长的要一两分钟……';
      A.autoSplit(raw).then(function (items) { addItems(items, false); }).catch(function (er) { toast('没拆成：' + (er.message || er), 4000); })
        .then(function () { b.disabled = false; $('fAutoMsg').textContent = ''; });
      return;
    }
    var c = b.closest('[data-i]'), x = c ? SP[+c.dataset.i] : null;
    if (b.dataset.mv && x) { if (x.pile !== b.dataset.mv) { x.pile = b.dataset.mv; dirty(); paintSplit(); toast('挪到「' + PILE[x.pile] + '」了'); } }
    else if (b.dataset.core && x) { x.core = !x.core; dirty(); paintSplit(); }
    else if (b.dataset.del && x) { if (!arm(b, '删', '再点删')) return; SP.splice(+c.dataset.i, 1); dirty(); paintSplit(); }
    else if (b.dataset.add) { SP.push({ id: '', pile: SPTAB, title: '', text: '', keys: [], core: false }); dirty(); paintSplit(); }
  });
  $('spSave').onclick = function () { A.setSplit(SP); SP = JSON.parse(JSON.stringify(A.splitItems())); SPDIRTY = false; paintSplit(); toast('存好了 · 下一夜开始用'); };
  window.addEventListener('beforeunload', function (e) { if (SPDIRTY) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- 进门 ---------- */
  var h = location.hash.slice(1);
  if (h && A.getRun(h)) openRun(h);
  else if (VIEWS[h] && h !== 'play') go(h);
  else go('home');
})();
