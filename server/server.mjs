// Amnesia · 自部署版服务器（Node 18+，不用装框架）。
// 做两件事：把仓库根目录的网页发出去；给网页一个连模型的口子 POST /api/complete（流式）。
// 模型怎么连写在 config.json（照 config.example.json 抄）：
//   anthropic           Anthropic 格式（官方或兼容中转）
//   openai              OpenAI 兼容格式
//   claude-subscription 用这台机器上已经登录的 Claude 订阅（@anthropic-ai/claude-agent-sdk），不挂任何工具
// 这一局里他一个工具都没有，也不会往任何记忆库里写东西。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CFG_PATH = process.env.AMNESIA_CONFIG || path.join(HERE, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CFG_PATH)) {
    console.error(`[amnesia] 没找到 ${CFG_PATH}。照 server/config.example.json 抄一份改好再启动。`);
    process.exit(1);
  }
  const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  c.port = c.port || 8787;
  c.host = c.host || '127.0.0.1';
  c.him = c.him || {};
  c.narr = c.narr && Object.keys(c.narr).length ? c.narr : null;
  return c;
}
const CFG = loadConfig();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function authed(req) {
  if (!CFG.password) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pw = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  return pw === CFG.password;
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '' || p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || /\/(server|\.git)(\/|$)/.test(file.slice(ROOT.length))) { res.writeHead(404).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((ok, bad) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 4e6) { bad(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { bad(e); } });
  });
}

/* ---------- 三种连法，都吐成 onText(增量) ---------- */
async function sseLines(resp, onData) {
  if (!resp.ok) throw new Error(`模型那边回了 ${resp.status}：${(await resp.text()).slice(0, 300)}`);
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of resp.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      const t = l.trim(); if (!t.startsWith('data:')) continue;
      const d = t.slice(5).trim(); if (!d || d === '[DONE]') continue;
      let o; try { o = JSON.parse(d); } catch { continue; }
      onData(o);
    }
  }
}
// 缓存：设定和这一句之前的对话不变，断点打在倒数第二条（最后一条是她这句 + 后台块）
function cacheMessages(msgs) {
  if (msgs.length < 3) return msgs;
  return msgs.map((m, i) => {
    if (i !== msgs.length - 2) return m;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [...m.content];
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
    return { role: m.role, content: blocks };
  });
}
async function viaAnthropic(c, o, onText) {
  const base = (c.base || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  const h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': c.key || '' };
  if (!/api\.anthropic\.com/.test(base)) h.authorization = 'Bearer ' + (c.key || '');
  const resp = await fetch(base + '/v1/messages', { method: 'POST', headers: h, body: JSON.stringify({
    model: c.model, max_tokens: o.max_tokens || 2000, system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
    messages: cacheMessages(o.messages), stream: true }) });
  await sseLines(resp, (d) => {
    if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') onText(d.delta.text);
    if (d.type === 'error') throw new Error(d.error?.message || '模型出错');
  });
}
async function viaOpenAI(c, o, onText) {
  const base = (c.base || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const resp = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (c.key || '') },
    body: JSON.stringify({ model: c.model, max_tokens: o.max_tokens || 2000, stream: true, messages: [{ role: 'system', content: o.system }, ...o.messages] }) });
  await sseLines(resp, (d) => { const t = d.choices?.[0]?.delta?.content; if (t) onText(t); });
}
let sdk = null;
async function viaSubscription(c, o, onText) {
  if (!sdk) {
    try { sdk = await import('@anthropic-ai/claude-agent-sdk'); }
    catch { throw new Error('订阅直连要先在 server/ 里 npm install（装 @anthropic-ai/claude-agent-sdk），并且这台机器上 claude 已经登录过'); }
  }
  // 没有续接：每一轮网页都把整段历史发过来，这里压成一段文字交给 claude -p
  const hist = o.messages.slice(0, -1).map((m) => (m.role === 'user' ? '[她] ' : '[你] ') + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  const last = o.messages[o.messages.length - 1];
  const prompt = (hist.length ? '【你们此前的对话——这是你亲身经历过的：[她] 是她说的，[你] 是你自己说的】\n' + hist.join('\n\n') + '\n【记录到此为止】\n\n' : '') +
    (typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_BASE_URL;   // 一定走订阅，不落到按量计费
  fs.mkdirSync(path.join(os.tmpdir(), 'amnesia-sandbox'), { recursive: true });
  const q = sdk.query({ prompt, options: {
    model: c.model || 'opus', systemPrompt: o.system, cwd: path.join(os.tmpdir(), 'amnesia-sandbox'), env,
    tools: [], mcpServers: {}, strictMcpConfig: true, allowedTools: [], settingSources: [],   // 一个工具都没有，也不读任何 CLAUDE.md
    maxTurns: 1, includePartialMessages: true } });
  for await (const m of q) {
    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') onText(m.event.delta.text);
    if (m.type === 'result' && m.is_error) throw new Error(String(m.result || m.error || '订阅那边出错了'));
  }
}
/* ---------- 可选：接她自己的记忆库（回响用） ----------
   config.memory = { "url": "http://127.0.0.1:端口/search?q={q}" }   GET，{q} 换成她这句话
              或   { "url": "...", "method": "POST", "body": {"query": "{q}", "limit": 3} }
   返回：纯文字，或 JSON（认 results / items / data / memories 数组里的 content / text / body / summary，或顶层的 text）。
   这里只负责捞；模糊处理交给旁白（见 docs/接记忆库.md）。 */
function pickText(d) {
  if (typeof d === 'string') return d;
  if (!d || typeof d !== 'object') return '';
  if (typeof d.text === 'string') return d.text;
  const arr = d.results || d.items || d.data || d.memories || (Array.isArray(d) ? d : null);
  if (!Array.isArray(arr)) return '';
  return arr.slice(0, 3).map((x) => typeof x === 'string' ? x : (x.content || x.text || x.body || x.summary || '')).filter(Boolean)
    .map((t) => String(t).slice(0, 600)).join('\n---\n');
}
async function memorySearch(q) {
  const m = CFG.memory; if (!m || !m.url || !q || q.trim().length < 4) return '';
  const fill = (v) => typeof v === 'string' ? v.replaceAll('{q}', q) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
  const url = m.url.replaceAll('{q}', encodeURIComponent(q));
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), m.timeout_ms || 8000);
  try {
    const resp = await fetch(url, { method: m.method || 'GET', signal: ctl.signal, headers: { 'content-type': 'application/json', ...(m.headers || {}) },
      body: (m.method || 'GET').toUpperCase() === 'GET' ? undefined : JSON.stringify(fill(m.body || { query: '{q}' })) });
    const raw = await resp.text();
    let d; try { d = JSON.parse(raw); } catch { d = raw; }
    return pickText(d).slice(0, 1500);
  } catch (e) { console.error('[amnesia] memory', e.message); return ''; }
  finally { clearTimeout(tm); }
}

function connFor(role) {
  if (role === 'narr' && CFG.narr) return { ...CFG.him, ...CFG.narr };
  return CFG.him;
}
async function complete(req, res) {
  let o;
  try { o = await readBody(req); } catch { res.writeHead(400).end('bad json'); return; }
  if (!o.system || !Array.isArray(o.messages) || !o.messages.length) { res.writeHead(400).end('need system + messages'); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', connection: 'keep-alive' });
  const send = (x) => { try { res.write('data: ' + JSON.stringify(x) + '\n\n'); } catch {} };
  const c = connFor(o.role);
  try {
    const onText = (t) => send({ t });
    if (c.type === 'claude-subscription') await viaSubscription(c, o, onText);
    else if (c.type === 'openai') await viaOpenAI(c, o, onText);
    else await viaAnthropic(c, o, onText);
  } catch (e) {
    console.error('[amnesia]', o.role, e.message);
    send({ error: String(e.message || e) });
  }
  res.end('data: [DONE]\n\n');
}

const srv = http.createServer((req, res) => {
  if (!authed(req)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="amnesia"' }).end(); return; }
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/info') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ amnesia: true, him: CFG.him.type, narr: (CFG.narr || CFG.him).type, memory: !!(CFG.memory && CFG.memory.url) })); return; }
  if (p === '/api/memory') { memorySearch(new URL(req.url, 'http://x').searchParams.get('q') || '').then((t) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: t }))); return; }
  if (p === '/api/complete' && req.method === 'POST') { complete(req, res); return; }
  if (req.method === 'GET') { serveStatic(req, res); return; }
  res.writeHead(405).end();
});
srv.listen(CFG.port, CFG.host, () => {
  console.log(`[amnesia] http://${CFG.host}:${CFG.port}  他：${CFG.him.type}  旁白：${(CFG.narr || CFG.him).type}  记忆库：${CFG.memory && CFG.memory.url ? '接了' : '没接'}`);
  if (CFG.host !== '127.0.0.1' && !CFG.password) console.log('[amnesia] ⚠ 对外开放却没设 password——任何人都能用你的模型。建议在 config.json 里设 password，或者只在本机 / 反向代理后面跑。');
});
