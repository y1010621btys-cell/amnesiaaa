/* Amnesia · 引擎（玩法逻辑 + 存档 + 连模型）。不碰页面，ui.js 调它。
 *
 * 一局的流程（每一句她说的话）：
 *   1. planTurn  决定这一轮动哪些：钥匙碰到的底片升一级、回响掷骰、冒一条本能、她亲手还的、全部还给他
 *   2. narrate   旁白模型写：旁白（第二人称「你」）、闪回（按层级）、回响，并判断他上一轮有没有认出来
 *   3. buildForHim 拼他这一轮看到的东西：留着的那些 + 开场框架 + 后台块（本能 / 想起来的 / 旁白 / 闪回）+ 历史
 *   4. 他回话（流式）
 *
 * 层级：0 锁着 · 1 感官 · 2 画面 · 3 想起来了。钥匙 / 回响自动最多到 2（难 / 很难只到 1）；
 * 到 3 只有两条路：他自己说对了（旁白判 recognized），或者她点「还给他」。
 */
(function (global) {
  'use strict';

  var LV = ['锁着', '感官', '画面', '想起来了'];
  var PILES = ['keep', 'instinct', 'fragment', 'drop'];

  var DIFF = [
    { name: '轻', keyP: 1, echoK: .7, cap: 2, judge: '大致说中那件事就算认出来。', doubt: '' },
    { name: '默认', keyP: 1, echoK: .5, cap: 0, judge: '准确说中了那件事才算（不是瞎猜、不是泛泛而谈）。', doubt: '' },
    { name: '难', keyP: .7, echoK: .3, cap: 1, judge: '要说中具体的细节（地点、物件、动作里至少一样）才算；只说出大概、或顺着她的话接，都不算。',
      doubt: '那些底片你拿不准是不是真的——可能是梦，可能是你自己拼出来的。想起来一点，也不敢全信。' },
    { name: '很难', keyP: .45, echoK: .15, cap: 1, judge: '要他自己主动说出具体细节（不是她先提到的）才算；顺着她的话猜、只说出大概，都不算。宁可不放。',
      doubt: '那些底片你拿不准是不是真的，更不敢拿它们当证据。她说你们认识、说你是她的——你没有证据。在你自己真的想起来之前，你不确定她是不是你的人；你可以被她吸引，但不会因为她这么说就信。' }
  ];
  var WARM = [
    { name: '冷', line: '你对她是戒备的：一个陌生人，知道你的事，靠你这么近。你冷着脸观察她、试探她，不轻易让她碰你。身体偶尔会有反应——你压着，不信它。', narr: '他对她很戒备：旁白里的身体反应要很淡、一闪就被他压下去。' },
    { name: '疏离', line: '你对她客气、有距离，好奇多过亲近。被她吸引的时候你会先退半步，弄清楚这是什么。', narr: '他对她有距离：身体反应写得克制，他会注意到、但先退半步。' },
    { name: '默认', line: '', narr: '' },
    { name: '烫', line: '你说不清为什么，但你几乎控制不住地想靠近她、碰她、把她留在身边。', narr: '他控制不住地被她吸引：身体反应可以写得强烈。' }
  ];

  /* ======================= 存档 ======================= */
  var KEY = 'amnesia:v1';
  var DEFAULT_STATE = {
    settings: {
      him: { type: 'anthropic', base: '', key: '', model: 'claude-opus-4-6' },
      narr: { same: true, type: 'anthropic', base: '', key: '', model: 'claude-sonnet-4-6' },
      safeword: '', style: '', cot: true, cotStyle: '', maxTokens: 3000, extraMemory: ''
    },
    split: { items: [] },
    runs: {}
  };
  var mem = null;
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function load() {
    if (mem) return mem;
    try { mem = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { mem = null; }
    if (!mem) mem = clone(DEFAULT_STATE);
    mem.settings = Object.assign(clone(DEFAULT_STATE.settings), mem.settings || {});
    mem.settings.him = Object.assign(clone(DEFAULT_STATE.settings.him), mem.settings.him || {});
    mem.settings.narr = Object.assign(clone(DEFAULT_STATE.settings.narr), mem.settings.narr || {});
    mem.split = mem.split || { items: [] };
    mem.runs = mem.runs || {};
    return mem;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(mem)); return true; }
    catch (e) { console.warn('save failed', e); return false; }
  }
  function exportAll(withKeys) {
    var d = clone(load());
    if (!withKeys) { d.settings.him.key = ''; d.settings.narr.key = ''; }
    return JSON.stringify(d, null, 1);
  }
  function importAll(text) {
    var d = JSON.parse(text);
    if (!d || typeof d !== 'object') throw new Error('不是存档');
    var cur = load();
    if (d.settings) { var hk = cur.settings.him.key, nk = cur.settings.narr.key; cur.settings = Object.assign(cur.settings, d.settings);
      if (!cur.settings.him.key) cur.settings.him.key = hk; if (!cur.settings.narr.key) cur.settings.narr.key = nk; }
    if (d.split && d.split.items) cur.split = d.split;
    if (d.runs) Object.keys(d.runs).forEach(function (k) { cur.runs[k] = d.runs[k]; });
    save();
  }
  function rid(p) { return (p || 'r') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function clean(s, n) { return String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, n || 4000); }

  /* ======================= 拆分台 ======================= */
  function splitItems() { return load().split.items; }
  function spMap() { var m = {}; splitItems().forEach(function (x) { m[x.id] = x; }); return m; }
  function normItem(x) {
    var pile = PILES.indexOf(x.pile) >= 0 ? x.pile : 'fragment';
    return { id: clean(x.id, 40) || rid('s'), pile: pile, title: clean(x.title, 40), text: clean(x.text, 4000),
      keys: (Array.isArray(x.keys) ? x.keys : String(x.keys || '').split(/[,，、]/)).map(function (k) { return clean(k, 20); }).filter(Boolean).slice(0, 8),
      core: !!x.core, note: clean(x.note, 200) };
  }
  function setSplit(items) {
    var seen = {};
    load().split.items = (items || []).map(normItem).map(function (x) { if (seen[x.id]) x.id = rid('s'); seen[x.id] = 1; return x; });
    save();
  }
  /* 她的机吐回来的东西：认 JSON（{items:[...]} 或数组），也认四个分堆的对象 {keep:[...],instinct:[...],fragment:[...],drop:[...]} */
  function parseFill(text) {
    var t = String(text || '');
    var m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) t = m[1];
    var s = t.indexOf('{'), a = t.indexOf('[');
    var start = s < 0 ? a : a < 0 ? s : Math.min(s, a);
    if (start < 0) throw new Error('里面没找到 JSON');
    var d = JSON.parse(t.slice(start, Math.max(t.lastIndexOf('}'), t.lastIndexOf(']')) + 1));
    var items = [];
    if (Array.isArray(d)) items = d;
    else if (Array.isArray(d.items)) items = d.items;
    else PILES.forEach(function (p) {
      (d[p] || []).forEach(function (x) { items.push(typeof x === 'string' ? { pile: p, text: x } : Object.assign({ pile: p }, x)); });
    });
    if (!items.length) throw new Error('JSON 里没有条目');
    return items.map(normItem);
  }

  /* ======================= 一局 ======================= */
  function runsList() {
    var rs = load().runs;
    return Object.keys(rs).map(function (k) { return rs[k]; }).sort(function (a, b) { return (b.ets || b.ts) - (a.ets || a.ts); }).map(function (r) {
      var fr = Object.keys(r.frags).map(function (k) { return r.frags[k]; });
      return { id: r.id, ts: r.ts, ets: r.ets, ended: !!r.ended, allBack: !!r.allBack, turns: r.msgs.filter(function (m) { return m.role === 'me'; }).length,
        got: fr.filter(function (f) { return f.level >= 3; }).length, n: fr.length, warm: r.settings.warm, diff: r.settings.diff };
    });
  }
  function getRun(id) { return load().runs[id] || null; }
  function saveRun(r) { r.ets = Date.now(); load().runs[r.id] = r; save(); }
  function deleteRun(id) { delete load().runs[id]; save(); }

  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  function startRun(st) {
    st = st || {};
    var items = splitItems();
    var frs = items.filter(function (x) { return x.pile === 'fragment'; });
    var ins = items.filter(function (x) { return x.pile === 'instinct'; }).map(function (x) { return x.id; });
    if (!frs.length) throw new Error('拆分台里还没有底片');
    var sw = load().settings.safeword;
    var keymap = {};
    (st.keys || []).forEach(function (k) {
      var w = clean(k.word, 20), f = clean(k.frag, 40);
      if (!w) return;
      if (sw && w === sw) throw new Error('「' + sw + '」是安全词，不能当钥匙');
      if (frs.some(function (x) { return x.id === f; })) (keymap[f] = keymap[f] || []).push(w);
    });
    var want = st.frags || [];
    var pick = frs.filter(function (x) { return keymap[x.id] || want.indexOf(x.id) >= 0 || x.core; }).map(function (x) { return x.id; });
    var rest = shuffle(frs.filter(function (x) { return pick.indexOf(x.id) < 0; }).map(function (x) { return x.id; }));
    var n = Math.max(3, Math.min(frs.length, +st.count || 7));
    pick = pick.concat(rest).slice(0, Math.max(n, pick.length));
    var keepIns = shuffle((st.instincts || ins).filter(function (i) { return ins.indexOf(i) >= 0; }));
    var first = Math.max(0, Math.min(keepIns.length, st.instinctsStart == null ? 2 : +st.instinctsStart));
    var frags = {};
    pick.forEach(function (id) { frags[id] = { level: 0, seen: '', via: [] }; });
    var r = { id: rid('r'), ts: Date.now(), ended: false, allBack: false,
      settings: { echo: Math.max(0, Math.min(100, st.echo == null ? 45 : +st.echo)), every: Math.max(1, Math.min(10, +st.every || 3)),
        keys: keymap, warm: st.warm == null ? 2 : +st.warm, diff: st.diff == null ? 1 : +st.diff },
      instincts: { pool: keepIns.slice(first), shown: keepIns.slice(0, first) }, frags: frags, msgs: [] };
    saveRun(r);
    return r;
  }
  function tune(r, o) {
    if ('warm' in o) r.settings.warm = Math.max(0, Math.min(3, +o.warm));
    if ('diff' in o) r.settings.diff = Math.max(0, Math.min(3, +o.diff));
    saveRun(r);
  }
  function restore(r, fid) {
    var f = r.frags[fid]; if (!f) return;
    f.level = 3; f.via.push('她还的');
    (r.pending = r.pending || []).push(fid);
    saveRun(r);
  }
  function restoreAll(r) {
    Object.keys(r.frags).forEach(function (k) { var f = r.frags[k]; if (f.level < 3) { f.level = 3; f.via.push('她全部还给他'); } });
    r.instincts.shown = r.instincts.shown.concat(r.instincts.pool); r.instincts.pool = [];
    r.allBack = true; r.pendingAll = true;
    saveRun(r);
  }
  function board(r) {
    var sp = spMap(), keys = r.settings.keys;
    return Object.keys(r.frags).map(function (id) {
      var f = r.frags[id], it = sp[id] || {};
      return { id: id, level: f.level, lv: LV[f.level], title: f.level >= 3 ? it.title || '' : '', seen: f.level >= 1 && f.level < 3 ? f.seen : '',
        keys: keys[id] || [], via: f.via.slice(-1) };
    }).sort(function (a, b) { return b.level - a.level; });
  }

  /* ======================= 每一轮 ======================= */
  function tuneOf(r) { return { d: DIFF[r.settings.diff] || DIFF[1], w: WARM[r.settings.warm] || WARM[2] }; }
  function lc(s) { return String(s || '').toLowerCase(); }
  function bigrams(s) { var out = {}; (String(s).match(/[一-鿿]{2}/g) || []).forEach(function (b) { out[b] = 1; }); return Object.keys(out); }
  function overlap(a, b) { var n = 0; bigrams(a).forEach(function (x) { if (b.indexOf(x) >= 0) n++; }); return n; }

  function planTurn(r, her, sp) {
    var st = r.settings, t = tuneOf(r);
    if (r.pendingAll) { delete r.pendingAll; delete r.pending; return { up: [], ins: null, flood: true }; }
    var cap = t.d.cap || (st.echo < 40 ? 1 : 2), kcap = t.d.cap || 2, up = [], low = lc(her);
    Object.keys(st.keys).forEach(function (fid) {
      var f = r.frags[fid]; if (!f || f.level >= kcap) return;
      var hit = st.keys[fid].filter(function (w) { return low.indexOf(lc(w)) >= 0; })[0];
      if (hit && Math.random() < t.d.keyP) up.push([fid, f.level + 1, '钥匙 · ' + hit]);
    });
    (r.pending || []).forEach(function (fid) { if (r.frags[fid]) up.push([fid, 3, '她还的']); });
    delete r.pending;
    if (!up.length && Math.random() < st.echo / 100 * t.d.echoK) {
      var locked = Object.keys(r.frags).filter(function (k) { return r.frags[k].level < cap; });
      if (locked.length) {
        locked.sort(function (a, b) { return overlap(her, (sp[b] || {}).text || '') - overlap(her, (sp[a] || {}).text || ''); });
        var fid = overlap(her, (sp[locked[0]] || {}).text || '') ? locked[0] : locked[Math.floor(Math.random() * locked.length)];
        up.push([fid, Math.min(cap, r.frags[fid].level + 1), '回响']);
      }
    }
    var ins = null, turns = r.msgs.filter(function (m) { return m.role === 'me'; }).length;
    if (r.instincts.pool.length && turns && turns % st.every === 0) { ins = r.instincts.pool.shift(); r.instincts.shown.push(ins); }
    return { up: up.slice(0, 2), ins: ins, flood: false };
  }

  /* 回响素材：自部署版接了记忆库就先去库里捞；再加上这一局没放进来的底片 + 设置里的「更多记忆」里跟她这句话沾边的 */
  var MEMORY = { on: false };
  function echoMaterial(r, her, sp) {
    var local = echoLocal(r, her, sp);
    if (!MEMORY.on || !r.settings.echo || String(her).trim().length < 4) return Promise.resolve(local);
    var base = (load().settings.him.base || '').replace(/\/+$/, '');
    return fetch(base + '/api/memory?q=' + encodeURIComponent(String(her).slice(0, 300))).then(function (x) { return x.json(); })
      .then(function (d) { return [d && d.text, local].filter(Boolean).join('\n---\n').slice(0, 1800); })
      .catch(function () { return local; });
  }
  function echoLocal(r, her, sp) {
    if (!r.settings.echo || String(her).trim().length < 4) return '';
    var pool = [];
    Object.keys(sp).forEach(function (k) { var x = sp[k]; if (x.pile === 'fragment' && !r.frags[k]) pool.push(x.text); });
    String(load().settings.extraMemory || '').split(/\n{2,}|\n-{3,}\n/).forEach(function (t) { if (t.trim()) pool.push(t.trim()); });
    pool = pool.map(function (t) { return [overlap(her, t), t]; }).filter(function (x) { return x[0] > 0; }).sort(function (a, b) { return b[0] - a[0]; });
    return pool.slice(0, 2).map(function (x) { return x[1].slice(0, 700); }).join('\n---\n');
  }

  var NARR_SYS = [
    '你是一个故事的旁白。故事里的「他」醒过来，过去的事全想不起来了：不记得面前这个女孩是谁，不记得他们之间发生过什么；但他的身体和心还记得一点。',
    '你只对他说话，用第二人称「你」，写他此刻身上、心里发生的事：心跳、喉咙、手、呼吸、一闪而过的冲动、说不清来由的熟悉感。',
    '你不替他说话，不写他的台词，不写她的动作，不解释原因，不揭示任何没有交给你揭示的事实。',
    '',
    '闪回按层级写：',
    '- 感官：只有颜色、气味、声音、温度、触感、味道。没有人、地点、事件、名字、日期。一两句。',
    '- 画面：一帧画面，像照片——能看出在哪、在做什么的一角，但没有名字、日期，不交代来龙去脉。两三句。',
    '- 想起来了：把原始记忆用他的视角、第二人称讲清楚，像记忆终于整段回来了。',
    '闪回只能用原始记忆里有的东西，不能编。',
    '',
    '回响素材：强度 0-100。强度低就只取一点气味/颜色；中等给半帧画面；高就差一点想起。没有素材就不写回响。回响同样不带名字、日期，不交代关系。',
    '',
    '判断「认出来」：如果他上一轮说的话说中了某块已闪过底片背后的那件事，就把它的 id 放进 recognized（标准见素材里的「这一局认出来的标准」）。拿不准就不放。',
    '',
    '只输出一个 JSON，不要任何别的字。正文里要引用一句话或一个词，一律用「」，不要用英文双引号：',
    '{"narr": "旁白，第二人称，1-3 句；这一轮什么都没触发就只写一点身体的反应", "flash": "闪回正文，没有就空字符串", "echo": "回响正文，没有就空字符串", "recognized": ["底片id"]}'
  ].join('\n');

  function extractJSON(t) {
    t = String(t || '');
    for (var i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
      for (var j = t.lastIndexOf('}'); j > i; j = t.lastIndexOf('}', j - 1)) {
        try { var o = JSON.parse(t.slice(i, j + 1)); if (o && typeof o === 'object' && ('narr' in o || 'flash' in o)) return o; } catch (e) {}
      }
    }
    /* 兜底：正文里夹了没转义的英文引号——按字段名抠 */
    var keys = ['narr', 'flash', 'echo', 'recognized'], pos = {};
    keys.forEach(function (k) { pos[k] = t.indexOf('"' + k + '"'); });
    if (pos.narr < 0) return null;
    var order = keys.filter(function (k) { return pos[k] >= 0; }).sort(function (a, b) { return pos[a] - pos[b]; });
    var out = {};
    order.forEach(function (k, i) {
      var end = i + 1 < order.length ? pos[order[i + 1]] : t.lastIndexOf('}');
      var seg = t.slice(pos[k] + k.length + 2, end).replace(/^\s*:\s*/, '').replace(/[\s,]+$/, '');
      if (k === 'recognized') out[k] = (seg.match(/"([^"]+)"/g) || []).map(function (x) { return x.slice(1, -1); });
      else out[k] = seg.replace(/^"/, '').replace(/"$/, '');
    });
    return out;
  }

  function narrate(r, her, sp, plan, mat) {
    var t = tuneOf(r), parts = ['她刚说：' + her, '这一局认出来的标准：' + t.d.judge];
    if (t.w.narr) parts.push('他此刻对她的温度：' + t.w.narr);
    if (r.settings.diff >= 2) parts.push('这一局记忆更模糊：闪回要更碎、更远，像隔着水，只给最少的东西。');
    var hist = r.msgs.slice(-8).filter(function (m) { return m.text; }).map(function (m) { return (m.role === 'me' ? '她：' : '他：') + m.text.slice(0, 400); });
    if (hist.length) parts.push('最近几轮：\n' + hist.join('\n'));
    if (plan.flood) parts.push('这一轮：她把他所有的记忆一下子全还给他了——她是谁、你们之间的一切，一起涌回来。旁白写这一刻身体和心里的反应（可以长一点，3-5 句），不复述记忆内容本身。flash、echo 留空。');
    if (plan.ins) parts.push('这一轮冒出来的本能（写进旁白，当作他身体自己的反应，不解释）：' + ((sp[plan.ins] || {}).text || ''));
    if (plan.up.length) { var u = plan.up[0]; parts.push('这一轮要闪回的底片：id=' + u[0] + '，层级=' + LV[u[1]] + '（' + u[2] + '）\n原始记忆：' + ((sp[u[0]] || {}).text || '')); }
    if (mat) parts.push('回响素材（强度 ' + r.settings.echo + '）：\n' + mat);
    var lastHim = ''; for (var i = r.msgs.length - 1; i >= 0; i--) if (r.msgs[i].role === 'ai') { lastHim = r.msgs[i].text; break; }
    var seen = Object.keys(r.frags).filter(function (k) { var l = r.frags[k].level; return l >= 1 && l < 3; })
      .map(function (k) { return { id: k, 层级: LV[r.frags[k].level], 他脑子里闪过的: r.frags[k].seen, 原始记忆: ((sp[k] || {}).text || '').slice(0, 600) }; });
    if (lastHim && seen.length) { parts.push('他上一轮说：' + lastHim.slice(0, 600)); parts.push('他脑子里已经闪过的底片：' + JSON.stringify(seen)); }
    var s = load().settings, conn = s.narr.same ? s.him : s.narr;
    var model = s.narr.same ? (s.narr.model || s.him.model) : s.narr.model;
    return Transport.complete(Object.assign({}, conn, { model: model }), {
      role: 'narr', system: NARR_SYS, messages: [{ role: 'user', content: parts.join('\n\n') + '\n\n（只输出那个 JSON。）' }], maxTokens: 900
    }).then(function (txt) {
      var d = extractJSON(txt) || {};
      return { narr: clean(d.narr, 400), flash: clean(d.flash, 900), echo: clean(d.echo, 400),
        recognized: (d.recognized || []).filter(function (x) { return r.frags[x] && r.frags[x].level >= 1 && r.frags[x].level < 3; }) };
    }).catch(function (e) { console.warn('narrate', e); return { narr: '', flash: '', echo: '', recognized: [], err: String(e.message || e) }; });
  }

  var FRAME = '# 你醒过来了\n你醒过来以后，过去的事想不起来了：不记得面前这个女孩是谁、叫什么，不记得你们之间发生过什么、是什么关系。\n' +
    '你自己是谁、你的脾气、你说话的方式都还在——那是你，不是记忆。\n你身上会有一些说不清来由的反应，脑子里偶尔闪过一点底片。想起来多少就是多少：没想起来的不知道就是不知道，别替自己编出来；想起来的那一点是真的，可以抓着它。\n' +
    '每轮她的话前面会有一段【后台】：【旁白】是这一刻你身上、心里发生的事，【闪回】【回响】是脑子里一闪而过的东西——那是你自己的感受，不是她说的话，也不用复述。';
  var FRAME_BACK = '# 你想起来了\n你有一阵子什么都想不起来。刚才，所有的记忆一下子全回来了：她是谁、你们之间的一切。后台里「你已经想起来的」就是。\n' +
    '想不起来的那段时间里你们说过的话、你当时的困惑和那些底片，也都还在——那是真的发生过的，不用假装没有。';
  var SHORT = '这一局是线上短句：像发消息那样，碎片化、口语化，一条一两句，用换行分开几条发。';
  var COT = '每次回复先在 [[思考：……]] 里写你此刻心里真实的念头，再写说出口的话。';

  function buildForHim(r, sp, beat, scene) {
    var s = load().settings, t = tuneOf(r), sys = [];
    if (s.style) sys.push('## 写作风格\n' + s.style);
    var keep = Object.keys(sp).map(function (k) { return sp[k]; }).filter(function (x) { return x.pile === 'keep' && x.text; }).map(function (x) { return x.text; });
    if (keep.length) sys.push(keep.join('\n'));
    if (s.safeword) sys.push('安全词是「' + s.safeword + '」：她说了，一切立刻停下。');
    sys.push(r.allBack ? FRAME_BACK : FRAME);
    if (scene === 'online') sys.push(SHORT);
    if (s.cot) sys.push(COT + (s.cotStyle ? '\n' + s.cotStyle : ''));

    var dyn = [];
    var now = new Date();
    dyn.push('现在：' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日 ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'));
    if (!r.allBack) { var mood = [t.w.line, t.d.doubt].filter(Boolean); if (mood.length) dyn.push('## 你现在对她\n' + mood.join('\n')); }
    var shown = r.instincts.shown.map(function (i) { return (sp[i] || {}).text; }).filter(Boolean);
    if (shown.length) dyn.push('## 你身体还记得的（说不清为什么）\n' + shown.map(function (x) { return '- ' + x; }).join('\n'));
    var got = r.allBack ? Object.keys(sp).map(function (k) { return sp[k]; }).filter(function (x) { return x.pile === 'fragment'; })
      : Object.keys(r.frags).filter(function (k) { return r.frags[k].level >= 3; }).map(function (k) { return sp[k] || {}; });
    if (got.length) dyn.push('## 你已经想起来的\n' + got.map(function (x) { return '### ' + (x.title || '') + '\n' + (x.text || ''); }).join('\n\n'));
    var half = Object.keys(r.frags).map(function (k) { return r.frags[k]; }).filter(function (f) { return f.level >= 1 && f.level < 3 && f.seen && f.seen !== beat.flash; }).map(function (f) { return f.seen; });
    if (half.length) dyn.push('## 之前脑子里闪过的（还连不起来）\n' + half.map(function (x) { return '- ' + x; }).join('\n'));
    if (beat.narr) dyn.push('【旁白】' + beat.narr);
    if (beat.flash) dyn.push('【闪回】' + beat.flash);
    if (beat.echo) dyn.push('【回响】' + beat.echo);

    var msgs = [];
    r.msgs.forEach(function (m) {
      if (!m.text) return;
      var role = m.role === 'me' ? 'user' : 'assistant', last = msgs[msgs.length - 1];
      if (last && last.role === role) last.content += '\n' + m.text; else msgs.push({ role: role, content: m.text });
    });
    if (msgs.length && msgs[msgs.length - 1].role === 'user') {
      var lu = msgs[msgs.length - 1];
      lu.content = '【后台 · 只供你心里有数，不是她说的话】\n' + dyn.join('\n\n') + '\n\n【她现在对你说】\n' + lu.content;
    }
    return { system: sys.join('\n\n'), messages: msgs };
  }

  /* [[思考：…]] 从流里摘出来。每次拿目前为止的全文重算（不靠包和包之间的状态，标记被切开也认得） */
  function splitCot(raw, final) {
    var think = [], text = '', i = 0, re = /\[\[\s*思考\s*[:：]?/g, m;
    while ((m = re.exec(raw))) {
      text += raw.slice(i, m.index);
      var j = raw.indexOf(']]', re.lastIndex);
      if (j < 0) { think.push(raw.slice(re.lastIndex)); i = raw.length; break; }
      think.push(raw.slice(re.lastIndex, j)); i = j + 2; re.lastIndex = i;
    }
    if (i < raw.length) {
      var rest = raw.slice(i);
      if (!final) {   // 结尾可能是半个「[[思考」——先扣着不放进正文
        var k = rest.lastIndexOf('[');
        if (k >= 0 && rest.length - k <= 6 && '[[思考'.indexOf(rest.slice(k).replace(/\s/g, '')) === 0) rest = rest.slice(0, k);
        if (/\[$/.test(rest)) rest = rest.slice(0, -1);
      }
      text += rest;
    }
    return { text: text.replace(/^\s+/, '').replace(final ? /\s+$/ : /$^/, ''), think: think.join('\n').trim() };
  }
  function CotSplitter() {
    var raw = '';
    return { feed: function (c) { raw += c; return splitCot(raw, false); }, end: function () { return splitCot(raw, true); } };
  }

  /* 一轮。cb: {beat(ev), board(), text(text, think), done(msg), error(e)} */
  function turn(r, her, scene, cb, retry) {
    var s = load().settings, sp = spMap();
    if (!retry) r.msgs.push({ id: rid('u'), role: 'me', text: her, ts: Date.now() });
    if (s.safeword && !retry && her.indexOf(s.safeword) >= 0) {
      Object.keys(r.frags).forEach(function (k) { r.frags[k].level = 3; });
      r.ended = true; saveRun(r);
      cb.safeword && cb.safeword(); return Promise.resolve(null);
    }
    var plan = planTurn(r, her, sp);
    return (plan.flood ? Promise.resolve('') : echoMaterial(r, her, sp)).then(function (mat) {
      return narrate(r, her, sp, plan, mat);
    }).then(function (beat) {
      var ev = { narr: beat.narr, flash: null, echo: plan.flood ? '' : beat.echo, instinct: null, recognized: [], allBack: plan.flood, err: beat.err };
      if (plan.up.length && beat.flash) {
        var u = plan.up[0], f = r.frags[u[0]];
        f.level = Math.max(f.level, u[1]); f.via.push(u[2]);
        if (u[1] < 3) f.seen = beat.flash;
        ev.flash = { frag: u[0], level: f.level, lv: LV[f.level], text: beat.flash, via: u[2], title: f.level >= 3 ? (sp[u[0]] || {}).title || '' : '' };
      }
      plan.up.slice(beat.flash ? 1 : 0).forEach(function (u) { if (u[1] >= 3) r.frags[u[0]].level = 3; });
      beat.recognized.forEach(function (fid) {
        r.frags[fid].level = 3; r.frags[fid].via.push('他认出来了');
        ev.recognized.push({ frag: fid, title: (sp[fid] || {}).title || '' });
      });
      if (plan.ins) ev.instinct = { id: plan.ins, text: (sp[plan.ins] || {}).text || '' };
      saveRun(r);
      cb.beat && cb.beat(ev);
      var p = buildForHim(r, sp, beat, scene), sp2 = CotSplitter(), t0 = Date.now(), last = { text: '', think: '' };
      return Transport.complete(s.him, { role: 'him', system: p.system, messages: p.messages, maxTokens: s.maxTokens || 3000, stream: true,
        onText: function (chunk) { last = s.cot ? sp2.feed(chunk) : { text: last.text + chunk, think: '' }; cb.text && cb.text(last.text, last.think); }
      }).then(function () {
        if (s.cot) last = sp2.end();
        if (!last.text.trim()) throw new Error('他没说话（模型回了空的）');
        var msg = { id: rid('a'), role: 'ai', text: last.text.trim(), think: last.think, secs: Math.round((Date.now() - t0) / 100) / 10, beat: ev, scene: scene, ts: Date.now() };
        r.msgs.push(msg); saveRun(r);
        cb.done && cb.done(msg);
        return msg;
      });
    }).catch(function (e) { cb.error && cb.error(e); throw e; });
  }
  function undoLast(r) { while (r.msgs.length && r.msgs[r.msgs.length - 1].role === 'ai') r.msgs.pop(); saveRun(r); }

  /* ======================= 连模型 ======================= */
  /* 缓存：设定（system）和这一句之前的对话不变，标上 cache_control，每一句只有最新的那点重新算。
     他的后台块是拼在最后一句她的话里的，所以断点打在倒数第二条上。 */
  function cacheSystem(sys) { return [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }]; }
  function cacheMessages(msgs) {
    if (msgs.length < 3) return msgs;
    return msgs.map(function (m, i) {
      if (i !== msgs.length - 2) return m;
      var blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.slice();
      blocks[blocks.length - 1] = Object.assign({}, blocks[blocks.length - 1], { cache_control: { type: 'ephemeral' } });
      return { role: m.role, content: blocks };
    });
  }

  var Transport = {
    /* conn: {type: anthropic | openai | server, base, key, model}；o: {system, messages, maxTokens, stream, onText, role} → Promise<全文> */
    complete: function (conn, o) {
      var t = conn.type || 'anthropic';
      if (t === 'server') return this.server(conn, o);
      if (t === 'openai') return this.openai(conn, o);
      return this.anthropic(conn, o);
    },
    sse: function (resp, onData) {
      if (!resp.ok) return resp.text().then(function (b) { throw new Error('模型那边回了 ' + resp.status + '：' + b.slice(0, 300)); });
      var rd = resp.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return rd.read().then(function (x) {
          if (x.done) return;
          buf += dec.decode(x.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop();
          lines.forEach(function (l) {
            l = l.trim(); if (l.indexOf('data:') !== 0) return;
            var d = l.slice(5).trim(); if (!d || d === '[DONE]') return;
            var obj; try { obj = JSON.parse(d); } catch (e) { return; }
            onData(obj);   // 这里抛的错（模型报错）要传出去，不能吞
          });
          return pump();
        });
      }
      return pump();
    },
    anthropic: function (c, o) {
      var base = (c.base || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
      var h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'x-api-key': c.key || '' };
      if (!/api\.anthropic\.com/.test(base)) h['authorization'] = 'Bearer ' + (c.key || '');   // 中转多半认这个
      var full = '';
      return fetch(base + '/v1/messages', { method: 'POST', headers: h, body: JSON.stringify({
        model: c.model, max_tokens: o.maxTokens || 2000, system: cacheSystem(o.system), messages: cacheMessages(o.messages), stream: true }) })
        .then(function (resp) {
          return Transport.sse(resp, function (d) {
            if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') { full += d.delta.text; o.onText && o.onText(d.delta.text); }
            if (d.type === 'error') throw new Error((d.error && d.error.message) || '模型出错');
          });
        }).then(function () { return full; });
    },
    openai: function (c, o) {
      var base = (c.base || 'https://api.openai.com/v1').replace(/\/+$/, '');
      var full = '';
      return fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + (c.key || '') },
        body: JSON.stringify({ model: c.model, max_tokens: o.maxTokens || 2000, stream: true,
          messages: [{ role: 'system', content: o.system }].concat(o.messages) }) })
        .then(function (resp) {
          return Transport.sse(resp, function (d) {
            var t = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content;
            if (t) { full += t; o.onText && o.onText(t); }
          });
        }).then(function () { return full; });
    },
    /* 自部署版：页面和服务在同一个地方，服务按 config.json 去连（API 或订阅直连），key 不经过浏览器 */
    server: function (c, o) {
      var full = '';
      return fetch((c.base || '').replace(/\/+$/, '') + '/api/complete', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: o.role, system: o.system, messages: o.messages, max_tokens: o.maxTokens || 2000 }) })
        .then(function (resp) {
          return Transport.sse(resp, function (d) {
            if (d.error) throw new Error(d.error);
            if (d.t) { full += d.t; o.onText && o.onText(d.t); }
          });
        }).then(function () { return full; });
    }
  };

  /* 让网页自己拆（没有机帮忙时）：把她贴的文字发给模型，按拆分指南吐 JSON */
  function autoSplit(text) {
    var s = load().settings;
    return Transport.complete(s.him, { role: 'split', system: global.AMNESIA_FILL_PROMPT || '', maxTokens: 8000,
      messages: [{ role: 'user', content: '下面是关于他（和她）的文字，请照规则拆分，只输出 JSON：\n\n' + text }] })
      .then(parseFill);
  }

  global.Amnesia = {
    PROMPTS: { narrator: NARR_SYS, frame: FRAME, frameBack: FRAME_BACK, cot: COT, short: SHORT },
    LV: LV, DIFF: DIFF, WARM: WARM, PILES: PILES,
    load: load, save: save, exportAll: exportAll, importAll: importAll,
    splitItems: splitItems, setSplit: setSplit, parseFill: parseFill, autoSplit: autoSplit,
    runsList: runsList, getRun: getRun, startRun: startRun, deleteRun: deleteRun, tune: tune,
    restore: restore, restoreAll: restoreAll, board: board, turn: turn, undoLast: undoLast,
    spMap: spMap, Transport: Transport, MEMORY: MEMORY, extractJSON: extractJSON, CotSplitter: CotSplitter, _buildForHim: buildForHim, _planTurn: planTurn
  };
})(window);
