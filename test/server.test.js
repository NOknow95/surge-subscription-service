import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function json(base, endpoint, method, body) {
  const response = await fetch(`${base}${endpoint}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('请求头、脚本顺序、持久化和失败缓存回退', async t => {
  let upstreamOk = true;
  let receivedHeader = null;
  const upstream = http.createServer((req, res) => {
    receivedHeader = req.headers['user-agent'];
    if (!upstreamOk) { res.writeHead(503); res.end('unavailable'); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('[General]\nloglevel = notify\n[Rule]\nFINAL,DIRECT\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'surge-service-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: 'ignore' });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { const response = await fetch(`${base}/api/state`); ready = response.ok; if (ready) break; }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(ready, '服务应成功启动');
  const settings = { sourceUrl: `http://127.0.0.1:${upstream.address().port}/profile`, publicBaseUrl: '', interval: 3600, headers: [{ name: 'User-Agent', value: 'Surge-Test' }] };
  assert.equal((await json(base, '/api/settings', 'PUT', settings)).status, 200);
  const script = { name: '插入规则', enabled: true, code: "module.exports = config => { config.rules.unshift('DOMAIN,test.example,DIRECT'); return config; }" };
  assert.equal((await json(base, '/api/scripts', 'POST', script)).status, 201);
  const first = await fetch(`${base}/subscription`);
  const content = await first.text();
  assert.equal(first.status, 200);
  assert.equal(receivedHeader, 'Surge-Test');
  assert.match(content, /^#!MANAGED-CONFIG http:\/\/127\.0\.0\.1:\d+\/subscription interval=3600/);
  assert.match(content, /DOMAIN,test\.example,DIRECT\nFINAL,DIRECT/);
  upstreamOk = false;
  const fallback = await fetch(`${base}/subscription`);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get('x-subscription-stale'), 'true');
  assert.equal(await fallback.text(), content);
  const status = await (await fetch(`${base}/api/state`)).json();
  assert.match(status.lastError, /HTTP 503/);
  assert.equal(status.hasCache, true);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.version, 2);
  // 缓存保存的是规范订阅地址 /subscription/default，旧 /subscription 响应会改写为旧路径。
  assert.match(saved.profiles.default.cache, /^#!MANAGED-CONFIG http:\/\/127\.0\.0\.1:\d+\/subscription\/default interval=3600/);
  assert.equal(saved.profiles.default.cache.replace(/^#!MANAGED-CONFIG[^\n]*/, ''), content.replace(/^#!MANAGED-CONFIG[^\n]*/, ''));
  assert.equal(saved.profiles.default.scripts.length, 1);
});
