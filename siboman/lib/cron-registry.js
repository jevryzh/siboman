// 后台定时任务登记 + 运行记录
// -----------------------------------------------------------------------------
// 目的：让前端能回答三个问题 —— 现在后台有哪些定时任务在跑？每个任务抓什么、什么条件？
//       上一次/上上一次跑出了什么结果？
//
// 设计：元信息（JOBS）写在代码里，是唯一事实来源；运行记录写 app_cron_runs 表。
// 只记录「真正干了活」的运行（例如结算同步在非计划时点直接 return 时不落库），
// 避免一天几千条噪音。
//
// 用法（在任务函数里）：
//   const runId = await startCronRun(query, 'order_status_refresh', 'schedule');
//   ...
//   await finishCronRun(query, runId, { status: 'succeeded', summary: '…', stats: {...} });
// -----------------------------------------------------------------------------

export const CRON_TABLE = 'app_cron_runs';

// 元信息：key 必须与调用 startCronRun 时传的一致
export const CRON_JOBS = [
  {
    key: 'order_sync_new',
    title: '订单同步 · 新单',
    type: 'backend',
    related: 'orders',
    schedule: '每 15 分钟',
    scope: '把 Ozon 上新产生的订单拉进本地订单缓存（app_order_cache）',
    condition:
      '范围：全部启用中的 Ozon 店铺，逐店串行；'
      + '窗口：上次成功同步时间 − 1 小时 → 现在（首次或断档时最多回溯 7 天，单轮上限 24 小时）；'
      + '过滤：status=all，按 in_process_at；'
      + '写入：新增订单 + 更新已有订单；全部页翻完才推进水位线，失败不推进（下次自动重试）',
    covers: ['新订单入库', '订单商品/金额同步'],
  },
  {
    key: 'order_sync_pending',
    title: '订单同步 · 待处理',
    type: 'backend',
    related: 'orders',
    schedule: '每 1 小时',
    scope: '待备货 / 待发运 / 审核中 三个状态的订单，保证「备货 → 发运」这一段跟上',
    condition:
      '状态：awaiting_packaging、awaiting_deliver、acceptance_in_progress，各拉一次；'
      + '窗口：近 30 天（按下单时间）；'
      + '写入：状态 + substatus + payload 全量覆盖，记录状态变化时间；'
      + '附带：本轮完整翻完后执行「兜底收口」（所以收口也随之每小时一次）；'
      + '说明：2026-11-10 19:15 按需求从每 15 分钟放宽到每小时',
    covers: ['待备货→待发运', '新单进入待备货', '审核状态变化'],
  },
  {
    key: 'order_sync_cancelled',
    title: '订单同步 · 取消',
    type: 'backend',
    related: 'orders',
    schedule: '每 2 小时',
    scope: '近 30 天被取消的订单（含取消原因、是否发货后取消）',
    condition:
      '状态：cancelled（显式拉取，不靠推断）；'
      + '窗口：近 30 天（按下单时间）—— 取消发生在下单之后很久，24 小时窗口只能覆盖 2 单；'
      + '写入：状态 + payload.cancellation（cancel_reason_id / cancelled_after_ship / 发起方）',
    covers: ['订单取消', '取消原因', '发货后取消'],
  },
  {
    key: 'order_sync_delivering',
    title: '订单同步 · 运输中',
    type: 'backend',
    related: 'orders',
    schedule: '每 12 小时',
    scope: '近 30 天运输中的订单（全量，不抽样）',
    condition:
      '状态：delivering；窗口：近 30 天；必须全量翻完（抽样会让兜底差集误判）；'
      + '写入：状态 + delivering_date；'
      + '附带：本轮完整翻完后执行「兜底收口」，把已经签收/取消但还挂在运输中的单纠正过来',
    covers: ['运输中→已送达', '运输中→已取消', '物流异常线索'],
  },
  {
    key: 'order_sync_delivered',
    title: '订单同步 · 签收',
    type: 'backend',
    related: 'orders',
    schedule: '每 12 小时',
    scope: '近 30 天已送达的订单',
    condition:
      '状态：delivered（显式拉取）；窗口：近 30 天；'
      + '说明：实测「8 天内下单且已送达」为 0 单（这条线签收要 8 天以上），所以按下单时间的窗口必须给到 30 天',
    covers: ['签收确认', '签收时间（delivering_date）'],
  },
  {
    key: 'order_sync_closing',
    title: '订单同步 · 兜底收口',
    type: 'backend',
    related: 'orders',
    schedule: '跟在「待处理 / 运输中」之后跑（每 1 小时 / 每 12 小时）',
    scope: '本地还在途、但本轮该状态完整拉取后没出现的单 —— 逐单确认真实终态',
    condition:
      '前提：该状态本轮必须完整翻完，否则跳过；'
      + '护栏：消失量 > 本地该状态 30% 判为拉取异常跳过；单轮上限 200 单；'
      + '写入：完整 payload（含取消原因），不能只写状态',
    covers: ['30 天前下单、近期取消', '30 天前下单、近期签收'],
  },
  {
    key: 'order_sync_watchpool',
    title: '订单同步 · 跟踪池',
    type: 'backend',
    related: 'orders',
    schedule: '每天 05:00（北京时间）',
    scope: '超过 30 天仍在运输中的订单（疑似丢件/异常），每天核一次状态',
    condition:
      '入池：status=delivering 且 delivering_date 早于 30 天前（当前约 238 单）；'
      + '每天逐单查 Ozon 真实状态；状态一变就更新订单并移出池子；'
      + '入池超过 60 天仍无变化 → 标记「疑似丢件」',
    covers: ['物流异常发现', '疑似丢件'],
  },
  {
    key: 'order_sync_monthly',
    title: '订单同步 · 月度全量',
    type: 'backend',
    related: 'orders',
    schedule: '每月最后一天 02:00（北京时间）',
    scope: '全部状态全量核对一遍（近 90 天）',
    condition:
      '窗口：90 天；依次跑 待处理 3 状态 / 运输中 / 已送达 / 已取消，每个状态跑完都做兜底收口；'
      + '最后再跑一次跟踪池；目的：月底把整月数据彻底对平',
    covers: ['月末对账', '历史状态纠正'],
  },
  {
    key: 'stats_order_sync',
    title: '统计口径订单同步',
    type: 'backend',
    related: 'statistics',
    schedule: '每 5 分钟检查一次；每店距上次 ≥ 30 分钟才真正执行',
    scope: '月结统计 / 应计原始数据用的订单表（app_statistics_orders、app_statistics_accruals）',
    condition:
      '范围：全部启用中的 Ozon 店铺；'
      + '窗口：从该店最早结算月至今（fbs + fbo 两套全量核对，单次分页上限 1000 页）；'
      + '附带：按天拉 Ozon 应计流水（/v1/finance/accrual/by-day），再与订单号做核对；'
      + '写入：app_statistics_orders / app_statistics_accruals（与订单页缓存是两套表）',
    covers: ['结算金额', '佣金/服务费', '订单-应计对账'],
  },
  {
    key: 'settlement_daily',
    title: '店铺结算日同步',
    type: 'backend',
    related: 'statistics',
    schedule: '每天 02:00、09:30（Asia/Shanghai）；每 60 秒检查是否到点',
    scope: '店铺月结 run + 应计流水增量',
    condition:
      '时点：只在 02:00 / 09:30 两个时点触发，其它时间检查后直接跳过（不产生记录）；'
      + '窗口：只补「昨天 → 今天」的增量，历史日期在 Ozon 侧已固化，不重拉；'
      + '跳过条件：该店当天已有成功 run 且时点已满足，或已有 1 小时内的排队/运行/失败任务；'
      + '并发：全局最多 2 个 run 同时跑',
    covers: ['昨日结算', '今日新增应计'],
  },
];

const JOB_BY_KEY = new Map(CRON_JOBS.map((job) => [job.key, job]));

export async function ensureCronTable(query) {
  await query(`
    CREATE TABLE IF NOT EXISTS ${CRON_TABLE} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_key TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'schedule',
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running',
      summary TEXT NOT NULL DEFAULT '',
      stats JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_cron_runs_key_time ON ${CRON_TABLE}(job_key, started_at DESC)`);
  // 服务重启会把正在跑的任务打断，留下永远 running 的孤儿记录 → 启动时统一标记为中断
  await query(`UPDATE ${CRON_TABLE} SET status='failed', summary='服务重启，任务被中断', finished_at=now() WHERE status='running'`);
}

// 开始一次运行；失败不影响主流程（定时任务不能因为记日志挂掉）
export async function startCronRun(query, jobKey, trigger = 'schedule') {
  try {
    const res = await query(
      `INSERT INTO ${CRON_TABLE} (job_key, trigger) VALUES ($1, $2) RETURNING id`,
      [jobKey, String(trigger || 'schedule')],
    );
    const id = res?.rows?.[0]?.id;
    // 顺手清理 7 天前的记录
    if (id) {
      query(`DELETE FROM ${CRON_TABLE} WHERE started_at < now() - interval '7 days'`).catch(() => {});
    }
    return id || null;
  } catch (error) {
    console.warn('[cron-registry] startCronRun failed:', String(error?.message || error).slice(0, 200));
    return null;
  }
}

export async function finishCronRun(query, runId, { status = 'succeeded', summary = '', stats = {} } = {}) {
  if (!runId) return;
  try {
    await query(
      `UPDATE ${CRON_TABLE}
          SET finished_at = now(), status = $2, summary = $3, stats = $4::jsonb
        WHERE id = $1`,
      [runId, status, String(summary || '').slice(0, 500), JSON.stringify(stats || {})],
    );
  } catch (error) {
    console.warn('[cron-registry] finishCronRun failed:', String(error?.message || error).slice(0, 200));
  }
}

// 读最近 N 次运行（每个任务单独取，条数很少，直接多次查询更简单）
export async function listCronJobs(query, { runsPerJob = 3 } = {}) {
  const out = [];
  for (const job of CRON_JOBS) {
    let runs = [];
    if (job.type === 'backend') {
      try {
        const res = await query(
          `SELECT id, trigger, started_at, finished_at, status, summary, stats
             FROM ${CRON_TABLE}
            WHERE job_key = $1
            ORDER BY started_at DESC
            LIMIT $2`,
          [job.key, Math.min(10, Math.max(1, runsPerJob))],
        );
        runs = res?.rows || [];
      } catch {
        runs = [];
      }
    }
    out.push({ ...job, runs });
  }
  return out;
}

export function isKnownJob(key) {
  return JOB_BY_KEY.has(String(key || ''));
}
