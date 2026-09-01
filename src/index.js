// 网页变化监控器 · Cloudflare Workers 版
// 入口：Web 管理界面 + 任务管理 API + Cron 定时检查

import {
  checkTask, runScheduled, saveTask, loadAllTasks, deleteTask,
  INDEX_KEY, DEFAULT_INTERVAL_MIN,
} from './core.js';
import { DASHBOARD_HTML } from './ui.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

// 访问密钥校验：配置了 ADMIN_KEY 后，所有页面与 API 均需携带
//   请求头  X-Admin-Key  或  查询参数 ?key=
function authorized(request, env) {
  if (!env.ADMIN_KEY) return true;
  const url = new URL(request.url);
  const headerKey = request.headers.get('X-Admin-Key');
  const queryKey = url.searchParams.get('key');
  return headerKey === env.ADMIN_KEY || queryKey === env.ADMIN_KEY;
}

// 规范化任务字段
function normalizeTask(body, existing = null) {
  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('URL 必须以 http:// 或 https:// 开头');
  const interval = Number(body.intervalMin);
  return {
    ...(existing || {}),
    id: existing?.id || crypto.randomUUID(),
    url,
    name: String(body.name || '').trim(),
    intervalMin: Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : DEFAULT_INTERVAL_MIN,
    keywords: String(body.keywords || ''),
    useRegex: !!body.useRegex,
    notify: body.notify !== false,
    createdAt: existing?.createdAt || Date.now(),
  };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  // ---- 任务列表 ----
  if (path === '/api/tasks' && method === 'GET') {
    const tasks = await loadAllTasks(env);
    tasks.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    // 快照文本较大，列表接口不返回
    return json(tasks.map(({ text, ...rest }) => rest));
  }

  // ---- 添加任务 ----
  if (path === '/api/tasks' && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: '请求体必须是 JSON' }, 400); }
    let task;
    try { task = normalizeTask(body); } catch (e) { return json({ error: e.message }, 400); }
    await saveTask(env, task);
    const { text, ...rest } = task;
    return json(rest, 201);
  }

  // ---- 单任务操作：详情 / 更新 / 删除 / 立即检查 ----
  const m = path.match(/^\/api\/tasks\/([^/]+)(\/check|\/diff)?$/);
  if (m) {
    const id = m[1];
    const action = m[2];
    const raw = await env.WATCHER.get('task:' + id);
    if (!raw) return json({ error: '任务不存在' }, 404);
    const task = JSON.parse(raw);

    if (action === '/check') {           // 立即检查
      const result = await checkTask(task, env);
      await env.WATCHER.put('task:' + id, JSON.stringify(task));
      return json(result);
    }
    if (action === '/diff') {            // 查看变化详情
      return json({ name: task.name || task.url, lastDiff: task.lastDiff || '', status: task.status });
    }
    if (method === 'GET') {
      const { text, ...rest } = task;
      return json(rest);
    }
    if (method === 'PUT') {              // 更新：修改后重建关键词基线与快照
      let body;
      try { body = await request.json(); } catch { return json({ error: '请求体必须是 JSON' }, 400); }
      let updated;
      try { updated = normalizeTask(body, task); } catch (e) { return json({ error: e.message }, 400); }
      delete updated.text;
      delete updated.hash;
      delete updated.keywordCounts;
      updated.status = '等待检查';
      await saveTask(env, updated);
      const { text, ...rest } = updated;
      return json(rest);
    }
    if (method === 'DELETE') {
      await deleteTask(env, id);
      return json({ ok: true });
    }
    return json({ error: '不支持的操作' }, 405);
  }

  // ---- 手动/外部定时器触发一轮检查（等价于 Cron）----
  // 供 cron-job.org、GitHub Actions 等外部定时服务调用，兼容 GET/POST
  if (path === '/api/run-checks' && (method === 'POST' || method === 'GET')) {
    const summary = await runScheduled(env);
    return json(summary);
  }

  // ---- 运行日志 ----
  if (path === '/api/log' && method === 'GET') {
    return json({ log: (await env.WATCHER.get('log')) || '（暂无日志）' });
  }

  // ---- 配置状态（不回显敏感值）----
  if (path === '/api/health' && method === 'GET') {
    return json({
      ok: true,
      worker: 'web-page-watcher',
      time: new Date().toISOString(),
      channels: {
        telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        pushplus: !!env.PUSHPLUS_TOKEN,
        webhook: !!env.NOTIFY_WEBHOOK_URL,
      },
      authRequired: !!env.ADMIN_KEY,
    });
  }

  return json({ error: '未知接口' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (!authorized(request, env)) return json({ error: '未授权：请配置 key 参数或 X-Admin-Key 请求头' }, 401);
      return handleApi(request, env);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!authorized(request, env)) {
        return new Response('401 Unauthorized: 请在 URL 后附加 ?key=你的ADMIN_KEY', { status: 401 });
      }
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },

  // Cron Trigger 入口（每 5 分钟）；直接 await，异常写入日志便于排查
  async scheduled(event, env, ctx) {
    try {
      const summary = await runScheduled(env);
      console.log('scheduled:', JSON.stringify(summary));
    } catch (e) {
      const msg = (e && e.stack) || String(e);
      console.error('scheduled error:', msg);
      try {
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
        const old = (await env.WATCHER.get('log')) || '';
        await env.WATCHER.put('log',
          (`[${ts}] [错误] scheduled 异常：${msg}\n` + old).split('\n').slice(0, 200).join('\n'));
      } catch (_) { /* 日志写入失败不阻断 */ }
    }
  },
};
