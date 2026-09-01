// 内置 Web 管理界面（单页，原生 JS，无外部依赖）

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>网页变化监控器 · Cloudflare</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #10141a; color: #dce3ea; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px;
           background: #171d26; border-bottom: 1px solid #2a3441; }
  header h1 { font-size: 17px; margin: 0; flex: 1; }
  main { max-width: 1000px; margin: 0 auto; padding: 18px 20px 60px; }
  button { background: #2563eb; color: #fff; border: 0; border-radius: 6px;
           padding: 7px 14px; cursor: pointer; font-size: 13px; }
  button:hover { background: #1d4fd7; }
  button.ghost { background: #2a3441; }
  button.danger { background: #b91c1c; }
  button.small { padding: 4px 10px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #232c37; }
  th { color: #8b98a5; font-weight: 600; background: #171d26; }
  tr:hover td { background: #1a2230; }
  .status-alert { color: #f59e0b; font-weight: 600; }
  .status-err { color: #ef4444; }
  .status-ok { color: #34d399; }
  .panel { background: #171d26; border: 1px solid #2a3441; border-radius: 10px;
           padding: 16px 18px; margin-top: 18px; }
  .panel h2 { font-size: 15px; margin: 0 0 12px; }
  label { display: block; font-size: 12px; color: #8b98a5; margin: 10px 0 4px; }
  input[type=text], input[type=url], input[type=number], textarea, select {
    width: 100%; background: #0e1218; color: #dce3ea; border: 1px solid #2a3441;
    border-radius: 6px; padding: 8px 10px; font-size: 13px; }
  textarea { resize: vertical; }
  .row { display: flex; gap: 14px; flex-wrap: wrap; }
  .row > div { flex: 1; min-width: 180px; }
  .check { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 13px; }
  pre { background: #0e1218; border: 1px solid #232c37; border-radius: 6px;
        padding: 10px; font-size: 12px; max-height: 260px; overflow: auto; white-space: pre-wrap; }
  #toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
           background: #2563eb; color: #fff; padding: 10px 20px; border-radius: 8px;
           font-size: 13px; opacity: 0; transition: opacity .3s; pointer-events: none; }
  #toast.show { opacity: 1; }
  .hint { color: #8b98a5; font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
<header>
  <h1>📡 网页变化监控器 · Cloudflare Workers</h1>
  <button class="ghost" onclick="runAll()">▶ 立即全量检查</button>
  <button class="ghost" onclick="loadTasks()">⟳ 刷新</button>
</header>
<main>
  <div class="panel">
    <h2 id="form-title">添加监控任务</h2>
    <form id="task-form" onsubmit="return submitTask(event)">
      <input type="hidden" id="f-id">
      <label>网页地址 (URL)</label>
      <input type="url" id="f-url" required placeholder="https://example.com">
      <div class="row">
        <div><label>任务名称（可选）</label><input type="text" id="f-name"></div>
        <div><label>检查间隔（分钟）</label>
          <select id="f-interval">
            <option value="1">1 分钟</option><option value="5" selected>5 分钟</option>
            <option value="10">10 分钟</option><option value="30">30 分钟</option>
            <option value="60">1 小时</option><option value="180">3 小时</option>
          </select></div>
      </div>
      <label>关键词哨兵（可选，逗号或换行分隔）</label>
      <textarea id="f-keywords" rows="2" placeholder="留空=整页变化监控；填关键词=仅新出现/次数增加时提醒"></textarea>
      <div class="row">
        <div class="check"><input type="checkbox" id="f-regex"><span>关键词作为正则表达式</span></div>
        <div class="check"><input type="checkbox" id="f-notify" checked><span>命中时推送通知</span></div>
      </div>
      <p style="margin-top:14px">
        <button type="submit">保存任务</button>
        <button type="button" class="ghost" onclick="resetForm()">重置</button>
      </p>
    </form>
  </div>

  <div class="panel">
    <h2>任务列表</h2>
    <table>
      <thead><tr><th style="width:150px">状态</th><th>任务 / 地址</th>
        <th style="width:70px">间隔</th><th style="width:150px">上次检查</th>
        <th style="width:230px">操作</th></tr></thead>
      <tbody id="task-rows"><tr><td colspan="5" class="hint">加载中…</td></tr></tbody>
    </table>
  </div>

  <div class="panel">
    <h2>运行日志 <button class="ghost small" style="float:right" onclick="loadLog()">刷新日志</button></h2>
    <pre id="log-box">（点击刷新日志）</pre>
  </div>

  <div class="panel" id="key-panel">
    <h2>访问密钥</h2>
    <p class="hint">若 Worker 配置了 ADMIN_KEY，请填写后保存（仅存于浏览器 localStorage）。</p>
    <div class="row">
      <div><input type="text" id="admin-key" placeholder="ADMIN_KEY"></div>
      <div style="flex:0"><button onclick="saveKey()">保存密钥</button></div>
    </div>
  </div>
</main>

<div class="panel" id="diff-modal" style="display:none;position:fixed;inset:10% 15%;z-index:9;overflow:auto">
  <h2 id="diff-title">变化详情</h2>
  <pre id="diff-box"></pre>
  <button class="ghost" onclick="document.getElementById('diff-modal').style.display='none'">关闭</button>
</div>
<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function headers() {
  const h = { 'Content-Type': 'application/json' };
  const k = localStorage.getItem('wpw_key');
  if (k) h['X-Admin-Key'] = k;
  return h;
}
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: headers(), ...opts });
  if (r.status === 401) { toast('未授权：请先在底部填写访问密钥'); throw new Error('401'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}
function saveKey() {
  localStorage.setItem('wpw_key', $('admin-key').value.trim());
  toast('密钥已保存'); loadTasks();
}
function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}
function statusCls(s) {
  if (!s) return '';
  if (s.indexOf('⚠') === 0) return 'status-alert';
  if (s.indexOf('失败') >= 0) return 'status-err';
  if (s.indexOf('无变化') >= 0 || s.indexOf('通过') >= 0 || s.indexOf('完成') >= 0 || s.indexOf('建立') >= 0) return 'status-ok';
  return '';
}

async function loadTasks() {
  try {
    const tasks = await api('/api/tasks');
    const rows = tasks.map((t) => '<tr>' +
      '<td class="' + statusCls(t.status) + '">' + esc(t.status || '等待检查') + '</td>' +
      '<td><strong>' + esc(t.name || '') + '</strong><br><span class="hint">' + esc(t.url) + '</span></td>' +
      '<td>' + t.intervalMin + ' 分钟</td>' +
      '<td>' + fmtTime(t.lastCheck) + '</td>' +
      '<td><button class="small" onclick="checkNow(\\'' + t.id + '\\')">立即检查</button> ' +
      '<button class="small ghost" onclick="showDiff(\\'' + t.id + '\\')">详情</button> ' +
      '<button class="small ghost" onclick="editTask(\\'' + t.id + '\\')">编辑</button> ' +
      '<button class="small danger" onclick="delTask(\\'' + t.id + '\\')">删除</button></td></tr>').join('');
    $('task-rows').innerHTML = rows || '<tr><td colspan="5" class="hint">暂无任务，请在上方添加</td></tr>';
    window.__tasks = tasks;
  } catch (e) { $('task-rows').innerHTML = '<tr><td colspan="5" class="status-err">' + esc(e.message) + '</td></tr>'; }
}

async function submitTask(ev) {
  ev.preventDefault();
  const id = $('f-id').value;
  const body = {
    url: $('f-url').value.trim(), name: $('f-name').value.trim(),
    intervalMin: Number($('f-interval').value),
    keywords: $('f-keywords').value, useRegex: $('f-regex').checked,
    notify: $('f-notify').checked,
  };
  try {
    if (id) { await api('/api/tasks/' + id, { method: 'PUT', body: JSON.stringify(body) }); toast('任务已更新'); }
    else { await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) }); toast('任务已添加'); }
    resetForm(); loadTasks();
  } catch (e) { toast('保存失败：' + e.message); }
  return false;
}
function resetForm() {
  $('task-form').reset(); $('f-id').value = ''; $('f-notify').checked = true;
  $('form-title').textContent = '添加监控任务';
}
function editTask(id) {
  const t = (window.__tasks || []).find((x) => x.id === id);
  if (!t) return;
  $('f-id').value = t.id; $('f-url').value = t.url; $('f-name').value = t.name || '';
  $('f-interval').value = String(t.intervalMin); $('f-keywords').value = t.keywords || '';
  $('f-regex').checked = !!t.useRegex; $('f-notify').checked = t.notify !== false;
  $('form-title').textContent = '编辑任务'; window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function delTask(id) {
  if (!confirm('确定删除该监控任务？')) return;
  try { await api('/api/tasks/' + id, { method: 'DELETE' }); toast('已删除'); loadTasks(); }
  catch (e) { toast(e.message); }
}
async function checkNow(id) {
  toast('检查中…');
  try { const r = await api('/api/tasks/' + id + '/check', { method: 'POST' });
        toast(r.alert ? '⚠ 检测到变化/命中！' : ('检查完成：' + (r.error || '正常'))); loadTasks(); }
  catch (e) { toast(e.message); }
}
async function showDiff(id) {
  try { const d = await api('/api/tasks/' + id + '/diff');
        $('diff-title').textContent = '变化详情 - ' + d.name;
        $('diff-box').textContent = '状态：' + (d.status || '—') + '\\n\\n' + (d.lastDiff || '暂无变化记录');
        $('diff-modal').style.display = 'block'; }
  catch (e) { toast(e.message); }
}
async function runAll() {
  toast('全量检查中…');
  try { const s = await api('/api/run-checks', { method: 'POST' });
        toast('完成：共 ' + s.total + ' 个，检查 ' + s.checked + '，告警 ' + s.alert + '，失败 ' + s.failed);
        loadTasks(); loadLog(); }
  catch (e) { toast(e.message); }
}
async function loadLog() {
  try { $('log-box').textContent = (await api('/api/log')).log; }
  catch (e) { $('log-box').textContent = e.message; }
}

const urlKey = new URLSearchParams(location.search).get('key');
if (urlKey) { localStorage.setItem('wpw_key', urlKey); $('admin-key').value = urlKey; }
$('admin-key').value = localStorage.getItem('wpw_key') || '';
loadTasks(); loadLog();
</script>
</body>
</html>`;
