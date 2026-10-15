import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseProfile, renderProfile, runScripts } from './profile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const statePath = path.join(dataDir, 'state.json');
const port = Number(process.env.PORT || 3080);
const stateVersion = 2;
const defaultProfileId = 'default';
const defaultProfileName = '默认配置';
const profileExportFormat = 'surge-subscription-service-profile';
const profileExportVersion = 1;
const profileIdPattern = /^[a-z][a-z0-9_-]{0,15}$/;
const defaults = {
  settings: { sourceUrl: '', publicBaseUrl: '', interval: 86400, headers: [{ name: 'User-Agent', value: 'Surge' }] },
  scripts: [],
  appends: [],
  cache: null,
  lastError: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
};
let state = { version: stateVersion, profiles: Object.create(null) };
let writeQueue = Promise.resolve();
const badInput = async callback => {
  try { return await callback(); }
  catch (error) { error.status = 400; throw error; }
};

function saveState() {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const json = JSON.stringify(state, null, 2);
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, json, { mode: 0o600 });
    await fs.rename(temporary, statePath);
  });
  return writeQueue;
}

// revision / refreshToken 只用于运行时并发控制，不写入 state.json。
function decorateProfile(profile) {
  Object.defineProperty(profile, 'revision', { value: 0, writable: true, enumerable: false });
  Object.defineProperty(profile, 'refreshToken', { value: null, writable: true, enumerable: false });
  return profile;
}

function touchProfile(profile) {
  profile.revision += 1;
  profile.refreshToken = null;
}

function blankProfile(id, name) {
  return decorateProfile({
    id,
    name,
    settings: structuredClone(defaults.settings),
    scripts: [],
    appends: [],
    cache: null,
    lastError: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
  });
}

function normaliseProfile(id, stored) {
  const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const settings = source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings) ? source.settings : {};
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().slice(0, 100)
    : (id === defaultProfileId ? defaultProfileName : id);
  return decorateProfile({
    id,
    name,
    settings: { ...structuredClone(defaults.settings), ...settings },
    scripts: Array.isArray(source.scripts) ? source.scripts : [],
    appends: Array.isArray(source.appends) ? source.appends.map(append => ({
      ...append,
      createIfMissing: append.createIfMissing ?? true,
      overwrite: append.overwrite ?? false,
      name: typeof append.name === 'string' && append.name.trim()
        ? append.name.trim()
        : `${append.section} · ${append.position === 'first' ? '最前' : '最后'}`,
    })) : [],
    cache: typeof source.cache === 'string' ? source.cache : null,
    lastError: source.lastError ?? null,
    lastAttemptAt: source.lastAttemptAt ?? null,
    lastSuccessAt: source.lastSuccessAt ?? null,
  });
}

function copyProfile(source, id, name) {
  const profile = blankProfile(id, name);
  profile.settings = structuredClone(source.settings);
  profile.scripts = source.scripts.map(script => ({ ...structuredClone(script), id: randomUUID() }));
  profile.appends = source.appends.map(append => ({ ...structuredClone(append), id: randomUUID() }));
  return profile;
}

function profileExportDocument(profile) {
  return {
    format: profileExportFormat,
    version: profileExportVersion,
    profile: {
      id: profile.id,
      name: profile.name,
      settings: structuredClone(profile.settings),
      scripts: profile.scripts.map(({ id, ...script }) => structuredClone(script)),
      appends: profile.appends.map(({ id, ...append }) => structuredClone(append)),
    },
  };
}

function validateProfileExport(value) {
  const document = requireObject(value, '导入文件格式无效');
  if (document.format !== profileExportFormat || document.version !== profileExportVersion) {
    throw new Error('导入文件不是受支持的 Profile 备份格式');
  }
  const source = requireObject(document.profile, '导入文件缺少 profile 数据');
  const id = validateProfileId(source.id);
  const name = validateProfileName(source.name);
  const settings = validateSettings(source.settings);
  if (!Array.isArray(source.scripts) || source.scripts.length > 200) throw new Error('导入脚本数量无效');
  if (!Array.isArray(source.appends) || source.appends.length > 200) throw new Error('导入追加项数量无效');
  const scripts = source.scripts.map(script => validateScript(script));
  const appends = source.appends.map(append => validateAppend(append));
  return { id, name, settings, scripts, appends };
}

function importProfile(source, id, name) {
  const profile = blankProfile(id, name);
  profile.settings = structuredClone(source.settings);
  profile.scripts = source.scripts.map(script => ({ id: randomUUID(), ...structuredClone(script) }));
  profile.appends = source.appends.map(append => ({ id: randomUUID(), ...structuredClone(append) }));
  return profile;
}

async function loadState() {
  await fs.mkdir(dataDir, { recursive: true });
  let stored;
  try {
    stored = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const profiles = stored && typeof stored === 'object' && !Array.isArray(stored) && stored.profiles
    && typeof stored.profiles === 'object' && !Array.isArray(stored.profiles) ? stored.profiles : null;
  let migrated = !profiles;
  state = { version: stateVersion, profiles: Object.create(null) };
  if (profiles) {
    for (const [id, value] of Object.entries(profiles)) state.profiles[id] = normaliseProfile(id, value);
  } else {
    // 旧单实例 state.json（或全新部署）：整体迁移为 default profile，保留设置、脚本、缓存与拉取历史。
    state.profiles[defaultProfileId] = normaliseProfile(defaultProfileId, { ...(stored || {}), name: defaultProfileName });
  }
  if (!state.profiles[defaultProfileId]) {
    state.profiles[defaultProfileId] = blankProfile(defaultProfileId, defaultProfileName);
    migrated = true;
  }
  if (migrated) await saveState();
  return state;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function fail(res, status, message) { send(res, status, { error: message }); }

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('请求内容超过 1 MB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求内容不是有效 JSON'); }
}

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('设置格式无效');
  const sourceUrl = value.sourceUrl === undefined ? '' : value.sourceUrl;
  if (typeof sourceUrl !== 'string') throw new Error('上游链接必须是字符串');
  const publicBaseUrl = value.publicBaseUrl === undefined ? '' : value.publicBaseUrl;
  if (typeof publicBaseUrl !== 'string') throw new Error('公开访问地址必须是字符串');
  const trimmedSourceUrl = sourceUrl.trim();
  if (trimmedSourceUrl && !/^https?:$/.test(new URL(trimmedSourceUrl).protocol)) throw new Error('上游链接只支持 HTTP 或 HTTPS');
  const trimmedPublicBaseUrl = publicBaseUrl.trim().replace(/\/$/, '');
  if (trimmedPublicBaseUrl && !/^https?:$/.test(new URL(trimmedPublicBaseUrl).protocol)) throw new Error('公开访问地址只支持 HTTP 或 HTTPS');
  const interval = Number(value.interval);
  if (!Number.isInteger(interval) || interval < 60 || interval > 604800) throw new Error('更新间隔须为 60–604800 秒');
  if (!Array.isArray(value.headers) || value.headers.length > 30) throw new Error('请求头格式无效');
  const headers = value.headers.map(item => {
    const entry = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const name = entry.name;
    const headerValue = entry.value ?? '';
    if (typeof name !== 'string' || typeof headerValue !== 'string') throw new Error('请求头名称和值必须是字符串');
    const trimmedName = name.trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(trimmedName) || /[\r\n]/.test(headerValue)) throw new Error(`无效请求头：${trimmedName}`);
    return { name: trimmedName, value: headerValue };
  });
  return { sourceUrl: trimmedSourceUrl, publicBaseUrl: trimmedPublicBaseUrl, interval, headers };
}

function requireObject(value, message = '请求内容必须是 JSON 对象') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function validateProfileId(value) {
  if (typeof value !== 'string' || !profileIdPattern.test(value)) {
    throw new Error('profile id 必须以小写字母开头，只能包含小写字母、数字、下划线和连字符，长度 1–16 字符');
  }
  return value;
}

function validateProfileName(value) {
  if (typeof value !== 'string') throw new Error('profile 名称必须是字符串');
  const name = value.trim();
  if (!name || name.length > 100) throw new Error('profile 名称须为 1–100 字符');
  return name;
}

function validateScript(value, existing = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('脚本格式无效');
  const rawName = value.name ?? existing.name ?? '';
  const rawCode = value.code ?? existing.code ?? '';
  if (typeof rawName !== 'string' || typeof rawCode !== 'string') throw new Error('脚本名称和内容必须是字符串');
  const name = rawName.trim();
  const code = rawCode;
  if (!name || name.length > 100) throw new Error('脚本名称须为 1–100 字符');
  if (!code || code.length > 100000) throw new Error('脚本内容须为 1–100000 字符');
  validateScriptSyntax(name, code);
  return { ...existing, name, code, enabled: value.enabled === undefined ? (existing.enabled ?? true) : Boolean(value.enabled) };
}

function validateAppend(value, existing = {}) {
  requireObject(value, '追加项格式无效');
  const rawName = value.name === undefined ? (existing.name ?? '') : value.name;
  if (typeof rawName !== 'string') throw new Error('追加项名称必须是字符串');
  const name = rawName.trim();
  if (!name || name.length > 100) throw new Error('追加项名称须为 1–100 字符');
  const rawSection = value.section ?? existing.section ?? '';
  const rawPosition = value.position ?? existing.position ?? 'last';
  const rawContent = value.content ?? existing.content ?? '';
  const createIfMissing = value.createIfMissing === undefined ? (existing.createIfMissing ?? true) : value.createIfMissing;
  const overwrite = value.overwrite === undefined ? (existing.overwrite ?? false) : value.overwrite;
  if (typeof overwrite !== 'boolean') throw new Error('完全覆盖分节选项必须是布尔值');
  if (typeof createIfMissing !== 'boolean') throw new Error('分节不存在时创建选项必须是布尔值');
  if (typeof rawSection !== 'string' || typeof rawContent !== 'string') throw new Error('分节名和追加内容必须是字符串');
  const section = rawSection.trim();
  if (!section || section.length > 100 || /[\]\r\n]/.test(section)) throw new Error('分节名须为 1–100 字符，且不能包含方括号或换行');
  if (!['first', 'last'].includes(rawPosition)) throw new Error('追加位置无效');
  if (rawContent.length > 100000) throw new Error('追加内容不能超过 100000 字符');
  const content = rawContent.replace(/\r\n?/g, '\n').split('\n');
  while (content.length && !content[0].trim()) content.shift();
  while (content.length && !content.at(-1).trim()) content.pop();
  if (!content.length) throw new Error('追加内容不能为空');
  return { ...existing, name, section, position: rawPosition, content: content.join('\n'), createIfMissing, overwrite, enabled: value.enabled === undefined ? (existing.enabled ?? true) : Boolean(value.enabled) };
}

function applyAppends(profile, appends) {
  const firstOffsets = new Map();
  const presentSections = new Set(Object.keys(profile.original));
  for (const append of appends.filter(item => item.enabled)) {
    if (!presentSections.has(append.section) && append.createIfMissing === false) continue;
    presentSections.add(append.section);
    const lines = append.content.split('\n');
    if (append.overwrite) {
      profile.sections[append.section] = lines;
      firstOffsets.delete(append.section);
      continue;
    }
    const target = profile.sections[append.section] || (profile.sections[append.section] = []);
    if (append.position === 'first') {
      const offset = firstOffsets.get(append.section) || 0;
      target.splice(offset, 0, ...lines);
      firstOffsets.set(append.section, offset + lines.length);
    } else {
      target.push(...lines);
    }
  }
}

function validateScriptSyntax(name, code) {
  const filename = 'script.js';
  try {
    new vm.Script(code, { filename });
  } catch (error) {
    const stackLines = String(error.stack || '').split('\n');
    const locationIndex = stackLines.findIndex(line => new RegExp(`^${filename}:\\d+$`).test(line));
    const lineNumber = locationIndex < 0 ? null : Number(stackLines[locationIndex].split(':').at(-1));
    const caretColumn = locationIndex < 0 ? -1 : (stackLines[locationIndex + 2] || '').indexOf('^');
    const location = lineNumber
      ? `（第 ${lineNumber} 行${caretColumn < 0 ? '' : `，第 ${caretColumn + 1} 列`}）`
      : '';
    throw new Error(`脚本「${name}」语法错误${location}：${error.message}`);
  }
}

function requireProfile(id) {
  const profile = state.profiles[id];
  if (!profile) throw profileGoneError();
  return profile;
}

function profileGoneError() {
  const error = new Error('profile 不存在');
  error.status = 404;
  return error;
}

function profileChangedError() {
  const error = new Error('profile 配置已更新，请重试');
  error.status = 409;
  return error;
}

// 请求体读取/持久化是异步的；每个异步边界后都要重新确认 profile 身份与版本。
function assertProfileCurrent(profile) {
  if (state.profiles[profile.id] !== profile) throw profileGoneError();
}

function assertProfileVersion(profile, revision) {
  assertProfileCurrent(profile);
  if (profile.revision !== revision) throw profileChangedError();
}

function subscriptionUrl(req, profile, subscriptionPath = `/subscription/${profile.id}`) {
  if (profile.settings.publicBaseUrl) return `${profile.settings.publicBaseUrl}${subscriptionPath}`;
  const host = req.headers.host;
  if (!host || !/^[A-Za-z0-9.:[\]-]+(?::\d+)?$/.test(host)) throw new Error('无效 Host；请在设置中填写访问地址');
  return `http://${host}${subscriptionPath}`;
}

// 缓存中保存的是生成时的 MANAGED-CONFIG 地址；返回前按当前请求地址改写，保证旧缓存也指向正确路径。
function rewriteManagedConfig(content, url, interval) {
  const line = `#!MANAGED-CONFIG ${url} interval=${interval}`;
  if (/^#!MANAGED-CONFIG[^\r\n]*/.test(content)) return content.replace(/^#!MANAGED-CONFIG[^\r\n]*/, line);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return `${line}${newline}${content}`;
}

function profileSummary(profile) {
  return {
    id: profile.id,
    name: profile.name,
    hasCache: Boolean(profile.cache),
    lastError: profile.lastError,
    lastAttemptAt: profile.lastAttemptAt,
    lastSuccessAt: profile.lastSuccessAt,
  };
}

function profileState(req, profile) {
  return {
    id: profile.id,
    name: profile.name,
    settings: profile.settings,
    scripts: profile.scripts,
    appends: profile.appends,
    lastError: profile.lastError,
    lastAttemptAt: profile.lastAttemptAt,
    lastSuccessAt: profile.lastSuccessAt,
    hasCache: Boolean(profile.cache),
    subscriptionUrl: subscriptionUrl(req, profile),
  };
}

async function fetchUpstream(profile) {
  const url = profile.settings.sourceUrl;
  if (!url) throw new Error('请先填写上游订阅链接');
  const headers = new Headers();
  for (const { name, value } of profile.settings.headers) headers.set(name, value);
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (length > 15 * 1024 * 1024) throw new Error('上游配置超过 15 MB');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 15 * 1024 * 1024) { await reader.cancel(); throw new Error('上游配置超过 15 MB'); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function refresh(req, profile) {
  const revision = profile.revision;
  const token = {};
  profile.refreshToken = token;
  profile.lastAttemptAt = new Date().toISOString();
  // 快照本次拉取使用的设置、脚本与追加项，保证同一次生成不会混入拉取期间的新旧配置。
  const snapshot = {
    id: profile.id,
    settings: {
      sourceUrl: profile.settings.sourceUrl,
      publicBaseUrl: profile.settings.publicBaseUrl,
      interval: profile.settings.interval,
      headers: structuredClone(profile.settings.headers),
    },
    scripts: structuredClone(profile.scripts),
    appends: structuredClone(profile.appends),
  };
  try {
    const source = await fetchUpstream(snapshot);
    assertProfileVersion(profile, revision);
    const parsed = parseProfile(source);
    applyAppends(parsed, snapshot.appends);
    const config = runScripts(parsed, snapshot.scripts);
    const content = renderProfile(parsed, config, subscriptionUrl(req, snapshot), snapshot.settings.interval);
    if (profile.refreshToken === token) {
      profile.cache = content;
      profile.lastSuccessAt = new Date().toISOString();
      profile.lastError = null;
    }
    await saveState();
    // id 或 revision 在 await 期间可能变化，返回成功前再确认一次。
    assertProfileVersion(profile, revision);
    return { content, stale: false };
  } catch (error) {
    // 删除/重建返回 404；配置在拉取期间更新返回 409，不把旧请求的结果当成当前配置。
    assertProfileVersion(profile, revision);
    if (profile.refreshToken === token) {
      profile.lastError = error.message;
      await saveState();
      assertProfileVersion(profile, revision);
    }
    if (profile.cache) return { content: profile.cache, stale: true };
    error.status = 502;
    throw error;
  }
}

async function serveSubscription(req, res, profile, legacy) {
  const revision = profile.revision;
  const { content, stale } = await refresh(req, profile);
  // refresh 返回后再确认一次：期间（含微任务边界）若发生删除/修改，不能用新设置改写旧快照的托管头。
  assertProfileVersion(profile, revision);
  const subscriptionPath = legacy ? '/subscription' : `/subscription/${profile.id}`;
  res.setHeader('X-Subscription-Stale', stale ? 'true' : 'false');
  return send(res, 200, rewriteManagedConfig(content, subscriptionUrl(req, profile, subscriptionPath), profile.settings.interval), 'text/plain; charset=utf-8');
}

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/script-guide.html': ['script-guide.html', 'text/html; charset=utf-8'],
};

async function handleProfileApi(req, res, profile, rest) {
  if (req.method === 'GET' && rest === '/export') {
    return send(res, 200, profileExportDocument(profile));
  }
  if (req.method === 'GET' && rest === '/state') {
    return send(res, 200, profileState(req, profile));
  }
  if (req.method === 'PUT' && rest === '/settings') {
    const body = await badInput(async () => readJson(req));
    assertProfileCurrent(profile);
    profile.settings = await badInput(async () => validateSettings(body));
    touchProfile(profile);
    await saveState();
    assertProfileCurrent(profile);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && rest === '/preview') {
    if (!profile.cache) return fail(res, 404, '尚无成功生成的配置');
    return send(res, 200, rewriteManagedConfig(profile.cache, subscriptionUrl(req, profile), profile.settings.interval), 'text/plain; charset=utf-8');
  }
  if (req.method === 'POST' && rest === '/refresh') {
    const revision = profile.revision;
    const result = await refresh(req, profile);
    assertProfileVersion(profile, revision);
    return send(res, 200, { stale: result.stale, lastError: profile.lastError, lastSuccessAt: profile.lastSuccessAt });
  }
  if (req.method === 'POST' && rest === '/scripts/validate') {
    const body = await badInput(async () => readJson(req));
    assertProfileCurrent(profile);
    await badInput(async () => validateScript(body));
    return send(res, 200, { valid: true });
  }
  if (req.method === 'POST' && rest === '/scripts') {
    const body = await badInput(async () => readJson(req));
    assertProfileCurrent(profile);
    const script = { id: randomUUID(), ...await badInput(async () => validateScript(body)) };
    profile.scripts.push(script);
    touchProfile(profile);
    await saveState();
    assertProfileCurrent(profile);
    return send(res, 201, script);
  }
  if (req.method === 'POST' && rest === '/appends') {
    const body = await badInput(async () => readJson(req));
    assertProfileCurrent(profile);
    const append = { id: randomUUID(), ...await badInput(async () => validateAppend(body)) };
    profile.appends.push(append);
    touchProfile(profile);
    await saveState();
    assertProfileCurrent(profile);
    return send(res, 201, append);
  }
  const appendMatch = rest.match(/^\/appends\/([0-9a-f-]+)(?:\/(move))?$/);
  if (appendMatch) {
    const appendId = appendMatch[1];
    if (req.method === 'DELETE' && !appendMatch[2]) {
      const index = profile.appends.findIndex(append => append.id === appendId);
      if (index < 0) return fail(res, 404, '追加项不存在');
      profile.appends.splice(index, 1);
      touchProfile(profile);
      await saveState();
      assertProfileCurrent(profile);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && !appendMatch[2]) {
      const body = await badInput(async () => readJson(req));
      assertProfileCurrent(profile);
      const index = profile.appends.findIndex(append => append.id === appendId);
      if (index < 0) return fail(res, 404, '追加项不存在');
      const updated = { id: appendId, ...await badInput(async () => validateAppend(body, profile.appends[index])) };
      profile.appends[index] = updated;
      touchProfile(profile);
      await saveState();
      assertProfileCurrent(profile);
      return send(res, 200, updated);
    }
    if (req.method === 'POST' && appendMatch[2]) {
      const body = await badInput(async () => requireObject(await readJson(req)));
      assertProfileCurrent(profile);
      const { direction } = body;
      if (direction !== 'up' && direction !== 'down') return fail(res, 400, '移动方向无效');
      const index = profile.appends.findIndex(append => append.id === appendId);
      if (index < 0) return fail(res, 404, '追加项不存在');
      const other = index + (direction === 'up' ? -1 : 1);
      if (other >= 0 && other < profile.appends.length) {
        [profile.appends[index], profile.appends[other]] = [profile.appends[other], profile.appends[index]];
        touchProfile(profile);
        await saveState();
        assertProfileCurrent(profile);
      }
      return send(res, 200, { ok: true });
    }
  }
  const scriptMatch = rest.match(/^\/scripts\/([0-9a-f-]+)(?:\/(move))?$/);
  if (scriptMatch) {
    const scriptId = scriptMatch[1];
    if (req.method === 'DELETE' && !scriptMatch[2]) {
      const index = profile.scripts.findIndex(script => script.id === scriptId);
      if (index < 0) return fail(res, 404, '脚本不存在');
      profile.scripts.splice(index, 1);
      touchProfile(profile);
      await saveState();
      assertProfileCurrent(profile);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && !scriptMatch[2]) {
      // 先读完请求体，再按目标脚本 id 重新定位，避免旧 index 覆盖移动/删除后的其他脚本。
      const body = await badInput(async () => readJson(req));
      assertProfileCurrent(profile);
      const index = profile.scripts.findIndex(script => script.id === scriptId);
      if (index < 0) return fail(res, 404, '脚本不存在');
      const updated = await badInput(async () => validateScript(body, profile.scripts[index]));
      profile.scripts[index] = updated;
      touchProfile(profile);
      await saveState();
      assertProfileCurrent(profile);
      // 返回本次实际写入的对象快照，不按位置重读（saveState 期间可能发生 move/delete）。
      return send(res, 200, updated);
    }
    if (req.method === 'POST' && scriptMatch[2]) {
      const body = await badInput(async () => requireObject(await readJson(req)));
      assertProfileCurrent(profile);
      const { direction } = body;
      if (direction !== 'up' && direction !== 'down') return fail(res, 400, '移动方向无效');
      const index = profile.scripts.findIndex(script => script.id === scriptId);
      if (index < 0) return fail(res, 404, '脚本不存在');
      const other = index + (direction === 'up' ? -1 : 1);
      if (other >= 0 && other < profile.scripts.length) {
        [profile.scripts[index], profile.scripts[other]] = [profile.scripts[other], profile.scripts[index]];
        touchProfile(profile);
        await saveState();
        assertProfileCurrent(profile);
      }
      return send(res, 200, { ok: true });
    }
  }
  return fail(res, 404, '路径不存在');
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return fail(res, 403, '跨站请求被拒绝');
    if (req.method !== 'DELETE' && !req.headers['content-type']?.startsWith('application/json')) return fail(res, 415, '请使用 JSON 请求');
  }
  if (req.method === 'GET' && staticFiles[url.pathname]) {
    const [name, type] = staticFiles[url.pathname];
    return send(res, 200, await fs.readFile(path.join(root, 'public', name), 'utf8'), type);
  }
  const subscriptionMatch = url.pathname.match(/^\/subscription\/([^/]+)$/);
  if (req.method === 'GET' && (url.pathname === '/subscription' || subscriptionMatch)) {
    let profile;
    try {
      profile = requireProfile(subscriptionMatch ? decodeURIComponent(subscriptionMatch[1]) : defaultProfileId);
    } catch {
      return fail(res, 404, 'profile 不存在');
    }
    return serveSubscription(req, res, profile, !subscriptionMatch);
  }
  if (url.pathname === '/api/profiles') {
    if (req.method === 'GET') return send(res, 200, { profiles: Object.values(state.profiles).map(profileSummary) });
    if (req.method === 'POST') {
      const body = await badInput(async () => requireObject(await readJson(req)));
      const id = await badInput(async () => validateProfileId(body.id));
      const name = await badInput(async () => validateProfileName(body.name));
      if (state.profiles[id]) return fail(res, 409, `profile id「${id}」已存在`);
      let source = null;
      if (body.copyFrom !== undefined && body.copyFrom !== null && body.copyFrom !== '') {
        if (typeof body.copyFrom !== 'string') return fail(res, 400, 'copyFrom 必须是 profile id 字符串');
        source = requireProfile(body.copyFrom);
      }
      const profile = source ? copyProfile(source, id, name) : blankProfile(id, name);
      state.profiles[id] = profile;
      await saveState();
      return send(res, 201, { id: profile.id, name: profile.name });
    }
    return fail(res, 405, '请求方法不支持');
  }
  if (url.pathname === '/api/profiles/import') {
    if (req.method !== 'POST') return fail(res, 405, '请求方法不支持');
    const body = await badInput(async () => requireObject(await readJson(req)));
    const imported = await badInput(async () => validateProfileExport(body.document));
    const id = await badInput(async () => validateProfileId(body.id === undefined ? imported.id : body.id));
    const name = await badInput(async () => validateProfileName(body.name === undefined ? imported.name : body.name));
    if (state.profiles[id]) return fail(res, 409, `profile id「${id}」已存在`);
    const profile = importProfile(imported, id, name);
    state.profiles[id] = profile;
    await saveState();
    return send(res, 201, { id: profile.id, name: profile.name });
  }
  const profileRoute = url.pathname.match(/^\/api\/profiles\/([^/]+)(\/.*)?$/);
  if (profileRoute) {
    let id;
    try { id = decodeURIComponent(profileRoute[1]); }
    catch { return fail(res, 404, 'profile 不存在'); }
    const profile = state.profiles[id];
    if (!profile) return fail(res, 404, 'profile 不存在');
    const rest = profileRoute[2] || '';
    if (rest === '' || rest === '/') {
      if (req.method === 'PUT') {
        const body = await badInput(async () => requireObject(await readJson(req)));
        assertProfileCurrent(profile);
        if (Object.hasOwn(body, 'id') && body.id !== profile.id) {
          return fail(res, 400, 'profile id 创建后不可修改');
        }
        const name = await badInput(async () => validateProfileName(body.name));
        profile.name = name;
        await saveState();
        assertProfileCurrent(profile);
        return send(res, 200, { id: profile.id, name });
      }
      if (req.method === 'DELETE') {
        if (profile.id === defaultProfileId) return fail(res, 400, '默认 profile 不能删除');
        delete state.profiles[profile.id];
        await saveState();
        return send(res, 200, { ok: true });
      }
    }
    return handleProfileApi(req, res, profile, rest);
  }
  // 旧单实例 API 作为 default profile 的兼容入口，不维护服务器全局当前 profile。
  const legacyRoute = url.pathname.match(/^\/api\/(state|settings|preview|refresh|scripts(?:\/.*)?)$/);
  if (legacyRoute) {
    const profile = state.profiles[defaultProfileId];
    if (!profile) return fail(res, 500, '默认 profile 缺失');
    return handleProfileApi(req, res, profile, `/${legacyRoute[1]}`);
  }
  fail(res, 404, '路径不存在');
}

await loadState();
http.createServer((req, res) => {
  handle(req, res).catch(error => {
    if (!res.headersSent) fail(res, error.status || 500, error.message);
  });
}).listen(port, '0.0.0.0', () => console.log(`Surge subscription service listening on ${port}; visit http://127.0.0.1:${port}`));
