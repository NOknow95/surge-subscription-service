const $ = selector => document.querySelector(selector);
let profiles = [];
let currentProfileId = null;
let current = null;
let viewReady = false;
let viewGeneration = 0;
let profilesSeq = 0;
let loadSeq = 0;
let editingId = null;
let editingAppendId = null;
let editorSession = 0;
let validateSeq = 0;
let validateBusy = false;
let previewSeq = 0;
let previewBusy = false;
let profileDialogMode = null;
let profileSubmitPending = false;
let pendingImportDocument = null;
const refreshInFlight = new Set();
let noticeTimer = null;
let lastNotice = null;
let repeatedNoticeCount = 0;
let timestampTimer = null;
let previewText = '';
const selectedProfileStorageKey = 'surge-subscription-service:selected-profile';
const example = `module.exports = (config) => {
  config.rules = [
    'DOMAIN,registry.hub.docker.com,节点选择',
    'DOMAIN-SUFFIX,docker.io,节点选择',
    ...(config.rules || []),
  ];
  return config;
};`;

function readSelectedProfileId() {
  try { return localStorage.getItem(selectedProfileStorageKey); }
  catch { return null; }
}

function saveSelectedProfileId(id) {
  try { localStorage.setItem(selectedProfileStorageKey, id); }
  catch { /* 浏览器禁用本地存储时仍可正常使用页面。 */ }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    try { return document.execCommand('copy'); }
    catch { return false; }
    finally { textarea.remove(); }
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const type = response.headers.get('content-type') || '';
  const result = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(result.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function dismissNotice() {
  const element = $('#notice');
  clearTimeout(noticeTimer);
  noticeTimer = null;
  lastNotice = null;
  repeatedNoticeCount = 0;
  element.hidden = true;
  element.classList.remove('toast-pulse');
  element.replaceChildren();
}

function notice(message, error = false, action = null) {
  const element = $('#notice');
  const repeated = !element.hidden && lastNotice?.message === message && lastNotice.error === error;
  repeatedNoticeCount = repeated ? repeatedNoticeCount + 1 : 1;
  lastNotice = { message, error };
  clearTimeout(noticeTimer);
  element.replaceChildren();
  element.hidden = false;
  element.classList.toggle('error', error);
  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;
  if (repeated) {
    const repeat = document.createElement('span');
    repeat.className = 'toast-repeat';
    repeat.textContent = `第 ${repeatedNoticeCount} 次提示`;
    text.append(repeat);
  }
  element.append(text);

  const controls = document.createElement('div');
  controls.className = 'toast-controls';
  if (action) {
    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'toast-action';
    actionButton.textContent = action.label;
    actionButton.addEventListener('click', () => {
      dismissNotice();
      action.run();
    });
    controls.append(actionButton);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', dismissNotice);
  controls.append(close);
  element.append(controls);
  element.classList.remove('toast-pulse');
  void element.offsetWidth;
  element.classList.add('toast-pulse');
  noticeTimer = setTimeout(dismissNotice, 10000);
}

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function formatTime(value, now = Date.now()) {
  if (!value) return '暂无';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '时间无效';
  const ageMilliseconds = Math.max(0, now - timestamp);
  if (ageMilliseconds < 60_000) return `${Math.floor(ageMilliseconds / 1000)} 秒前`;
  if (ageMilliseconds <= 10 * 60_000) return `${Math.floor(ageMilliseconds / 60_000)} 分钟前`;
  return dateTimeFormatter.format(timestamp);
}

function renderTimestamps() {
  if (!current) return;
  const now = Date.now();
  $('#timestamps').textContent = `最近尝试：${formatTime(current.lastAttemptAt, now)} · 最近成功：${formatTime(current.lastSuccessAt, now)}`;

  const hasRelativeTime = [current.lastAttemptAt, current.lastSuccessAt].some(value => {
    if (!value) return false;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) && now - timestamp <= 10 * 60_000;
  });
  if (refreshInFlight.has(currentProfileId) || hasRelativeTime) {
    if (!timestampTimer) timestampTimer = setInterval(renderTimestamps, 3000);
  } else if (timestampTimer) {
    clearInterval(timestampTimer);
    timestampTimer = null;
  }
}

function addHeader(name = '', value = '') {
  const row = document.createElement('div');
  row.className = 'header-row';
  const nameInput = document.createElement('input');
  nameInput.placeholder = 'Header 名称';
  nameInput.value = name;
  const valueInput = document.createElement('input');
  valueInput.placeholder = 'Header 值';
  valueInput.value = value;
  const remove = document.createElement('button');
  remove.type = 'button'; remove.textContent = '删除';
  remove.addEventListener('click', () => row.remove());
  row.append(nameInput, valueInput, remove);
  $('#headers').append(row);
}

function scriptButton(label, action, disabled = false, className = '') {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = label; button.disabled = disabled; button.className = className;
  button.addEventListener('click', action);
  return button;
}

// 视图代次：切换 profile、删除重建后旧响应不得再写入当前界面；未加载完成时表单不可用。
function captureView() { return { profileId: currentProfileId, generation: viewGeneration }; }
function isViewCurrent(view) { return view.generation === viewGeneration && view.profileId === currentProfileId; }
function isViewLoaded(view) { return isViewCurrent(view) && viewReady && current !== null && current.id === view.profileId; }

const profileControlsSelector = [
  '#settings-form input', '#settings-form button', '#add-header', '#refresh',
  '#copy-link', '#install-to-surge', '#preview', '#refresh-preview', '#copy-preview',
  '#new-script', '#script-form input', '#script-form button', '#script-form textarea',
  '#new-append', '#append-form input', '#append-form select', '#append-form button', '#append-form textarea',
  '#new-profile', '#copy-profile', '#import-profile', '#export-profile', '#rename-profile',
].join(', ');

function syncProfileActionState() {
  $('#delete-profile').disabled = !viewReady || !isViewLoaded(captureView()) || currentProfileId === 'default';
}

function setProfileReady(ready) {
  viewReady = ready;
  document.querySelectorAll(profileControlsSelector).forEach(element => { element.disabled = !ready; });
  if (ready) {
    // 加载态解除不能抹掉业务禁用状态：刷新/预览/校验按钮重新应用自己的忙碌态；
    // 脚本列表按钮的状态由 render() 重建列表时决定。
    setRefreshState(refreshInFlight.has(currentProfileId));
    setPreviewRefreshState(previewBusy);
    setValidateState(validateBusy);
  } else {
    setRefreshState(false);
  }
  syncProfileActionState();
}

function renderProfileOptions() {
  const selectedProfile = profiles.find(profile => profile.id === currentProfileId) || profiles[0];
  $('#profile-select-value').textContent = selectedProfile ? `${selectedProfile.name}（${selectedProfile.id}）` : '正在加载…';
  $('#profile-select').disabled = profiles.length === 0;
  $('#profile-options').replaceChildren(...profiles.map(profile => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'profile-option';
    option.setAttribute('role', 'menuitemradio');
    option.setAttribute('aria-checked', String(profile.id === selectedProfile?.id));
    option.dataset.profileId = profile.id;
    option.tabIndex = -1;
    option.textContent = `${profile.name}（${profile.id}）`;
    return option;
  }));
  syncProfileActionState();
}

function profileMenuItems() {
  return [...$('#profile-options').querySelectorAll('[role="menuitemradio"]')];
}

function closeProfileMenu(returnFocus = false) {
  const menu = $('#profile-options');
  menu.hidden = true;
  $('#profile-select').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('#profile-select').focus();
}

function openProfileMenu() {
  const items = profileMenuItems();
  if (!items.length) return;
  $('#profile-options').hidden = false;
  $('#profile-select').setAttribute('aria-expanded', 'true');
  (items.find(item => item.getAttribute('aria-checked') === 'true') || items[0]).focus();
}

async function loadProfiles() {
  const seq = ++profilesSeq;
  const result = await api('/api/profiles');
  if (seq !== profilesSeq) return;
  profiles = result.profiles;
  renderProfileOptions();
}

function settingsFromForm() {
  const headers = [...document.querySelectorAll('.header-row')].map(row => ({ name: row.children[0].value, value: row.children[1].value }));
  return { sourceUrl: $('#source-url').value, publicBaseUrl: $('#public-base-url').value, interval: Number($('#interval').value), headers };
}

function settingsFormDirty() {
  if (!viewReady || !current) return false;
  const settings = settingsFromForm();
  return settings.sourceUrl !== current.settings.sourceUrl
    || settings.publicBaseUrl !== current.settings.publicBaseUrl
    || settings.interval !== current.settings.interval
    || JSON.stringify(settings.headers) !== JSON.stringify(current.settings.headers);
}

function hasUnsavedChanges() {
  if (!viewReady || !current) return false;
  if (!$('#script-form').hidden) {
    if (!editingId) return true;
    const saved = current.scripts.find(script => script.id === editingId);
    if (!saved || $('#script-name').value !== saved.name || $('#script-enabled').checked !== saved.enabled || $('#script-code').value !== saved.code) return true;
  }
  if (!$('#append-form').hidden) {
    if (!editingAppendId) return true;
    const saved = current.appends.find(append => append.id === editingAppendId);
    if (!saved || $('#append-name').value !== saved.name || $('#append-section').value !== saved.section || $('#append-position').value !== saved.position || $('#append-enabled').checked !== saved.enabled || $('#append-create-if-missing').checked !== saved.createIfMissing || $('#append-overwrite').checked !== saved.overwrite || $('#append-content').value !== saved.content) return true;
  }
  return settingsFormDirty();
}

function closeScriptForm() {
  editingId = null;
  editorSession += 1;
  resetValidateState();
  $('#script-form').hidden = true;
  $('#script-find').hidden = true;
}

function closeAppendForm() {
  closeAppendPositionMenu();
  editingAppendId = null;
  $('#append-form').hidden = true;
  $('#append-find').hidden = true;
}

function resetPreview() {
  previewSeq += 1;
  previewBusy = false;
  setPreviewRefreshState(false);
  setPreviewContent('');
  $('#preview-content').hidden = true;
  $('#refresh-preview').hidden = true;
  $('#copy-preview').hidden = true;
  const button = $('#preview');
  button.textContent = '查看上次成功配置';
  button.setAttribute('aria-expanded', 'false');
}

function showProfileLoading() {
  current = null;
  viewReady = false;
  closeScriptForm();
  closeAppendForm();
  resetPreview();
  $('#source-url').value = '';
  $('#public-base-url').value = '';
  $('#interval').value = '';
  $('#headers').replaceChildren();
  $('#subscription-link').value = '';
  $('#status').textContent = '正在加载…';
  $('#status').classList.remove('error');
  $('#timestamps').textContent = '';
  $('#script-list').replaceChildren();
  setProfileReady(false);
  renderProfileOptions();
}

function setRefreshState(busy) {
  const button = $('#refresh');
  button.disabled = busy || !viewReady;
  if (busy) {
    button.setAttribute('aria-busy', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'button-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = '拉取转换中…';
    button.replaceChildren(spinner, label);
  } else {
    button.removeAttribute('aria-busy');
    button.textContent = '立即拉取并转换';
  }
  renderTimestamps();
}

function setPreviewRefreshState(busy) {
  previewBusy = busy;
  const button = $('#refresh-preview');
  button.disabled = busy || !viewReady;
  if (busy) {
    button.setAttribute('aria-busy', 'true');
    const spinner = document.createElement('span');
    spinner.className = 'button-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = '刷新中…';
    button.replaceChildren(spinner, label);
  } else {
    button.removeAttribute('aria-busy');
    button.textContent = '刷新配置';
  }
}

function setValidateState(busy) {
  validateBusy = busy;
  $('#validate-script').disabled = busy || !viewReady;
  $('#validate-script-top').disabled = busy || !viewReady;
}

function resetValidateState() {
  validateSeq += 1;
  setValidateState(false);
}

async function switchProfile(id) {
  if (!id || id === currentProfileId) { renderProfileOptions(); return; }
  if (hasUnsavedChanges() && !confirm('当前 profile 有未保存的设置或脚本修改，切换后将丢失。确认切换？')) {
    renderProfileOptions();
    return;
  }
  viewGeneration += 1;
  currentProfileId = id;
  saveSelectedProfileId(id);
  showProfileLoading();
  const view = captureView();
  try {
    await reload();
  } catch (error) {
    if (isViewCurrent(view)) notice(`profile「${id}」加载失败：${error.message}`, true);
  }
}

function requestProfileDialog(mode) {
  if (!isViewLoaded(captureView())) return;
  if (hasUnsavedChanges() && !confirm('当前 profile 有未保存的设置或脚本修改，新建或复制后会切换到新 profile，未保存的修改将丢失。继续？')) return;
  openProfileDialog(mode);
}

function openProfileDialog(mode) {
  profileDialogMode = mode;
  const idInput = $('#profile-id-input');
  const nameInput = $('#profile-name-input');
  idInput.disabled = mode === 'rename';
  if (mode === 'rename') {
    $('#profile-dialog-title').textContent = '重命名 Profile';
    $('#profile-dialog-hint').textContent = `Profile ID 为 ${currentProfileId}，创建后不可修改；重命名不会影响订阅链接，也不会重置当前未保存的编辑。`;
    idInput.value = currentProfileId;
    nameInput.value = current.name;
  } else if (mode === 'copy') {
    $('#profile-dialog-title').textContent = '复制 Profile';
    $('#profile-dialog-hint').textContent = `复制「${current.name}」当前已保存的设置和全部脚本（脚本为独立副本），不复制缓存与拉取历史。`;
    idInput.value = '';
    nameInput.value = `${current.name} 副本`.slice(0, 100);
  } else if (mode === 'import') {
    const imported = pendingImportDocument?.profile;
    $('#profile-dialog-title').textContent = '导入 Profile';
    $('#profile-dialog-hint').textContent = `导入「${imported?.name || '未命名'}」的设置、脚本和文本追加项；不会导入缓存与拉取历史。导入文件包含上游链接和请求头，请妥善保管。`;
    idInput.value = imported?.id || '';
    nameInput.value = imported?.name || '';
  } else {
    $('#profile-dialog-title').textContent = '新建 Profile';
    $('#profile-dialog-hint').textContent = '新建空白配置，使用默认请求头和更新间隔。';
    idInput.value = '';
    nameInput.value = '';
  }
  $('#profile-dialog').showModal();
  (mode === 'rename' ? nameInput : idInput).focus();
}

function validateImportDocumentShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.format !== 'surge-subscription-service-profile' || value.version !== 1
    || !value.profile || typeof value.profile !== 'object' || Array.isArray(value.profile)) {
    throw new Error('导入文件不是受支持的 Profile 备份格式');
  }
  if (typeof value.profile.id !== 'string' || typeof value.profile.name !== 'string') {
    throw new Error('导入文件缺少 Profile ID 或名称');
  }
  return value;
}

function chooseImportFile() {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  if (hasUnsavedChanges() && !confirm('当前 profile 有未保存的修改，导入后切换到新 profile 时会丢失。继续？')) return;
  const input = $('#profile-import-file');
  input.value = '';
  input.click();
}

async function readImportFile(file) {
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('导入文件不能超过 1 MB');
    const payload = validateImportDocumentShape(JSON.parse(await file.text()));
    pendingImportDocument = payload;
    openProfileDialog('import');
  } catch (error) {
    pendingImportDocument = null;
    notice(error.message, true);
  } finally {
    $('#profile-import-file').value = '';
  }
}

async function exportCurrentProfile() {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  if (!confirm(`导出 profile「${current.name}」？文件包含上游链接和请求头等敏感设置，仅包含已保存内容。`)) return;
  try {
    const payload = await api(`/api/profiles/${encodeURIComponent(view.profileId)}/export`);
    if (!isViewCurrent(view)) return;
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `profile-${view.profileId}-${date}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    notice(`已导出 profile「${current.name}」`);
  } catch (error) {
    notice(error.message, true);
  }
}

function installToSurge() {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  const url = `surge:///install-config?url=${encodeURIComponent(current.subscriptionUrl)}`;
  window.location.assign(url);
}

async function deleteCurrentProfile() {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  if (view.profileId === 'default') { notice('默认 profile 不能删除', true); return; }
  const unsaved = hasUnsavedChanges();
  const message = `删除 profile「${current.name}」？其订阅链接 /subscription/${view.profileId} 将失效，脚本、缓存和拉取历史都会被删除，且无法恢复。${unsaved ? '\n当前有未保存的修改，也会一并丢失。' : ''}`;
  if (!confirm(message)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(view.profileId)}`, { method: 'DELETE' });
    if (isViewCurrent(view)) {
      viewGeneration += 1;
      currentProfileId = 'default';
      saveSelectedProfileId(currentProfileId);
      showProfileLoading();
      await loadProfiles();
      await reload();
      notice(`已删除 profile「${view.profileId}」`);
    } else {
      await loadProfiles();
      notice(`已删除 profile「${view.profileId}」`);
    }
  } catch (error) {
    notice(error.message, true);
  }
}

function render({ keepForm = false } = {}) {
  renderProfileOptions();
  if (!keepForm) {
    $('#source-url').value = current.settings.sourceUrl;
    $('#public-base-url').value = current.settings.publicBaseUrl;
    $('#public-base-url').placeholder = window.location.origin;
    $('#interval').value = current.settings.interval;
    $('#headers').replaceChildren();
    current.settings.headers.forEach(({ name, value }) => addHeader(name, value));
  }
  $('#subscription-link').value = current.subscriptionUrl;
  const hasSourceUrl = Boolean(current.settings.sourceUrl);
  $('#status').textContent = !hasSourceUrl ? '未配置上游' : current.lastError ? (current.hasCache ? '上游异常 · 使用缓存' : '上次拉取失败') : (current.lastSuccessAt ? '运行正常' : '等待首次拉取');
  $('#status').classList.toggle('error', hasSourceUrl && Boolean(current.lastError));
  renderTimestamps();
  const list = $('#script-list');
  list.replaceChildren();
  if (!current.scripts.length) {
    const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = '尚无脚本。上游配置会原样保留，并加入托管配置链接。'; list.append(empty);
  }
  current.scripts.forEach((script, index) => {
    const row = document.createElement('div'); row.className = 'script-row';
    const description = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = script.name;
    const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = `${index + 1} · ${script.enabled ? '已启用' : '已禁用'}`;
    description.append(name, meta);
    const actions = document.createElement('div'); actions.className = 'script-actions';
    actions.append(
      scriptButton('↑', () => moveScript(script.id, 'up'), index === 0),
      scriptButton('↓', () => moveScript(script.id, 'down'), index === current.scripts.length - 1),
      scriptButton(script.enabled ? '禁用' : '启用', () => updateScript(script.id, { enabled: !script.enabled })),
      scriptButton('编辑', () => openEditor(script)),
      scriptButton('删除', () => deleteScript(script), false, 'delete'),
    );
    row.append(description, actions); list.append(row);
  });
  const appendList = $('#append-list');
  appendList.replaceChildren();
  if (!current.appends.length) {
    const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = '尚无文本追加项。'; appendList.append(empty);
  }
  current.appends.forEach((append, index) => {
    const row = document.createElement('div'); row.className = 'script-row';
    const description = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = append.name;
    const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = `${index + 1} · [${append.section}] · ${append.overwrite ? '完全覆盖' : append.position === 'first' ? '最前' : '最后'} · ${append.enabled ? '已启用' : '已禁用'} · ${append.content.split('\n').length} 行`;
    description.append(name, meta);
    const actions = document.createElement('div'); actions.className = 'script-actions';
    actions.append(
      scriptButton('↑', () => moveAppend(append.id, 'up'), index === 0),
      scriptButton('↓', () => moveAppend(append.id, 'down'), index === current.appends.length - 1),
      scriptButton(append.enabled ? '禁用' : '启用', () => updateAppend(append.id, { enabled: !append.enabled })),
      scriptButton('编辑', () => openAppendEditor(append)),
      scriptButton('删除', () => deleteAppend(append), false, 'delete'),
    );
    row.append(description, actions); appendList.append(row);
  });
}

async function reload() {
  const view = captureView();
  const seq = ++loadSeq;
  const data = await api(`/api/profiles/${encodeURIComponent(view.profileId)}/state`);
  if (seq !== loadSeq || !isViewCurrent(view) || data.id !== view.profileId) return null;
  current = data;
  // 后台刷新/保存/脚本操作不静默覆盖用户正在编辑、且与服务端不同的设置表单。
  render({ keepForm: settingsFormDirty() });
  setProfileReady(true);
  return data;
}

function openEditor(script = null) {
  if (!isViewLoaded(captureView())) return;
  editorSession += 1;
  resetValidateState();
  editingId = script?.id || null;
  $('#script-form-title').textContent = script ? '编辑脚本' : '新增脚本';
  $('#script-name').value = script?.name || '';
  $('#script-enabled').checked = script?.enabled ?? true;
  $('#script-code').value = script?.code || example;
  $('#script-form').hidden = false;
  updateScriptLineNumbers();
  $('#script-name').focus();
}

function openAppendEditor(append = null) {
  if (!isViewLoaded(captureView())) return;
  editingAppendId = append?.id || null;
  $('#append-form-title').textContent = append ? '编辑追加项' : '新增追加项';
  fillAppendEditor(append);
  $('#append-form').hidden = false;
  updateAppendLineNumbers();
  $('#append-name').focus();
}

function fillAppendEditor(append = null) {
  $('#append-name').value = append?.name || '';
  $('#append-section').value = append?.section || 'Rule';
  $('#append-position').value = append?.position || 'first';
  renderAppendPosition();
  $('#append-enabled').checked = append?.enabled ?? true;
  $('#append-create-if-missing').checked = append?.createIfMissing ?? true;
  $('#append-overwrite').checked = append?.overwrite ?? false;
  syncAppendOverwrite();
  $('#append-content').value = append?.content || '';
  updateAppendLineNumbers();
}

const scriptIndent = '  ';

function updateScriptLineNumbers() {
  updateEditorLineNumbers($('#script-code'), $('#script-line-numbers'));
}

$('#script-code').addEventListener('input', updateScriptLineNumbers);
$('#script-code').addEventListener('scroll', () => {
  $('#script-line-numbers').scrollTop = $('#script-code').scrollTop;
});
new ResizeObserver(updateScriptLineNumbers).observe($('#script-code'));

function replaceEditorRange(textarea, replacement, start, end, selectionMode = 'end') {
  textarea.setRangeText(replacement, start, end, selectionMode);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectedLineRange(textarea) {
  const value = textarea.value;
  const start = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
  let end;
  if (textarea.selectionEnd > textarea.selectionStart && value[textarea.selectionEnd - 1] === '\n') {
    end = textarea.selectionEnd - 1;
  } else {
    end = value.indexOf('\n', textarea.selectionEnd);
    if (end === -1) end = value.length;
  }
  return { start, end };
}

function changeSelectedIndent(textarea, remove = false) {
  const { start, end } = selectedLineRange(textarea);
  const lines = textarea.value.slice(start, end).split('\n');
  const changed = lines.map(line => {
    if (!remove) return scriptIndent + line;
    if (line.startsWith(scriptIndent)) return line.slice(scriptIndent.length);
    if (line.startsWith('\t')) return line.slice(1);
    if (line.startsWith(' ')) return line.slice(1);
    return line;
  });
  replaceEditorRange(textarea, changed.join('\n'), start, end, 'preserve');
}

function handleScriptEditorKeydown(event) {
  const textarea = event.currentTarget;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;

  if (event.key === 'Tab') {
    event.preventDefault();
    if (start !== end) {
      changeSelectedIndent(textarea, event.shiftKey);
    } else if (event.shiftKey) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const leading = value.slice(lineStart, start);
      const count = leading.endsWith(scriptIndent) ? scriptIndent.length : leading.endsWith('\t') || leading.endsWith(' ') ? 1 : 0;
      if (count) replaceEditorRange(textarea, '', start - count, start);
    } else {
      replaceEditorRange(textarea, scriptIndent, start, end);
    }
    return;
  }

  if (event.key === 'Enter' && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const beforeCursor = value.slice(lineStart, start);
    const currentLineEnd = value.indexOf('\n', start);
    const currentLine = value.slice(lineStart, currentLineEnd === -1 ? value.length : currentLineEnd);
    let indentation = currentLine.match(/^[\t ]*/)[0];
    if (!indentation && !currentLine.trim() && lineStart > 0) {
      const previousLineEnd = lineStart - 1;
      const previousLineStart = value.lastIndexOf('\n', previousLineEnd - 1) + 1;
      const previousLine = value.slice(previousLineStart, previousLineEnd);
      indentation = previousLine.match(/^[\t ]*/)[0];
    }
    const nextCharacter = value[end];
    const matchingCloser = { '{': '}', '[': ']', '(': ')' }[beforeCursor.trimEnd().at(-1)];

    if (start === end && matchingCloser && nextCharacter === matchingCloser) {
      replaceEditorRange(textarea, `\n${indentation}${scriptIndent}\n${indentation}`, start, end);
      return;
    }

    const extraIndent = /[\[{(]\s*$/.test(beforeCursor) ? scriptIndent : '';
    replaceEditorRange(textarea, `\n${indentation}${extraIndent}`, start, end);
    return;
  }

  if (['}', ']', ')'].includes(event.key) && start === end) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const beforeCursor = value.slice(lineStart, start);
    if (/^[\t ]+$/.test(beforeCursor)) {
      const indentation = beforeCursor.endsWith(scriptIndent)
        ? beforeCursor.slice(0, -scriptIndent.length)
        : beforeCursor.slice(0, -1);
      event.preventDefault();
      replaceEditorRange(textarea, indentation + event.key, lineStart, start);
    }
  }
}

$('#script-code').addEventListener('keydown', handleScriptEditorKeydown);
let scriptFindMatches = [];

function updateScriptFindMatches() {
  const textarea = $('#script-code');
  const input = $('#script-find-input');
  const count = $('#script-find-count');
  const query = input.value;
  scriptFindMatches = [];
  if (query) {
    const haystack = textarea.value.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    let position = 0;
    while ((position = haystack.indexOf(needle, position)) !== -1) {
      scriptFindMatches.push(position);
      position += Math.max(needle.length, 1);
    }
  }
  const current = scriptFindMatches.indexOf(textarea.selectionStart);
  count.textContent = scriptFindMatches.length ? `${current >= 0 ? current + 1 : 0}/${scriptFindMatches.length}` : '无匹配';
}

function selectScriptFindMatch(direction = 1) {
  const textarea = $('#script-code');
  const query = $('#script-find-input').value;
  updateScriptFindMatches();
  if (!query || !scriptFindMatches.length) return;
  const currentPosition = direction > 0 ? textarea.selectionEnd : textarea.selectionStart - 1;
  let target = direction > 0
    ? scriptFindMatches.find(position => position >= currentPosition)
    : [...scriptFindMatches].reverse().find(position => position <= currentPosition);
  if (target === undefined) target = direction > 0 ? scriptFindMatches[0] : scriptFindMatches.at(-1);
  textarea.focus();
  textarea.setSelectionRange(target, target + query.length);
  const lineIndex = textarea.value.slice(0, target).split('\n').length - 1;
  const styles = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles.lineHeight) || Number.parseFloat(styles.fontSize) * 1.5;
  textarea.scrollTop = Math.max(0, lineIndex * lineHeight - (textarea.clientHeight - lineHeight) / 2);
  $('#script-line-numbers').scrollTop = textarea.scrollTop;
  const current = scriptFindMatches.indexOf(target);
  $('#script-find-count').textContent = `${current + 1}/${scriptFindMatches.length}`;
}

function openScriptFind() {
  const textarea = $('#script-code');
  const panel = $('#script-find');
  const input = $('#script-find-input');
  panel.hidden = false;
  if (!input.value && textarea.selectionStart !== textarea.selectionEnd) {
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).replace(/[\r\n]/g, ' ');
    input.value = selected;
  }
  input.focus();
  input.select();
  updateScriptFindMatches();
}

function closeScriptFind() {
  $('#script-find').hidden = true;
  $('#script-code').focus();
}

$('#open-script-find').addEventListener('click', openScriptFind);
$('#close-script-find').addEventListener('click', closeScriptFind);
$('#script-find-input').addEventListener('input', () => {
  updateScriptFindMatches();
});
$('#script-find-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    selectScriptFindMatch(event.shiftKey ? -1 : 1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeScriptFind();
  }
});
$('#script-find-prev').addEventListener('click', () => selectScriptFindMatch(-1));
$('#script-find-next').addEventListener('click', () => selectScriptFindMatch(1));
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !event.altKey && !$('#script-form').hidden && !event.target.closest('#append-form')) {
    event.preventDefault();
    openScriptFind();
  }
});

$('#toggle-script-wrap').addEventListener('click', event => {
  const button = event.currentTarget;
  const wrapped = button.getAttribute('aria-pressed') !== 'true';
  $('#script-code').wrap = wrapped ? 'soft' : 'off';
  button.setAttribute('aria-pressed', String(wrapped));
  button.textContent = `自动换行：${wrapped ? '开' : '关'}`;
  button.title = wrapped ? '关闭自动换行' : '开启自动换行';
  updateScriptLineNumbers();
});

function renderAppendPosition() {
  const value = $('#append-position').value;
  $('#append-position-value').textContent = value === 'first' ? '最前' : '最后';
  document.querySelectorAll('#append-position-options button').forEach(button => {
    button.setAttribute('aria-checked', String(button.dataset.position === value));
  });
}

function closeAppendPositionMenu(focus = false) {
  $('#append-position-options').hidden = true;
  $('#append-position-toggle').setAttribute('aria-expanded', 'false');
  if (focus) $('#append-position-toggle').focus();
}

function openAppendPositionMenu() {
  renderAppendPosition();
  $('#append-position-options').hidden = false;
  $('#append-position-toggle').setAttribute('aria-expanded', 'true');
  $('#append-position-options [aria-checked="true"]').focus();
}

$('#append-position-toggle').addEventListener('click', () => {
  if ($('#append-position-options').hidden) openAppendPositionMenu();
  else closeAppendPositionMenu(true);
});
$('#append-position-toggle').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openAppendPositionMenu(); }
});
$('#append-position-options').addEventListener('click', event => {
  const option = event.target.closest('[data-position]');
  if (!option) return;
  $('#append-position').value = option.dataset.position;
  renderAppendPosition();
  closeAppendPositionMenu(true);
});
$('#append-position-options').addEventListener('keydown', event => {
  const options = [...document.querySelectorAll('#append-position-options button')];
  const index = options.indexOf(document.activeElement);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  } else if (event.key === 'Escape') { event.preventDefault(); closeAppendPositionMenu(true); }
  else if (event.key === 'Tab') closeAppendPositionMenu();
});
document.addEventListener('click', event => {
  if (!event.target.closest('.append-position-picker')) closeAppendPositionMenu();
});
document.addEventListener('focusin', event => {
  if (!event.target.closest('.append-position-picker')) closeAppendPositionMenu();
});

function syncAppendOverwrite() {
  const overwrite = $('#append-overwrite').checked;
  $('#append-position-field').hidden = overwrite;
  $('.append-fields').classList.toggle('is-overwrite', overwrite);
  closeAppendPositionMenu();
}
$('#append-overwrite').addEventListener('change', syncAppendOverwrite);

function updateAppendLineNumbers() {
  updateEditorLineNumbers($('#append-content'), $('#append-line-numbers'));
}

function updateEditorLineNumbers(textarea, gutter) {
  if (textarea.closest('form').hidden) return;
  const lines = textarea.value.split('\n');
  textarea.closest('.script-editor').style.setProperty('--editor-line-digits', `${Math.max(3, String(lines.length).length)}ch`);
  const styles = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles.lineHeight);
  const measure = document.createElement('div');
  Object.assign(measure.style, {
    position: 'fixed', left: '-10000px', visibility: 'hidden',
    font: styles.font, lineHeight: styles.lineHeight, letterSpacing: styles.letterSpacing,
    tabSize: styles.tabSize, whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    width: `${Math.max(1, textarea.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight))}px`,
  });
  document.body.append(measure);
  const rows = lines.map((line, index) => {
    const row = document.createElement('span');
    row.textContent = index + 1;
    measure.textContent = line || '\u200b';
    row.style.height = `${textarea.wrap === 'soft' ? Math.max(lineHeight, measure.getBoundingClientRect().height) : lineHeight}px`;
    return row;
  });
  measure.remove();
  gutter.replaceChildren(...rows);
  gutter.scrollTop = textarea.scrollTop;
}

function appendFindMatches() {
  const textarea = $('#append-content');
  const query = $('#append-find-input').value.toLocaleLowerCase();
  const matches = [];
  if (query) {
    const text = textarea.value.toLocaleLowerCase();
    let start = 0;
    while ((start = text.indexOf(query, start)) !== -1) {
      matches.push(start);
      start += query.length;
    }
  }
  const index = matches.indexOf(textarea.selectionStart);
  $('#append-find-count').textContent = matches.length ? `${index + 1}/${matches.length}` : '无匹配';
  return matches;
}

function selectAppendFindMatch(direction) {
  const textarea = $('#append-content');
  const matches = appendFindMatches();
  if (!matches.length) return;
  const position = direction > 0 ? textarea.selectionEnd : textarea.selectionStart - 1;
  const target = (direction > 0 ? matches.find(item => item >= position) : [...matches].reverse().find(item => item <= position))
    ?? (direction > 0 ? matches[0] : matches.at(-1));
  textarea.focus();
  textarea.setSelectionRange(target, target + $('#append-find-input').value.length);
  const line = textarea.value.slice(0, target).split('\n').length - 1;
  const rows = $('#append-line-numbers').children;
  let top = 0;
  for (let index = 0; index < line; index++) top += rows[index].getBoundingClientRect().height;
  textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 2);
  $('#append-line-numbers').scrollTop = textarea.scrollTop;
  appendFindMatches();
}

function openAppendFind() {
  const textarea = $('#append-content');
  const input = $('#append-find-input');
  $('#append-find').hidden = false;
  if (!input.value && textarea.selectionStart !== textarea.selectionEnd) {
    input.value = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).replace(/[\r\n]/g, ' ');
  }
  input.focus();
  input.select();
  appendFindMatches();
}

function closeAppendFind() {
  $('#append-find').hidden = true;
  $('#append-content').focus();
}

$('#append-content').addEventListener('input', () => { updateAppendLineNumbers(); appendFindMatches(); });
$('#append-content').addEventListener('scroll', () => { $('#append-line-numbers').scrollTop = $('#append-content').scrollTop; });
new ResizeObserver(updateAppendLineNumbers).observe($('#append-content'));
$('#open-append-find').addEventListener('click', openAppendFind);
$('#close-append-find').addEventListener('click', closeAppendFind);
$('#append-find-input').addEventListener('input', appendFindMatches);
$('#append-find-input').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); selectAppendFindMatch(event.shiftKey ? -1 : 1); }
  else if (event.key === 'Escape') { event.preventDefault(); closeAppendFind(); }
});
$('#append-find-prev').addEventListener('click', () => selectAppendFindMatch(-1));
$('#append-find-next').addEventListener('click', () => selectAppendFindMatch(1));
$('#toggle-append-wrap').addEventListener('click', event => {
  const button = event.currentTarget;
  const wrapped = button.getAttribute('aria-pressed') !== 'true';
  $('#append-content').wrap = wrapped ? 'soft' : 'off';
  button.setAttribute('aria-pressed', String(wrapped));
  button.textContent = `自动换行：${wrapped ? '开' : '关'}`;
  updateAppendLineNumbers();
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !event.altKey && !$('#append-form').hidden
    && ($('#script-form').hidden || event.target.closest('#append-form'))) {
    event.preventDefault();
    openAppendFind();
  }
});

async function updateScript(id, payload) {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(view.profileId)}/scripts/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (!isViewLoaded(view)) return;
    await reload();
    notice('脚本已更新');
  }
  catch (error) { notice(isViewCurrent(view) ? error.message : `profile「${view.profileId}」操作失败：${error.message}`, true); }
}

async function moveScript(id, direction) {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(view.profileId)}/scripts/${id}/move`, { method: 'POST', body: JSON.stringify({ direction }) });
    if (!isViewLoaded(view)) return;
    await reload();
  }
  catch (error) { notice(isViewCurrent(view) ? error.message : `profile「${view.profileId}」操作失败：${error.message}`, true); }
}

async function deleteScript(script) {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  if (!confirm(`删除脚本「${script.name}」？`)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(view.profileId)}/scripts/${script.id}`, { method: 'DELETE' });
    if (!isViewLoaded(view)) return;
    await reload();
    notice('脚本已删除');
  }
  catch (error) { notice(isViewCurrent(view) ? error.message : `profile「${view.profileId}」操作失败：${error.message}`, true); }
}

async function updateAppend(id, payload) {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(view.profileId)}/appends/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (!isViewLoaded(view)) return;
    await reload();
    notice('追加项已更新');
  } catch (error) { notice(isViewCurrent(view) ? error.message : `profile「${view.profileId}」操作失败：${error.message}`, true); }
}

async function moveAppend(id, direction) {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(view.profileId)}/appends/${id}/move`, { method: 'POST', body: JSON.stringify({ direction }) });
    if (!isViewLoaded(view)) return;
    await reload();
  } catch (error) { notice(isViewCurrent(view) ? error.message : `profile「${view.profileId}」操作失败：${error.message}`, true); }
}

async function deleteAppend(append) {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  if (!confirm(`删除追加项「${append.name}」？`)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(view.profileId)}/appends/${append.id}`, { method: 'DELETE' });
    if (!isViewLoaded(view)) return;
    await reload();
    notice('追加项已删除');
  } catch (error) { notice(isViewCurrent(view) ? error.message : `profile「${view.profileId}」操作失败：${error.message}`, true); }
}

$('#add-header').addEventListener('click', () => addHeader());
$('#toggle-source-url').addEventListener('click', event => {
  const input = $('#source-url');
  const button = event.currentTarget;
  const show = input.type === 'password';
  input.type = show ? 'url' : 'password';
  button.setAttribute('aria-pressed', String(show));
  button.setAttribute('aria-label', `${show ? '隐藏' : '显示'}上游 Surge 配置链接`);
  button.title = show ? '隐藏链接' : '显示链接';
});
$('#copy-link').addEventListener('click', async () => {
  const input = $('#subscription-link');
  if (await copyText(input.value)) notice('订阅链接已复制');
  else { input.select(); notice('请手动复制已选中的订阅链接'); }
});
$('#install-to-surge').addEventListener('click', installToSurge);
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const view = captureView();
  if (!isViewLoaded(view)) return;
  try {
    await api(`/api/profiles/${encodeURIComponent(view.profileId)}/settings`, { method: 'PUT', body: JSON.stringify(settingsFromForm()) });
    if (!isViewCurrent(view)) { notice(`profile「${view.profileId}」的设置已保存`); return; }
    await reload();
    notice('设置已保存', false, { label: '立即拉取并转换', run: () => refreshNow(view.profileId) });
  }
  catch (error) { notice(isViewCurrent(view) ? error.message : `profile「${view.profileId}」设置保存失败：${error.message}`, true); }
});
$('#new-script').addEventListener('click', () => openEditor());
$('#cancel-script').addEventListener('click', closeScriptForm);
$('#collapse-script-top').addEventListener('click', closeScriptForm);
$('#new-append').addEventListener('click', () => openAppendEditor());
$('#cancel-append').addEventListener('click', closeAppendForm);
$('#collapse-append-top').addEventListener('click', closeAppendForm);
async function checkScript() {
  const view = captureView();
  if (!isViewLoaded(view) || validateBusy) return;
  const seq = ++validateSeq;
  setValidateState(true);
  const payload = { name: $('#script-name').value, code: $('#script-code').value, enabled: $('#script-enabled').checked };
  try {
    await api(`/api/profiles/${encodeURIComponent(view.profileId)}/scripts/validate`, { method: 'POST', body: JSON.stringify(payload) });
    if (seq === validateSeq && isViewCurrent(view)) notice('脚本语法检查通过');
  } catch (error) {
    if (seq === validateSeq && isViewCurrent(view)) notice(error.message, true);
  } finally {
    // 只有仍属于同一编辑器会话的请求才能改按钮；切换/关闭/重开后旧响应失效。
    if (seq === validateSeq) setValidateState(false);
  }
}
$('#validate-script').addEventListener('click', checkScript);
$('#validate-script-top').addEventListener('click', checkScript);
$('#script-form').addEventListener('submit', async event => {
  event.preventDefault();
  const view = captureView();
  if (!isViewLoaded(view)) return;
  const session = editorSession;
  const editing = editingId;
  const payload = { name: $('#script-name').value, code: $('#script-code').value, enabled: $('#script-enabled').checked };
  try {
    const saved = await api(editing ? `/api/profiles/${encodeURIComponent(view.profileId)}/scripts/${editing}` : `/api/profiles/${encodeURIComponent(view.profileId)}/scripts`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    if (!isViewLoaded(view)) return;
    // 保存期间用户可能打开了另一个脚本；此时不得把 editingId 改回旧目标。
    if (session === editorSession) {
      editingId = saved.id;
      $('#script-form-title').textContent = '编辑脚本';
    }
    await reload();
    notice('脚本已保存', false, { label: '立即拉取并转换', run: () => refreshNow(view.profileId) });
  } catch (error) { if (isViewCurrent(view)) notice(error.message, true); }
});
$('#append-form').addEventListener('submit', async event => {
  event.preventDefault();
  const view = captureView();
  if (!isViewLoaded(view)) return;
  const editing = editingAppendId;
  const payload = {
    name: $('#append-name').value,
    section: $('#append-section').value,
    position: $('#append-position').value,
    enabled: $('#append-enabled').checked,
    createIfMissing: $('#append-create-if-missing').checked,
    overwrite: $('#append-overwrite').checked,
    content: $('#append-content').value,
  };

  try {
    const saved = await api(editing ? `/api/profiles/${encodeURIComponent(view.profileId)}/appends/${editing}` : `/api/profiles/${encodeURIComponent(view.profileId)}/appends`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    if (!isViewLoaded(view)) return;
    await reload();
    if (!isViewLoaded(view)) return;
    editingAppendId = saved.id;
    $('#append-form-title').textContent = '编辑追加项';
    fillAppendEditor(saved);
    notice('追加项已保存', false, { label: '立即拉取并转换', run: () => refreshNow(view.profileId) });
  } catch (error) { if (isViewCurrent(view)) notice(error.message, true); }
});
async function refreshNow(profileId = currentProfileId) {
  if (profileId !== currentProfileId) return;
  const view = captureView();
  if (!isViewLoaded(view) || refreshInFlight.has(view.profileId)) return;
  refreshInFlight.add(view.profileId);
  setRefreshState(true);
  try {
    const result = await api(`/api/profiles/${encodeURIComponent(view.profileId)}/refresh`, { method: 'POST', body: '{}' });
    if (!isViewLoaded(view)) return;
    await reload();
    notice(result.stale ? `拉取失败，仍使用上次成功配置：${result.lastError}` : '已生成最新配置', result.stale);
  }
  catch (error) {
    if (!isViewLoaded(view)) return;
    await reload().catch(() => {});
    notice(error.message, true);
  }
  finally {
    refreshInFlight.delete(view.profileId);
    if (currentProfileId === view.profileId) setRefreshState(refreshInFlight.has(view.profileId));
    renderTimestamps();
  }
}
$('#refresh').addEventListener('click', () => refreshNow());
async function refreshPreview() {
  const view = captureView();
  if (!isViewLoaded(view) || previewBusy) return;
  const seq = ++previewSeq;
  setPreviewRefreshState(true);
  try {
    const content = await api(`/api/profiles/${encodeURIComponent(view.profileId)}/preview`);
    if (seq !== previewSeq || !isViewLoaded(view)) return;
    setPreviewContent(content);
    notice('已刷新上次成功配置');
  } catch (error) {
    if (seq === previewSeq && isViewCurrent(view)) notice(error.message, true);
  } finally {
    // 切换/关闭预览后旧请求已完成的状态不得到当前视图。
    if (seq === previewSeq) setPreviewRefreshState(false);
  }
}
$('#refresh-preview').addEventListener('click', refreshPreview);
function setPreviewContent(text) {
  previewText = text;
  const code = $('#preview-code');
  code.replaceChildren();
  const lines = text.split('\n');
  lines.forEach(line => {
    const element = document.createElement('span');
    element.className = 'preview-line';
    element.textContent = line;
    code.append(element);
  });
}

function selectPreviewContents() {
  const code = $('#preview-code');
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(code);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function copyPreview() {
  try {
    await navigator.clipboard.writeText(previewText);
  } catch {
    selectPreviewContents();
    if (!document.execCommand('copy')) throw new Error('复制失败，请使用 Cmd/Ctrl+A 后复制');
  }
  notice('配置已复制');
}
$('#copy-preview').addEventListener('click', copyPreview);
$('#preview-content').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    selectPreviewContents();
  }
});
$('#preview').addEventListener('click', async () => {
  const view = captureView();
  if (!isViewLoaded(view)) return;
  const button = $('#preview');
  const refreshButton = $('#refresh-preview');
  const copyButton = $('#copy-preview');
  const preview = $('#preview-content');
  if (!preview.hidden) {
    preview.hidden = true;
    refreshButton.hidden = true;
    copyButton.hidden = true;
    button.textContent = '查看上次成功配置';
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  try {
    const content = await api(`/api/profiles/${encodeURIComponent(view.profileId)}/preview`);
    if (!isViewLoaded(view)) return;
    setPreviewContent(content);
    preview.hidden = false;
    refreshButton.hidden = false;
    copyButton.hidden = false;
    button.textContent = '收起配置';
    button.setAttribute('aria-expanded', 'true');
  }
  catch (error) { if (isViewCurrent(view)) notice(error.message, true); }
});
$('#profile-select').addEventListener('click', () => {
  if ($('#profile-options').hidden) openProfileMenu();
  else closeProfileMenu();
});
$('#profile-select').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openProfileMenu();
  }
});
$('#profile-options').addEventListener('click', event => {
  const item = event.target.closest('[role="menuitemradio"]');
  if (!item) return;
  closeProfileMenu(true);
  switchProfile(item.dataset.profileId).catch(error => notice(error.message, true));
});
$('#profile-options').addEventListener('keydown', event => {
  const items = profileMenuItems();
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeProfileMenu(true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
});
$('#profile-options').addEventListener('focusout', event => {
  if (!$('#profile-options').contains(event.relatedTarget) && event.relatedTarget !== $('#profile-select')) closeProfileMenu();
});
document.addEventListener('pointerdown', event => {
  if (!$('#profile-picker').contains(event.target)) closeProfileMenu();
});
$('#new-profile').addEventListener('click', () => requestProfileDialog('create'));
$('#copy-profile').addEventListener('click', () => requestProfileDialog('copy'));
$('#import-profile').addEventListener('click', chooseImportFile);
$('#export-profile').addEventListener('click', exportCurrentProfile);
$('#profile-import-file').addEventListener('change', event => readImportFile(event.target.files[0]));
$('#rename-profile').addEventListener('click', () => { if (isViewLoaded(captureView())) openProfileDialog('rename'); });
$('#delete-profile').addEventListener('click', deleteCurrentProfile);
$('#cancel-profile').addEventListener('click', () => {
  if (!profileSubmitPending) {
    pendingImportDocument = null;
    $('#profile-dialog').close();
  }
});
$('#profile-dialog').addEventListener('cancel', event => {
  if (profileSubmitPending) event.preventDefault();
  else pendingImportDocument = null;
});
$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (profileSubmitPending) return;
  const view = captureView();
  const mode = profileDialogMode;
  const id = $('#profile-id-input').value;
  const name = $('#profile-name-input').value.trim();
  profileSubmitPending = true;
  const submitButton = $('#profile-form button[type=submit]');
  const cancelButton = $('#cancel-profile');
  submitButton.disabled = true;
  cancelButton.disabled = true;
  try {
    if (mode === 'rename') {
      if (!isViewLoaded(view)) return;
      const updated = await api(`/api/profiles/${encodeURIComponent(view.profileId)}`, { method: 'PUT', body: JSON.stringify({ name }) });
      $('#profile-dialog').close();
      await loadProfiles();
      if (isViewLoaded(view)) {
        // 只更新名称，不重新加载表单，避免覆盖未保存的设置/脚本草稿。
        current.name = updated.name;
        renderProfileOptions();
      }
      notice('已重命名 profile');
      return;
    }
    if (!isViewLoaded(view)) return;
    const payload = mode === 'import'
      ? { document: pendingImportDocument, id, name }
      : { id, name };
    if (mode === 'copy') payload.copyFrom = view.profileId;
    const endpoint = mode === 'import' ? '/api/profiles/import' : '/api/profiles';
    const created = await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    pendingImportDocument = null;
    $('#profile-dialog').close();
    await loadProfiles();
    const createdMessage = mode === 'copy' ? '已复制 profile' : mode === 'import' ? '已导入 profile' : '已新建 profile';
    if (!isViewCurrent(view)) { notice(createdMessage); return; }
    viewGeneration += 1;
    currentProfileId = created.id;
    saveSelectedProfileId(currentProfileId);
    showProfileLoading();
    await reload();
    notice(createdMessage);
  } catch (error) {
    notice(error.message, true);
  } finally {
    profileSubmitPending = false;
    submitButton.disabled = false;
    cancelButton.disabled = false;
  }
});

async function initialise() {
  showProfileLoading();
  await loadProfiles();
  if (!profiles.length) throw new Error('没有可用的 profile');
  const rememberedId = readSelectedProfileId();
  currentProfileId = profiles.some(profile => profile.id === rememberedId)
    ? rememberedId
    : (profiles.some(profile => profile.id === 'default') ? 'default' : profiles[0].id);
  saveSelectedProfileId(currentProfileId);
  viewGeneration += 1;
  showProfileLoading();
  await reload();
}

initialise().catch(error => notice(error.message, true));
