// 核心逻辑：抓取、文本提取、变化比对、关键词哨兵、通知推送
// 与桌面版（main.py）的判定规则保持一致：
//   - 整页监控：可见文本哈希变化即提醒
//   - 关键词哨兵：关键词新出现或次数增加即提醒（优先于整页监控）

export const INDEX_KEY = 'task_index';
export const DEFAULT_INTERVAL_MIN = 5;

const SCRIPT_STYLE_RE = /<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<[^>]+>/g;
const WS_RE = /[ \t\u00a0]+/g;

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

function unescapeHtml(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] || m);
}

// 去掉脚本/样式/标签，只保留可见文本（用于内容比对）
export function htmlToText(html) {
  let text = String(html).replace(SCRIPT_STYLE_RE, ' ');
  text = text.replace(COMMENT_RE, ' ');
  text = text.replace(TAG_RE, '\n');
  text = unescapeHtml(text);
  return text
    .split('\n')
    .map((ln) => ln.replace(WS_RE, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// 解析关键词输入：逗号/中文逗号/分号/换行分隔
export function splitKeywords(raw) {
  return String(raw || '')
    .split(/[,，;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 统计各关键词出现次数（不区分大小写；非法正则自动退化为字面匹配）
export function countKeywords(text, keywords, useRegex) {
  const low = text.toLowerCase();
  const counts = {};
  for (const kw of keywords) {
    if (useRegex) {
      try {
        counts[kw] = (text.match(new RegExp(kw, 'gi')) || []).length;
        continue;
      } catch (_) { /* 非法正则，退化为字面匹配 */ }
    }
    const lk = kw.toLowerCase();
    let c = 0;
    let i = low.indexOf(lk);
    while (i !== -1) {
      c += 1;
      i = low.indexOf(lk, i + lk.length);
    }
    counts[kw] = c;
  }
  return counts;
}

// 对比新旧文本，返回新增/删除行的摘要
export function diffSummary(oldText, newText, limit = 10) {
  const oldLines = (oldText || '').split('\n');
  const newLines = (newText || '').split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((l) => !oldSet.has(l));
  const removed = oldLines.filter((l) => !newSet.has(l));
  const parts = [];
  if (added.length) {
    parts.push(`新增 ${added.length} 行：`);
    added.slice(0, limit).forEach((l) => parts.push('  + ' + l.slice(0, 80)));
  }
  if (removed.length) {
    parts.push(`删除 ${removed.length} 行：`);
    removed.slice(0, limit).forEach((l) => parts.push('  - ' + l.slice(0, 80)));
  }
  if (!parts.length) parts.push('（哈希变化，但逐行对比无明显增删）');
  return parts.join('\n');
}

async function fetchPage(url, env) {
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': env.UA || 'CloudflareWorker-PageWatcher/1.0',
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    },
    cf: { cacheTtl: 60, cacheEverything: false },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

// 通知渠道：Telegram Bot + PushPlus（微信）+ 通用 Webhook；未配置则只记录日志
async function sendNotify(env, title, body) {
  const channels = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: `【${title}】\n${body}`,
          }),
        },
      );
      channels.push(r.ok ? 'telegram:成功' : `telegram:失败(HTTP ${r.status})`);
    } catch (e) {
      channels.push(`telegram:异常(${e.message})`);
    }
  }
  if (env.PUSHPLUS_TOKEN) {
    try {
      const r = await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: env.PUSHPLUS_TOKEN,
          title,
          content: `${body}\n\n—— cf-web-page-watcher`,
          template: 'txt',
        }),
      });
      const data = await r.json().catch(() => ({}));
      channels.push(data.code === 200 ? 'pushplus:成功' : `pushplus:失败(${data.msg || 'HTTP ' + r.status})`);
    } catch (e) {
      channels.push(`pushplus:异常(${e.message})`);
    }
  }
  if (env.NOTIFY_WEBHOOK_URL) {
    try {
      const r = await fetch(env.NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, source: 'cf-web-page-watcher' }),
      });
      channels.push(r.ok ? 'webhook:成功' : `webhook:失败(HTTP ${r.status})`);
    } catch (e) {
      channels.push(`webhook:异常(${e.message})`);
    }
  }
  if (!channels.length) channels.push('未配置通知渠道（仅日志）');
  return channels.join('；');
}

async function appendLog(env, line) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  try {
    const old = (await env.WATCHER.get('log')) || '';
    const next = (`[${ts}] ${line}\n` + old).split('\n').slice(0, 200).join('\n');
    await env.WATCHER.put('log', next);
  } catch (_) { /* 日志写入失败不影响主流程 */ }
}

// 检查单个任务，返回结果记录
export async function checkTask(task, env) {
  const name = task.name || task.url;
  const result = { id: task.id, name, url: task.url, alert: false, error: null };
  let html;
  try {
    html = await fetchPage(task.url, env);
  } catch (e) {
    result.error = e.message;
    task.status = `抓取失败：${e.message}`.slice(0, 60);
    task.lastCheck = Date.now();
    await appendLog(env, `[失败] ${name}：${e.message}`);
    return result;
  }

  const newText = htmlToText(html);
  const oldText = task.text || '';
  const oldHash = task.hash || null;
  let newHash;
  {
    const buf = await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(newText));
    newHash = [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  task.lastCheck = Date.now();

  const keywords = splitKeywords(task.keywords);
  if (keywords.length) {
    // 关键词哨兵
    const newCounts = countKeywords(newText, keywords, task.useRegex);
    const oldCounts = task.keywordCounts || null;
    task.keywordCounts = newCounts;
    if (oldCounts === null) {
      task.status = '关键词基线已建立';
      const base = keywords.map((k) => `${k}×${newCounts[k]}`).join('，');
      task.lastDiff = `关键词基线：${base}`;
      await appendLog(env, `[哨兵] ${name}：基线已建立（${base}）`);
    } else {
      const hits = [];
      const lines = [];
      for (const kw of keywords) {
        const oc = oldCounts[kw] || 0;
        const nc = newCounts[kw] || 0;
        if (nc > oc) {
          hits.push(kw);
          lines.push(`  “${kw}”：${oc} → ${nc}`);
        }
      }
      if (hits.length) {
        result.alert = true;
        task.status = ('⚠ 关键词命中：' + hits.join('、')).slice(0, 60);
        task.lastDiff = `关键词哨兵命中 · ${new Date().toISOString().slice(11, 19)}Z\n` + lines.join('\n');
        await appendLog(env, `[哨兵] ${name}：命中 ${hits.join('、')}`);
        if (task.notify !== false) {
          result.channel = await sendNotify(env, '关键词命中',
            `${name}\n${task.url}\n${lines.join('\n')}`);
        }
      } else {
        task.status = '关键词检查通过';
      }
    }
  } else if (oldHash === null) {
    task.status = '首次快照完成';
    task.lastDiff = '';
    await appendLog(env, `[快照] ${name}：已保存首次内容`);
  } else if (oldHash !== newHash) {
    result.alert = true;
    task.status = '⚠ 内容已更新';
    task.lastDiff = diffSummary(oldText, newText);
    await appendLog(env, `[变化] ${name}：检测到内容更新`);
    if (task.notify !== false) {
      result.channel = await sendNotify(env, '内容更新',
        `${name}\n${task.url}\n${task.lastDiff.slice(0, 500)}`);
    }
  } else {
    task.status = '无变化';
  }

  // 快照只保留最近一份文本（控制 KV 体积，单任务上限约 200KB）
  task.hash = newHash;
  task.text = newText.length > 200000 ? newText.slice(0, 200000) : newText;
  return result;
}

// 保存任务（含索引维护）
export async function saveTask(env, task) {
  await env.WATCHER.put('task:' + task.id, JSON.stringify(task));
  const index = JSON.parse((await env.WATCHER.get(INDEX_KEY)) || '[]');
  if (!index.includes(task.id)) {
    index.push(task.id);
    await env.WATCHER.put(INDEX_KEY, JSON.stringify(index));
  }
}

export async function loadAllTasks(env) {
  const index = JSON.parse((await env.WATCHER.get(INDEX_KEY)) || '[]');
  const tasks = [];
  for (const id of index) {
    const raw = await env.WATCHER.get('task:' + id);
    if (raw) tasks.push(JSON.parse(raw));
  }
  return tasks;
}

export async function deleteTask(env, id) {
  await env.WATCHER.delete('task:' + id);
  const index = JSON.parse((await env.WATCHER.get(INDEX_KEY)) || '[]');
  await env.WATCHER.put(INDEX_KEY, JSON.stringify(index.filter((x) => x !== id)));
}

// Cron 入口：扫描到期任务并检查
export async function runScheduled(env) {
  const tasks = await loadAllTasks(env);
  const now = Date.now();
  const summary = { total: tasks.length, checked: 0, alert: 0, failed: 0 };
  for (const task of tasks) {
    const interval = (task.intervalMin || DEFAULT_INTERVAL_MIN) * 60 * 1000;
    if (task.lastCheck && now - task.lastCheck < interval) continue;
    const result = await checkTask(task, env);
    summary.checked += 1;
    if (result.alert) summary.alert += 1;
    if (result.error) summary.failed += 1;
    await env.WATCHER.put('task:' + task.id, JSON.stringify(task));
  }
  return summary;
}
