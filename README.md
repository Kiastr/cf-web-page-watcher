# 网页变化监控器 · Cloudflare Workers 版

> 跑在 Cloudflare 边缘的轻量级网页哨兵：不用服务器、不用备案、不花一分钱，
> 部署一次就 7×24 小时盯着你关心的页面，变了立刻推到你手机上。

桌面版（Tkinter，见本地 main.py）的云端版本：由 Cloudflare Cron / 外部定时器定时触发，抓取网页 →
整页变化检测 / 关键词哨兵 → 命中后通过 Telegram / PushPlus（微信）/ 通用 Webhook 推送提醒。
自带 Web 管理界面，浏览器即可增删改任务，手机也能操作。

适合这些场景：抢票页放票、竞品改价、招标公告更新、招聘页放岗、博客断更——
凡是“我不想一直刷，但一变就得知道”的地方。

## 功能对照

| 桌面版 | Workers 版 |
|---|---|
| Tkinter GUI | 浏览器管理页（`/`） |
| 后台轮询线程 | Cron Trigger（默认每 5 分钟，免费版最小 1 分钟） |
| tasks.json | KV 存储（binding: WATCHER） |
| Windows 弹窗/系统通知 | Telegram Bot / PushPlus（微信）/ 通用 Webhook |
| Edge 无头渲染 | 不支持（服务端限制），仅抓静态内容 |

## 部署步骤

### 1. 安装依赖（缓存已建议指向 D 盘）

```powershell
npm.cmd install --cache D:\CodeBuddyWorkspace\workspace\.npm_cache
```

### 2. 登录并创建 KV 命名空间

```powershell
npx.cmd wrangler login                 # 浏览器授权
npx.cmd wrangler kv namespace create WATCHER
```

把输出中的 `id` 填入 `wrangler.toml` 的 `[[kv_namespaces]]` 段。

### 3. 注入凭证（一律用 secret / 环境变量，禁止写入文件）

```powershell
npx.cmd wrangler secret put ADMIN_KEY            # 管理页访问密钥（强烈建议设置）
npx.cmd wrangler secret put PUSHPLUS_TOKEN       # 通知渠道①：PushPlus 微信推送
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN   # 通知渠道②：Telegram（可选）
npx.cmd wrangler secret put TELEGRAM_CHAT_ID
npx.cmd wrangler secret put NOTIFY_WEBHOOK_URL   # 通知渠道③：通用 Webhook（可选）
```

通知渠道至少配置一个，否则命中只会写日志。

> **⚠ 关于 `ADMIN_KEY`**：它是管理页与全部 API 的唯一凭证。拿到它等于拿到
> 任务的**增删改查权**和运行日志读取权 —— 不只是“触发检查”这么简单。
> 务必通过 `wrangler secret put ADMIN_KEY` 注入，不要写进任何文件、不要提交进仓库。

> PushPlus 获取 token：访问 https://www.pushplus.plus 微信扫码登录，
> 首页复制「一对一推送」的 token 即可（免费 200 条/天）。

### 4. 部署

```powershell
npx.cmd wrangler deploy
```

访问输出的 `https://web-page-watcher.<你的子域>.workers.dev/?key=你的ADMIN_KEY` 管理。

## API 一览（均需 X-Admin-Key 头或 ?key= 参数）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/tasks | 任务列表 |
| POST | /api/tasks | 添加任务 |
| PUT | /api/tasks/:id | 更新（自动重建基线/快照） |
| DELETE | /api/tasks/:id | 删除 |
| POST | /api/tasks/:id/check | 立即检查单个任务 |
| GET | /api/tasks/:id/diff | 变化详情 |
| POST | /api/run-checks | 手动触发一轮全量检查 |
| GET | /api/log | 运行日志（最近 200 行） |
| GET | /api/health | 配置状态（不回显敏感值） |

## 本地开发

```powershell
$env:WRANGLER_STATE_DIR='D:\CodeBuddyWorkspace\workspace\.cf_temp'
npx.cmd wrangler dev --persist-to D:\CodeBuddyWorkspace\workspace\.cf_temp\local-state
```

本地使用模拟 KV，数据保存在 D 盘指定目录。

## ⚠ 定时触发不可靠问题与双保险方案（实测经验）

Cloudflare Hobby 计划的 Cron 对零流量账户**不保证触发**：本项目实测部署后仅触发了几轮就停摆。
解决方案：用外部定时器调用 `/api/run-checks`（支持 GET/POST，带 X-Admin-Key 或 ?key= 鉴权）：

- **GitHub Actions**（推荐）：把下面的工作流放进仓库 `.github/workflows/`，
  密钥一律用仓库 Secrets 存放（运行日志中会遮蔽成 `***`）

  > ⚠ **额度坑**：公开仓库的 Actions **免费无限**，私有仓库 **仅 2000 分钟/月**。
  > 每 5 分钟触发一次 ≈ 8640 分钟/月，私有仓库一周左右就烧完了。
  > 要么降到 30 分钟间隔（≈1440 分钟/月），要么单独开一个公开小仓库专门跑这个 cron。

  ```yaml
  name: watcher-cron
  on:
    schedule:
      - cron: '*/5 * * * *'
    workflow_dispatch: {}
  jobs:
    trigger:
      runs-on: ubuntu-latest
      env:
        WPW_WORKER_URL: ${{ secrets.WPW_WORKER_URL }}
        WPW_ADMIN_KEY: ${{ secrets.WPW_ADMIN_KEY }}
      steps:
        - run: |
            curl -sS -m 60 -H "X-Admin-Key: $WPW_ADMIN_KEY" "$WPW_WORKER_URL/api/run-checks"
  ```
- **cron-job.org**（免费）：新建任务，URL 填
  `https://web-page-watcher.<子域>.workers.dev/api/run-checks?key=你的ADMIN_KEY`，间隔 5 分钟，方法 GET/POST 均可

CF 自带的 Cron 保留不动，两者幂等（任务有 lastCheck 间隔判断，不会重复检查）。
注意：外部定时器每次调用会消耗 1 次函数调用额度（10 万/天），5 分钟间隔 ≈ 288 次/天，完全够用。

## 免费版限制

- Cron Trigger：最多 3 个，最小间隔 1 分钟
- 请求：10 万次/天；函数执行：10 万次/天、单次 ≤10ms CPU
- KV：读 10 万次/天、写 1000 次/天 —— 每任务每次检查 1 写，
  20 任务 × 5 分钟间隔 ≈ 5760 写/天 会超写额度；
  任务多时把间隔放宽到 10~30 分钟，或升级付费版
