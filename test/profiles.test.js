import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function tempDataDir(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'surge-profiles-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function startService(t, dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch(`${base}/api/profiles`); if (response.ok) { ready = true; break; } }
    catch { await sleep(30); }
  }
  if (!ready) { child.kill(); throw new Error('服务未能启动'); }
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  };
  t.after(stop);
  return { base, stop };
}

async function json(base, endpoint, method, body) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('追加项名称：兼容旧数据、必填校验、部分更新、复制与重启保存', async t => {
  const dataDir = await tempDataDir(t);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 2, profiles: {
    default: { appends: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', section: 'Rule', position: 'first', content: 'FINAL,DIRECT', enabled: true }] },
  } }));
  const service = await startService(t, dataDir);
  const endpoint = '/api/profiles/default/appends';
  const initial = await json(service.base, '/api/profiles/default/state', 'GET');
  const legacy = initial.body.appends[0];
  assert.equal(legacy.name, 'Rule · 最前');
  assert.equal(legacy.createIfMissing, true);
  assert.equal(legacy.overwrite, false);
  const item = { section: 'Proxy Group', position: 'last', content: 'Group = select,DIRECT', enabled: true };
  for (const name of [undefined, '', '   ', null, 123, 'x'.repeat(101)]) {
    assert.equal((await json(service.base, endpoint, 'POST', { ...item, name })).status, 400);
  }
  const created = await json(service.base, endpoint, 'POST', { ...item, name: '  自定义组  ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, '自定义组');
  const updated = await json(service.base, `${endpoint}/${created.body.id}`, 'PUT', { enabled: false });
  assert.equal(updated.body.name, '自定义组');
  assert.equal(updated.body.enabled, false);
  assert.equal(updated.body.createIfMissing, true);
  assert.equal(updated.body.overwrite, false);
  const renamed = await json(service.base, `${endpoint}/${legacy.id}`, 'PUT', { name: '规则追加' });
  assert.equal(renamed.body.name, '规则追加');
  assert.equal((await json(service.base, '/api/profiles', 'POST', { id: 'copy1', name: '副本', copyFrom: 'default' })).status, 201);
  const copy = await json(service.base, '/api/profiles/copy1/state', 'GET');
  assert.deepEqual(copy.body.appends.map(append => append.name), ['规则追加', '自定义组']);
  assert.notEqual(copy.body.appends[0].id, legacy.id);
  await service.stop();
  const restarted = await startService(t, dataDir);
  const saved = await json(restarted.base, '/api/profiles/default/state', 'GET');
  assert.deepEqual(saved.body.appends.map(append => append.name), ['规则追加', '自定义组']);
});

test('完全覆盖替换原分节及前序追加，重置首部插入位置，后续追加和脚本继续执行', async t => {
  const dataDir = await tempDataDir(t);
  const service = await startService(t, dataDir);
  const { base } = service;
  const upstream = textUpstream('[General]\nloglevel = notify\n[Rule]\n# original one\n[Rule]\n# original two\n');
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  await json(base, '/api/profiles/default/settings', 'PUT', { sourceUrl: `http://127.0.0.1:${port}/`, interval: 600, headers: [] });
  const endpoint = '/api/profiles/default/appends';
  const add = async payload => {
    const result = await json(base, endpoint, 'POST', { name: '规则', section: 'Rule', position: 'first', content: '# before', ...payload });
    assert.equal(result.status, 201);
    return result.body;
  };
  await add({});
  const replace = await add({ overwrite: true, content: '# replacement\n\n# replacement end' });
  await add({ content: '# after first' });
  await add({ content: '# after last', position: 'last' });
  await add({ section: 'Missing', overwrite: true, createIfMissing: false, content: '# skipped' });
  await add({ section: 'Created', overwrite: true, content: '# created' });
  await json(base, '/api/profiles/default/scripts', 'POST', { name: '后续脚本', code: "module.exports = config => { config.rules.push('# script'); return config; };" });
  const output = await (await fetch(`${base}/subscription/default`)).text();
  assert.ok(output.includes('[Rule]\n# after first\n# replacement\n\n# replacement end\n# after last\n# script'));
  assert.equal(output.match(/\[Rule\]/g).length, 1);
  assert.ok(!output.includes('# original') && !output.includes('# before') && !output.includes('[Missing]'));
  assert.ok(output.includes('[General]\nloglevel = notify'));
  assert.ok(output.includes('[Created]\n# created'));
  for (const overwrite of ['true', null, 1]) {
    assert.equal((await json(base, `${endpoint}/${replace.id}`, 'PUT', { overwrite })).status, 400);
  }
  const update = await json(base, `${endpoint}/${replace.id}`, 'PUT', { name: '重命名' });
  assert.equal(update.body.overwrite, true);
  await json(base, '/api/profiles', 'POST', { id: 'copy', name: '副本', copyFrom: 'default' });
  const copy = await json(base, '/api/profiles/copy/state', 'GET');
  assert.equal(copy.body.appends[1].overwrite, true);
  await service.stop();
  const restarted = await startService(t, dataDir);
  const saved = await json(restarted.base, '/api/profiles/default/state', 'GET');
  assert.equal(saved.body.appends[1].overwrite, true);
  const reverted = await json(restarted.base, `${endpoint}/${replace.id}`, 'PUT', { overwrite: false });
  assert.equal(reverted.body.position, 'first');
  const appended = await (await fetch(`${restarted.base}/subscription/default`)).text();
  assert.ok(appended.includes('# before') && appended.includes('# original one') && appended.includes('# original two'));
});

test('缺失分节可跳过或创建，空 Rule 占位不视为已有分节，后续追加可使用先前创建的分节', async t => {
  const dataDir = await tempDataDir(t);
  const { base } = await startService(t, dataDir);
  const upstream = textUpstream('[General]\nloglevel = notify\n[Existing]\n');
  const port = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  await json(base, '/api/profiles/default/settings', 'PUT', { sourceUrl: `http://127.0.0.1:${port}/`, interval: 600, headers: [] });
  const endpoint = '/api/profiles/default/appends';
  for (const section of ['Rule', 'Proxy Group']) {
    const created = await json(base, endpoint, 'POST', { name: section, section, position: 'last', content: '# first', createIfMissing: false });
    assert.equal(created.status, 201);
    const skipped = await (await fetch(`${base}/subscription/default`)).text();
    assert.ok(!skipped.includes(`[${section}]`));
    for (const createIfMissing of ['false', null, 0]) {
      assert.equal((await json(base, `${endpoint}/${created.body.id}`, 'PUT', { createIfMissing })).status, 400);
    }
    await json(base, `${endpoint}/${created.body.id}`, 'PUT', { createIfMissing: true });
    await json(base, endpoint, 'POST', { name: '后续', section, position: 'last', content: '# second', createIfMissing: false });
    const output = await (await fetch(`${base}/subscription/default`)).text();
    assert.ok(output.includes(`[${section}]\n# first\n# second`));
    const copy = await json(base, '/api/profiles', 'POST', { id: section === 'Rule' ? 'rulecopy' : 'groupcopy', name: '复制', copyFrom: 'default' });
    const copied = await json(base, `/api/profiles/${copy.body.id}/state`, 'GET');
    assert.equal(copied.body.appends.at(-1).createIfMissing, false);
  }
  await json(base, endpoint, 'POST', { name: '空分节', section: 'Existing', position: 'last', content: '# existing', createIfMissing: false });
  const output = await (await fetch(`${base}/subscription/default`)).text();
  assert.ok(output.includes('[Existing]\n# existing'));
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function textUpstream(content) {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(typeof content === 'function' ? content(req) : content);
  });
}

// 上游请求会一直挂起，直到测试显式 release，用于确定性构造并发窗口。
function gatedUpstream() {
  const pending = [];
  const server = http.createServer((req, res) => {
    pending.push(mode => {
      if (mode === 'fail') {
        res.writeHead(503);
        res.end('unavailable');
        return;
      }
      const marker = String(req.headers['x-profile'] ?? 'none');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`[General]\nmarker = ${marker}\n[Rule]\nFINAL,DIRECT\n`);
    });
  });
  return {
    server,
    get pendingCount() { return pending.length; },
    release(mode = 'ok') {
      const next = pending.shift();
      if (!next) throw new Error('没有等待中的上游请求');
      next(mode);
    },
  };
}

async function waitForPending(gate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (gate.pendingCount >= 1) return;
    await sleep(10);
  }
  throw new Error('等待上游请求超时');
}

// 先发送一半请求体，让服务端进入 readJson 等待；测试期间插入其他请求，再补齐请求体。
function delayedJsonRequest(base, endpoint, method, body) {
  const payload = JSON.stringify(body);
  const splitAt = Math.max(1, Math.floor(payload.length / 2));
  let finish;
  const response = new Promise((resolve, reject) => {
    const url = new URL(endpoint, base);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject);
    request.write(payload.slice(0, splitAt));
    finish = () => request.end(payload.slice(splitAt));
  });
  return { response, finish };
}

function refreshRequest(base, profileId) {
  return fetch(`${base}/api/profiles/${encodeURIComponent(profileId)}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

test('旧单实例 state.json 迁移为 default profile，保留数据且重启不重复迁移', async t => {
  const dataDir = await tempDataDir(t);
  const legacyCache = '#!MANAGED-CONFIG http://nas.example:3080/subscription interval=1234\n[General]\nold = yes\n[Rule]\nFINAL,DIRECT\n';
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    settings: { sourceUrl: 'http://127.0.0.1:1/profile', publicBaseUrl: 'http://nas.example:3080', interval: 1234, headers: [{ name: 'X-Old', value: '1' }] },
    scripts: [{ id: '00000000-0000-0000-0000-000000000001', name: '旧脚本', code: 'module.exports = config => config;', enabled: true }],
    cache: legacyCache,
    lastError: '旧错误',
    lastAttemptAt: '2024-01-01T00:00:00.000Z',
    lastSuccessAt: '2024-01-01T00:00:01.000Z',
  }));
  const first = await startService(t, dataDir);
  const state = await (await fetch(`${first.base}/api/state`)).json();
  assert.equal(state.id, 'default');
  assert.equal(state.name, '默认配置');
  assert.equal(state.settings.interval, 1234);
  assert.equal(state.settings.publicBaseUrl, 'http://nas.example:3080');
  assert.equal(state.settings.headers[0].value, '1');
  assert.equal(state.scripts.length, 1);
  assert.equal(state.scripts[0].name, '旧脚本');
  assert.equal(state.hasCache, true);
  assert.equal(state.lastError, '旧错误');
  assert.equal(state.lastAttemptAt, '2024-01-01T00:00:00.000Z');
  assert.equal(state.lastSuccessAt, '2024-01-01T00:00:01.000Z');
  assert.equal(state.subscriptionUrl, 'http://nas.example:3080/subscription/default');

  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(stored.settings, undefined);
  assert.equal(stored.profiles.default.cache, legacyCache);
  assert.equal(stored.profiles.default.scripts.length, 1);
  await first.stop();

  const second = await startService(t, dataDir);
  const again = await (await fetch(`${second.base}/api/state`)).json();
  assert.equal(again.name, '默认配置');
  assert.equal(again.lastSuccessAt, '2024-01-01T00:00:01.000Z');
  assert.equal(again.hasCache, true);
  const list = await (await fetch(`${second.base}/api/profiles`)).json();
  assert.deepEqual(list.profiles.map(profile => profile.id), ['default']);

  // 旧 /subscription 入口仍指向 default，并改写旧缓存里的 MANAGED-CONFIG 地址。
  const subscription = await fetch(`${second.base}/subscription`);
  assert.equal(subscription.status, 200);
  assert.equal(subscription.headers.get('x-subscription-stale'), 'true');
  const text = await subscription.text();
  assert.match(text, /^#!MANAGED-CONFIG http:\/\/nas\.example:3080\/subscription interval=1234/m);
  assert.match(text, /\[General\]\nold = yes/);
  assert.doesNotMatch(text, /#!MANAGED-CONFIG[^\n]*\/subscription\/default/);

  // 全新部署同样自带 default。
  const freshDir = await tempDataDir(t);
  const fresh = await startService(t, freshDir);
  const freshList = await (await fetch(`${fresh.base}/api/profiles`)).json();
  assert.deepEqual(freshList.profiles.map(profile => profile.id), ['default']);
  assert.equal(freshList.profiles[0].name, '默认配置');
  const freshStored = JSON.parse(await fs.readFile(path.join(freshDir, 'state.json'), 'utf8'));
  assert.equal(freshStored.version, 2);
});

test('profile 隔离：上游、请求头、脚本和缓存互不影响', async t => {
  const dataDir = await tempDataDir(t);
  const seen = { default: [], alpha: [] };
  const upstreamDefault = textUpstream(() => '[General]\nname = default\n[Rule]\nFINAL,DIRECT\n');
  upstreamDefault.on('request', req => seen.default.push(req.headers['x-profile']));
  const upstreamAlpha = textUpstream(() => '[General]\nname = alpha\n[Rule]\nFINAL,DIRECT\n');
  upstreamAlpha.on('request', req => seen.alpha.push(req.headers['x-profile']));
  const portDefault = await listen(upstreamDefault);
  const portAlpha = await listen(upstreamAlpha);
  t.after(() => upstreamDefault.close());
  t.after(() => upstreamAlpha.close());
  const { base } = await startService(t, dataDir);

  assert.equal((await json(base, '/api/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${portDefault}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'X-Profile', value: 'default' }],
  })).status, 200);
  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'alpha', name: 'Alpha' })).status, 201);
  assert.equal((await json(base, '/api/profiles/alpha/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${portAlpha}/p`, publicBaseUrl: 'https://alpha.example', interval: 900, headers: [{ name: 'X-Profile', value: 'alpha' }],
  })).status, 200);
  assert.equal((await json(base, '/api/profiles/alpha/scripts', 'POST', {
    name: 'alpha 专用', enabled: true, code: "module.exports = config => { config.rules.unshift('DOMAIN,alpha.test,DIRECT'); return config; }",
  })).status, 201);
  assert.equal((await json(base, '/api/profiles/default/refresh', 'POST', {})).status, 200);

  const alphaSubscription = await (await fetch(`${base}/subscription/alpha`)).text();
  const defaultSubscription = await (await fetch(`${base}/subscription/default`)).text();
  assert.ok(seen.default.length >= 1 && seen.default.every(value => value === 'default'));
  assert.ok(seen.alpha.length >= 1 && seen.alpha.every(value => value === 'alpha'));
  assert.match(alphaSubscription, /^#!MANAGED-CONFIG https:\/\/alpha\.example\/subscription\/alpha interval=900/m);
  assert.match(alphaSubscription, /name = alpha/);
  assert.match(alphaSubscription, /DOMAIN,alpha\.test,DIRECT/);
  assert.match(defaultSubscription, new RegExp(`^#!MANAGED-CONFIG http://127\\.0\\.0\\.1:${new URL(base).port}/subscription/default interval=600`, 'm'));
  assert.match(defaultSubscription, /name = default/);
  assert.doesNotMatch(defaultSubscription, /alpha\.test/);

  const defaultState = await (await fetch(`${base}/api/state`)).json();
  const alphaState = await (await fetch(`${base}/api/profiles/alpha/state`)).json();
  assert.equal(defaultState.subscriptionUrl, `http://127.0.0.1:${new URL(base).port}/subscription/default`);
  assert.equal(alphaState.subscriptionUrl, 'https://alpha.example/subscription/alpha');
  assert.deepEqual(alphaState.scripts.map(script => script.name), ['alpha 专用']);
  assert.equal(defaultState.scripts.length, 0);
  assert.equal(alphaState.settings.interval, 900);
  assert.equal(defaultState.settings.interval, 600);

  // default 上游失败时只回退到自己的缓存，alpha 状态不受影响。
  upstreamDefault.close();
  const fallback = await fetch(`${base}/subscription/default`);
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get('x-subscription-stale'), 'true');
  assert.match(await fallback.text(), /name = default/);
  assert.equal((await (await fetch(`${base}/api/profiles/alpha/state`)).json()).lastError, null);
});

test('订阅路径按 profile 生成，重命名不影响链接，未知 id 返回 404', async t => {
  const dataDir = await tempDataDir(t);
  const upstream = textUpstream('[General]\nname = shared\n[Rule]\nFINAL,DIRECT\n');
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const { base } = await startService(t, dataDir);
  await json(base, '/api/profiles', 'POST', { id: 'link', name: 'Link' });
  await json(base, '/api/profiles/link/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${port}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'User-Agent', value: 'Surge' }],
  });
  const before = await (await fetch(`${base}/api/profiles/link/state`)).json();
  assert.equal((await json(base, '/api/profiles/link', 'PUT', { name: 'Link Renamed' })).status, 200);
  const after = await (await fetch(`${base}/api/profiles/link/state`)).json();
  assert.equal(after.name, 'Link Renamed');
  assert.equal(after.subscriptionUrl, before.subscriptionUrl);
  const content = await (await fetch(`${base}/subscription/link`)).text();
  assert.match(content, new RegExp(`^#!MANAGED-CONFIG http://127\\.0\\.0\\.1:${new URL(base).port}/subscription/link interval=600`, 'm'));

  // 旧 /subscription 始终指向 default，返回内容也使用旧路径。
  assert.equal((await json(base, '/api/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${port}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'User-Agent', value: 'Surge' }],
  })).status, 200);
  const defaultContent = await (await fetch(`${base}/subscription`)).text();
  assert.match(defaultContent, new RegExp(`^#!MANAGED-CONFIG http://127\\.0\\.0\\.1:${new URL(base).port}/subscription interval=600`, 'm'));
});

test('profile id 有边界校验、创建后不可修改，名称允许重名', async t => {
  const dataDir = await tempDataDir(t);
  const { base } = await startService(t, dataDir);
  for (const id of ['Default', '1abc', 'a.b', 'a b', 'a'.repeat(17), '', 'abc$', '中文', 'a/b', 'a\tb']) {
    const result = await json(base, '/api/profiles', 'POST', { id, name: 'x' });
    assert.equal(result.status, 400, `id ${JSON.stringify(id)} 应被拒绝`);
  }
  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'a', name: '单字母' })).status, 201);
  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'a'.repeat(16), name: '最长' })).status, 201);
  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'with-dash_and', name: '符号' })).status, 201);
  for (const id of ['test1', 'a1', 'a123456789012345', 'test-1_2']) {
    assert.equal((await json(base, '/api/profiles', 'POST', { id, name: '含数字' })).status, 201);
    const saved = await (await fetch(`${base}/api/profiles/${id}/state`)).json();
    assert.equal(saved.id, id);
    assert.ok(saved.subscriptionUrl.endsWith(`/subscription/${id}`));
  }
  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'a', name: '重复' })).status, 409);

  // 修改 id 的请求必须被拒绝，不能静默忽略，也不能顺带改名。
  const rejected = await json(base, '/api/profiles/a', 'PUT', { id: 'b', name: '新名字' });
  assert.equal(rejected.status, 400);
  const state = await (await fetch(`${base}/api/profiles/a/state`)).json();
  assert.equal(state.id, 'a');
  assert.equal(state.name, '单字母');

  assert.equal((await json(base, '/api/profiles/a', 'PUT', { id: 'a', name: '  改名后  ' })).status, 200);
  const renamed = await (await fetch(`${base}/api/profiles/a/state`)).json();
  assert.equal(renamed.name, '改名后');
  assert.match(renamed.subscriptionUrl, /\/subscription\/a$/);

  assert.equal((await json(base, '/api/profiles/a', 'PUT', { name: '   ' })).status, 400);
  assert.equal((await json(base, '/api/profiles/a', 'PUT', { name: 'x'.repeat(101) })).status, 400);
  assert.equal((await json(base, '/api/profiles/a', 'PUT', { name: '重复' })).status, 200);
  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'dup-name', name: '重复' })).status, 201);
  const list = await (await fetch(`${base}/api/profiles`)).json();
  assert.equal(list.profiles.find(profile => profile.id === 'a').name, '重复');
  assert.equal(list.profiles.filter(profile => profile.name === '重复').length, 2);
});

test('default 禁止删除，未知 profile 的所有入口返回 404', async t => {
  const dataDir = await tempDataDir(t);
  const { base } = await startService(t, dataDir);
  assert.equal((await json(base, '/api/profiles/default', 'DELETE')).status, 400);
  assert.equal((await fetch(`${base}/api/profiles/default/state`)).status, 200);
  assert.equal((await json(base, '/api/profiles/ghost', 'DELETE')).status, 404);
  assert.equal((await json(base, '/api/profiles/ghost', 'PUT', { name: 'x' })).status, 404);
  assert.equal((await json(base, '/api/profiles/ghost/settings', 'PUT', { interval: 600 })).status, 404);
  assert.equal((await fetch(`${base}/api/profiles/ghost/state`)).status, 404);
  assert.equal((await fetch(`${base}/api/profiles/ghost/preview`)).status, 404);
  assert.equal((await json(base, '/api/profiles/ghost/refresh', 'POST', {})).status, 404);
  assert.equal((await fetch(`${base}/subscription/ghost`)).status, 404);

  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'gone', name: 'Gone' })).status, 201);
  assert.equal((await json(base, '/api/profiles/gone', 'DELETE')).status, 200);
  assert.equal((await fetch(`${base}/subscription/gone`)).status, 404);
  assert.equal((await fetch(`${base}/api/profiles/gone/state`)).status, 404);
});

test('复制 profile 深拷贝设置与脚本且不复制缓存和历史', async t => {
  const dataDir = await tempDataDir(t);
  const upstream = textUpstream('[General]\nsource = origin\n[Rule]\nFINAL,DIRECT\n');
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const { base } = await startService(t, dataDir);
  assert.equal((await json(base, '/api/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${port}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'X', value: 'origin' }],
  })).status, 200);
  const scriptA = await json(base, '/api/scripts', 'POST', { name: 'A', enabled: true, code: 'module.exports = c => c;' });
  const scriptB = await json(base, '/api/scripts', 'POST', { name: 'B', enabled: false, code: "module.exports = c => { c.rules.unshift('DOMAIN,b.test,DIRECT'); return c; }" });
  await fetch(`${base}/subscription`).then(response => response.text());
  const originState = await (await fetch(`${base}/api/state`)).json();
  assert.equal(originState.hasCache, true);

  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'copy-a', name: '副本', copyFrom: 'default' })).status, 201);
  const copyState = await (await fetch(`${base}/api/profiles/copy-a/state`)).json();
  assert.equal(copyState.hasCache, false);
  assert.equal(copyState.lastError, null);
  assert.equal(copyState.lastAttemptAt, null);
  assert.equal(copyState.lastSuccessAt, null);
  assert.deepEqual(copyState.settings, originState.settings);
  assert.deepEqual(copyState.scripts.map(script => [script.name, script.enabled]), [['A', true], ['B', false]]);
  assert.notEqual(copyState.scripts[0].id, scriptA.body.id);
  assert.notEqual(copyState.scripts[1].id, scriptB.body.id);

  // 修改副本不会影响来源 profile，反之亦然。
  await json(base, `/api/profiles/copy-a/scripts/${copyState.scripts[0].id}`, 'PUT', { name: 'A2', code: 'module.exports = c => c;', enabled: true });
  await json(base, '/api/profiles/copy-a/settings', 'PUT', { ...copyState.settings, headers: [{ name: 'X', value: 'copy' }] });
  const originAfter = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual(originAfter.scripts.map(script => script.name), ['A', 'B']);
  assert.equal(originAfter.settings.headers[0].value, 'origin');
  const copyAfter = await (await fetch(`${base}/api/profiles/copy-a/state`)).json();
  assert.equal(copyAfter.scripts[0].name, 'A2');
  assert.equal(copyAfter.settings.headers[0].value, 'copy');
  assert.equal((await fetch(`${base}/api/profiles/copy-a/preview`)).status, 404);

  // 复制来源不存在时拒绝创建。
  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'copy-b', name: '副本2', copyFrom: 'ghost' })).status, 404);
});

test('并发：刷新进行中删除并重建相同 id，旧订阅请求 404 且不污染新 profile', async t => {
  const dataDir = await tempDataDir(t);
  const gate = gatedUpstream();
  const port = await listen(gate.server);
  t.after(() => gate.server.close());
  const { base } = await startService(t, dataDir);

  await json(base, '/api/profiles', 'POST', { id: 'race', name: 'Race' });
  await json(base, '/api/profiles/race/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${port}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'X-Profile', value: 'old' }],
  });
  const refreshPromise = fetch(`${base}/subscription/race`);
  await waitForPending(gate);
  assert.equal((await json(base, '/api/profiles/race', 'DELETE')).status, 200);
  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'race', name: 'Race2' })).status, 201);
  gate.release();
  const refreshResponse = await refreshPromise;
  assert.equal(refreshResponse.status, 404);
  assert.match((await refreshResponse.json()).error, /不存在/);

  const state = await (await fetch(`${base}/api/profiles/race/state`)).json();
  assert.equal(state.name, 'Race2');
  assert.equal(state.hasCache, false);
  assert.equal(state.lastError, null);
  assert.equal(state.lastAttemptAt, null);
  assert.equal(state.settings.sourceUrl, '');
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).hasCache, false);
});

test('并发：刷新失败且 profile 已删除时返回 404 而不是 502', async t => {
  const dataDir = await tempDataDir(t);
  const gate = gatedUpstream();
  const port = await listen(gate.server);
  t.after(() => gate.server.close());
  const { base } = await startService(t, dataDir);
  await json(base, '/api/profiles', 'POST', { id: 'lost', name: 'Lost' });
  await json(base, '/api/profiles/lost/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${port}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'User-Agent', value: 'Surge' }],
  });
  const refreshPromise = fetch(`${base}/subscription/lost`);
  await waitForPending(gate);
  assert.equal((await json(base, '/api/profiles/lost', 'DELETE')).status, 200);
  gate.release('fail');
  const response = await refreshPromise;
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /不存在/);
});

test('并发：刷新期间修改设置，过期请求返回 409 且不写入新旧混合配置', async t => {
  const dataDir = await tempDataDir(t);
  const gate = gatedUpstream();
  const port = await listen(gate.server);
  t.after(() => gate.server.close());
  const { base } = await startService(t, dataDir);

  await json(base, '/api/profiles', 'POST', { id: 'rev', name: 'Rev' });
  await json(base, '/api/profiles/rev/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${port}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'X-Profile', value: 'old' }],
  });
  const firstRefresh = refreshRequest(base, 'rev');
  await waitForPending(gate);
  await json(base, '/api/profiles/rev/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${port}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'X-Profile', value: 'new' }],
  });
  gate.release();
  const expired = await firstRefresh;
  assert.equal(expired.status, 409);
  assert.match((await expired.json()).error, /更新/);
  const discarded = await (await fetch(`${base}/api/profiles/rev/state`)).json();
  assert.equal(discarded.hasCache, false, '修改设置后旧刷新结果不应写入缓存');
  assert.equal(discarded.settings.headers[0].value, 'new');

  const secondRefresh = refreshRequest(base, 'rev');
  await waitForPending(gate);
  gate.release();
  assert.equal((await secondRefresh).status, 200);
  const state = await (await fetch(`${base}/api/profiles/rev/state`)).json();
  assert.equal(state.hasCache, true);
  const preview = await (await fetch(`${base}/api/profiles/rev/preview`)).text();
  assert.match(preview, /marker = new/);
  assert.doesNotMatch(preview, /marker = old/);

  // 订阅入口也返回新配置，而不是旧上游 + 新设置的混合输出。
  const subscriptionPromise = fetch(`${base}/subscription/rev`);
  await waitForPending(gate);
  gate.release();
  const subscription = await subscriptionPromise;
  assert.equal(subscription.status, 200);
  assert.equal(subscription.headers.get('x-subscription-stale'), 'false');
  const content = await subscription.text();
  assert.match(content, /marker = new/);
  assert.doesNotMatch(content, /marker = old/);
});

test('并发：刷新期间修改设置且上游失败，返回 409 而不是旧缓存或 502', async t => {
  const dataDir = await tempDataDir(t);
  const gate = gatedUpstream();
  const port = await listen(gate.server);
  t.after(() => gate.server.close());
  const { base } = await startService(t, dataDir);
  await json(base, '/api/profiles', 'POST', { id: 'failrev', name: 'FailRev' });
  await json(base, '/api/profiles/failrev/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${port}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'X-Profile', value: 'old' }],
  });
  // 先成功拉取一次，建立缓存；后续失败请求不能用旧缓存冒充当前配置。
  const warm = fetch(`${base}/subscription/failrev`);
  await waitForPending(gate);
  gate.release();
  assert.equal((await warm).status, 200);

  const failed = fetch(`${base}/subscription/failrev`);
  await waitForPending(gate);
  await json(base, '/api/profiles/failrev/settings', 'PUT', {
    sourceUrl: `http://127.0.0.1:${port}/p`, publicBaseUrl: '', interval: 600, headers: [{ name: 'X-Profile', value: 'new' }],
  });
  gate.release('fail');
  const response = await failed;
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /更新/);
  const state = await (await fetch(`${base}/api/profiles/failrev/state`)).json();
  assert.equal(state.lastError, null, '旧请求的失败不应记为当前配置的 lastError');
  assert.equal(state.settings.headers[0].value, 'new');

  const retry = fetch(`${base}/subscription/failrev`);
  await waitForPending(gate);
  gate.release();
  const retryResponse = await retry;
  assert.equal(retryResponse.status, 200);
  assert.match(await retryResponse.text(), /marker = new/);
});

test('脚本保存响应返回本次写入的对象快照', async t => {
  const dataDir = await tempDataDir(t);
  const { base } = await startService(t, dataDir);
  await json(base, '/api/profiles', 'POST', { id: 'snap', name: 'Snap' });
  const a = await json(base, '/api/profiles/snap/scripts', 'POST', { name: 'A', enabled: true, code: 'module.exports = c => c;' });
  const b = await json(base, '/api/profiles/snap/scripts', 'POST', { name: 'B', enabled: true, code: 'module.exports = c => c;' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  // 并发触发保存与移动：响应必须始终是目标脚本 A 的快照，不能按位置重读成 B。
  const [updated, moved] = await Promise.all([
    json(base, `/api/profiles/snap/scripts/${a.body.id}`, 'PUT', { name: 'A-updated', enabled: true, code: 'module.exports = c => c;' }),
    json(base, `/api/profiles/snap/scripts/${b.body.id}/move`, 'POST', { direction: 'up' }),
  ]);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.id, a.body.id);
  assert.equal(updated.body.name, 'A-updated');
  assert.equal(moved.status, 200);
  const state = await (await fetch(`${base}/api/profiles/snap/state`)).json();
  assert.equal(state.scripts.find(script => script.id === a.body.id).name, 'A-updated');
  assert.equal(state.scripts.find(script => script.id === b.body.id).name, 'B');
});

test('非法 JSON body 类型返回 400 而不是 500', async t => {
  const dataDir = await tempDataDir(t);
  const { base } = await startService(t, dataDir);
  const raw = async (method, endpoint, payload) => {
    const response = await fetch(`${base}${endpoint}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return response.status;
  };
  assert.equal(await raw('POST', '/api/profiles', null), 400);
  assert.equal(await raw('POST', '/api/profiles', []), 400);
  assert.equal(await raw('POST', '/api/profiles', 'x'), 400);
  assert.equal(await raw('POST', '/api/profiles', 3), 400);
  assert.equal(await raw('POST', '/api/profiles', { id: ['a'], name: 'x' }), 400);
  assert.equal(await raw('POST', '/api/profiles', { id: 'okname', name: ['x'] }), 400);
  assert.equal(await raw('POST', '/api/profiles', { id: 'okname', name: 5 }), 400);
  assert.equal(await raw('POST', '/api/profiles', { id: 'okname', name: 'ok', copyFrom: ['default'] }), 400);
  assert.equal(await raw('PUT', '/api/profiles/default', 'x'), 400);
  assert.equal(await raw('PUT', '/api/profiles/default', []), 400);
  assert.equal(await raw('PUT', '/api/profiles/default', { id: ['default'], name: 'x' }), 400);
  assert.equal(await raw('PUT', '/api/settings', null), 400);
  assert.equal(await raw('PUT', '/api/settings', []), 400);
  assert.equal(await raw('PUT', '/api/settings', { sourceUrl: ['http://127.0.0.1/'], publicBaseUrl: '', interval: 600, headers: [] }), 400);
  assert.equal(await raw('PUT', '/api/settings', { sourceUrl: '', publicBaseUrl: {}, interval: 600, headers: [] }), 400);
  assert.equal(await raw('PUT', '/api/settings', { sourceUrl: '', publicBaseUrl: '', interval: 600, headers: [{ name: ['X'], value: 'v' }] }), 400);
  assert.equal(await raw('PUT', '/api/settings', { sourceUrl: '', publicBaseUrl: '', interval: 600, headers: [{ name: 'X', value: ['v'] }] }), 400);
  assert.equal(await raw('POST', '/api/scripts', null), 400);
  assert.equal(await raw('POST', '/api/scripts', []), 400);
  assert.equal(await raw('POST', '/api/scripts', { name: ['S'], code: 'module.exports = c => c;' }), 400);
  assert.equal(await raw('POST', '/api/scripts', { name: 'S', code: ['module.exports = c => c;'] }), 400);
  assert.equal(await raw('POST', '/api/scripts/validate', [1]), 400);

  const created = await json(base, '/api/profiles', 'POST', { id: 'mv', name: 'Mv' });
  assert.equal(created.status, 201);
  const script = await json(base, '/api/profiles/mv/scripts', 'POST', { name: 'S', enabled: true, code: 'module.exports = c => c;' });
  assert.equal(script.status, 201);
  assert.equal(await raw('POST', `/api/profiles/mv/scripts/${script.body.id}/move`, null), 400);
  assert.equal(await raw('POST', `/api/profiles/mv/scripts/${script.body.id}/move`, 'up'), 400);
  assert.equal(await raw('POST', `/api/profiles/mv/scripts/${script.body.id}/move`, { direction: 1 }), 400);

  // 失败的请求不得创建 profile 或写入设置。
  const list = await (await fetch(`${base}/api/profiles`)).json();
  assert.deepEqual(list.profiles.map(profile => profile.id), ['default', 'mv']);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.name, '默认配置');
});

test('页面 profile id pattern 在浏览器 v 正则语义下与服务端规则一致', async () => {
  const html = await fs.readFile(path.resolve('public/index.html'), 'utf8');
  const match = html.match(/id="profile-id-input"[^>]*pattern="([^"]+)"/);
  assert.ok(match, '页面应提供 profile id 的 pattern 校验');
  const browserPattern = new RegExp(`^(?:${match[1]})$`, 'v');
  for (const id of ['a', 'default', 'a'.repeat(16), 'with-dash_and', 'a-b_c', 'test1', 'a1', 'a123456789012345', 'test-1_2']) {
    assert.equal(browserPattern.test(id), true, `应接受 ${id}`);
  }
  for (const id of ['', 'A', '1a', 'a.b', 'a b', 'a'.repeat(17), 'a/b', '中文', 'a\tb']) {
    assert.equal(browserPattern.test(id), false, `应拒绝 ${JSON.stringify(id)}`);
  }
});

test('并发：脚本更新读取请求体期间移动脚本，不覆盖其他脚本', async t => {
  const dataDir = await tempDataDir(t);
  const { base } = await startService(t, dataDir);
  await json(base, '/api/profiles', 'POST', { id: 'move-race', name: 'MoveRace' });
  const a = await json(base, '/api/profiles/move-race/scripts', 'POST', { name: 'A', enabled: true, code: 'module.exports = c => c;' });
  const b = await json(base, '/api/profiles/move-race/scripts', 'POST', { name: 'B', enabled: true, code: 'module.exports = c => c;' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  const delayed = delayedJsonRequest(base, `/api/profiles/move-race/scripts/${a.body.id}`, 'PUT', { name: 'A-updated', enabled: true, code: 'module.exports = c => c;' });
  await sleep(100);
  // 等待期间把 B 移到最前，旧实现会按过期的 index 覆盖 B。
  assert.equal((await json(base, `/api/profiles/move-race/scripts/${b.body.id}/move`, 'POST', { direction: 'up' })).status, 200);
  delayed.finish();
  const updated = await delayed.response;
  assert.equal(updated.status, 200);
  assert.equal(updated.body.id, a.body.id);
  assert.equal(updated.body.name, 'A-updated');

  const state = await (await fetch(`${base}/api/profiles/move-race/state`)).json();
  assert.deepEqual(state.scripts.map(script => script.id), [b.body.id, a.body.id]);
  assert.equal(state.scripts[0].name, 'B');
  assert.equal(state.scripts[1].name, 'A-updated');
});

test('并发：脚本更新读取请求体期间删除脚本，目标丢失返回 404 且不复活', async t => {
  const dataDir = await tempDataDir(t);
  const { base } = await startService(t, dataDir);
  await json(base, '/api/profiles', 'POST', { id: 'delete-race', name: 'DeleteRace' });
  const a = await json(base, '/api/profiles/delete-race/scripts', 'POST', { name: 'A', enabled: true, code: 'module.exports = c => c;' });
  const b = await json(base, '/api/profiles/delete-race/scripts', 'POST', { name: 'B', enabled: true, code: 'module.exports = c => c;' });

  const delayed = delayedJsonRequest(base, `/api/profiles/delete-race/scripts/${a.body.id}`, 'PUT', { name: 'A-ghost', enabled: true, code: 'module.exports = c => c;' });
  await sleep(100);
  assert.equal((await json(base, `/api/profiles/delete-race/scripts/${a.body.id}`, 'DELETE')).status, 200);
  delayed.finish();
  const updated = await delayed.response;
  assert.equal(updated.status, 404);

  const state = await (await fetch(`${base}/api/profiles/delete-race/state`)).json();
  assert.deepEqual(state.scripts.map(script => script.id), [b.body.id]);
  assert.equal(state.scripts[0].name, 'B');
});

test('并发：设置请求体读取期间删除并重建 profile，旧请求 404 且不写入新 profile', async t => {
  const dataDir = await tempDataDir(t);
  const { base } = await startService(t, dataDir);
  await json(base, '/api/profiles', 'POST', { id: 'swap', name: 'Swap' });

  const delayed = delayedJsonRequest(base, '/api/profiles/swap/settings', 'PUT', {
    sourceUrl: 'http://127.0.0.1:1/old', publicBaseUrl: '', interval: 600, headers: [{ name: 'X-Profile', value: 'old' }],
  });
  await sleep(100);
  assert.equal((await json(base, '/api/profiles/swap', 'DELETE')).status, 200);
  assert.equal((await json(base, '/api/profiles', 'POST', { id: 'swap', name: 'Swap2' })).status, 201);
  delayed.finish();
  const result = await delayed.response;
  assert.equal(result.status, 404);

  const state = await (await fetch(`${base}/api/profiles/swap/state`)).json();
  assert.equal(state.name, 'Swap2');
  assert.equal(state.settings.sourceUrl, '');
  assert.equal(state.settings.interval, 86400);
});
