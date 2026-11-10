// 订单同步引擎（2026-11-10 v4）
// -----------------------------------------------------------------------------
// 五个按状态同步的步骤 + 兜底收口 + 跟踪池 + 月度全量。
// 每个步骤都是独立的 cron 任务（app_cron_runs 里一条一条记录），
// 所以「定时任务」弹窗里能看到每一步的频率和上次执行时间。
//
// 设计原则（务必保留注释，否则后面会被"优化"坏）：
//   1. 终态（cancelled / delivered）显式拉状态列表，不靠推断
//   2. 在途状态必须全量拉，绝不抽样 —— 抽样会让兜底差集误判
//   3. 兜底收口只在本轮该状态"完整翻完"时才做
// -----------------------------------------------------------------------------
import { startCronRun, finishCronRun } from './cron-registry.js';

export const SYNC_TASKS = {
  new: { key: 'order_sync_new', title: '订单同步 · 新单', windowDays: null },
  pending: { key: 'order_sync_pending', title: '订单同步 · 待处理', windowDays: 30 },
  cancelled: { key: 'order_sync_cancelled', title: '订单同步 · 取消', windowDays: 30 },
  delivering: { key: 'order_sync_delivering', title: '订单同步 · 运输中', windowDays: 30 },
  delivered: { key: 'order_sync_delivered', title: '订单同步 · 签收', windowDays: 30 },
  watchpool: { key: 'order_sync_watchpool', title: '订单同步 · 跟踪池', windowDays: null },
  monthly: { key: 'order_sync_monthly', title: '订单同步 · 月度全量', windowDays: 90 },
};

const PENDING_STATUSES = ['awaiting_packaging', 'awaiting_deliver', 'acceptance_in_progress'];
const PAGE_SIZE = 100;
// 北京时间「今天」，用于把取消日期写成结算日期
const shanghaiToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

export function createOrderSync({ db, listPage, getPosting, logger = console }) {
  const running = new Map();   // `${storeId}:${task}` → true
  const lastMinute = { daily: '', monthly: '' };

  const q = (text, params) => db.query(text, params);

  // ---------- 建表 ----------
  async function init() {
    await q(`
      CREATE TABLE IF NOT EXISTS app_order_sync_state (
        store_id UUID PRIMARY KEY REFERENCES app_stores(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        orders_watermark TIMESTAMPTZ,
        last_run_at TIMESTAMPTZ,
        last_ok_at TIMESTAMPTZ,
        last_error TEXT NOT NULL DEFAULT '',
        stats JSONB NOT NULL DEFAULT '{}'::jsonb
      )`);
    await q(`ALTER TABLE app_order_cache ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMPTZ`);
    await q(`ALTER TABLE app_order_cache ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ`);
    await q(`CREATE INDEX IF NOT EXISTS idx_order_cache_open ON app_order_cache(store_id, status, status_checked_at)`);
    await q(`
      CREATE TABLE IF NOT EXISTS app_order_watch_pool (
        store_id UUID NOT NULL,
        user_id UUID NOT NULL,
        posting_number TEXT NOT NULL,
        status_at_entry TEXT NOT NULL DEFAULT '',
        status_now TEXT NOT NULL DEFAULT '',
        entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_checked_at TIMESTAMPTZ,
        check_count INT NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (store_id, posting_number)
      )`);
  }

  // ---------- 工具 ----------
  async function activeStores() {
    const r = await q(`SELECT id, user_id FROM app_stores WHERE platform='ozon' AND active=TRUE ORDER BY created_at`);
    return r.rows;
  }

  async function getState(storeId) {
    const r = await q(`SELECT * FROM app_order_sync_state WHERE store_id=$1`, [storeId]);
    return r.rows[0] || null;
  }

  async function saveState(storeId, userId, patch) {
    await q(
      `INSERT INTO app_order_sync_state (store_id, user_id, orders_watermark, last_run_at, last_ok_at, last_error, stats)
       VALUES ($1,$2,$3,now(),$4,$5,$6::jsonb)
       ON CONFLICT (store_id) DO UPDATE SET
         orders_watermark = COALESCE(EXCLUDED.orders_watermark, app_order_sync_state.orders_watermark),
         last_run_at = now(),
         last_ok_at = COALESCE(EXCLUDED.last_ok_at, app_order_sync_state.last_ok_at),
         last_error = EXCLUDED.last_error,
         stats = EXCLUDED.stats`,
      [storeId, userId, patch.watermark || null, patch.okAt || null, patch.error || "", JSON.stringify(patch.stats || {})],
    );
  }

  // 翻完一个状态（或一个时间窗）的全部页；complete 表示是否完整
  async function listAll({ storeId, userId, status, since, to, maxPages = 300 }) {
    const postings = [];
    let cursor = "", pages = 0, complete = false;
    for (let i = 0; i < maxPages; i += 1) {
      const r = await listPage({
        since: since.toISOString(), to: to.toISOString(), status,
        limit: PAGE_SIZE, cursor,
        with: { financial_data: true, analytics_data: true },
        storeId, userId,
      });
      const batch = r.postings || [];
      postings.push(...batch);
      pages += 1;
      if (!r.has_next || !r.cursor || batch.length < PAGE_SIZE) { complete = true; break; }
      cursor = r.cursor;
    }
    return { postings, pages, complete };
  }

  // 补商品图/名称/1688 链接（列表页要显示；只补空字段，不覆盖 Ozon 原始值）
  async function enrich(postings) {
    const offers = [...new Set(postings.flatMap((p) => (p.products || []).map((x) => x.offer_id)).filter(Boolean))];
    if (!offers.length) return postings;
    const r = await q(
      `SELECT DISTINCT ON (offer_id) offer_id, image, name, source_url_1688
         FROM app_products WHERE offer_id = ANY($1::text[])
        ORDER BY offer_id, (image IS NULL OR image = '') ASC`,
      [offers],
    );
    const map = new Map(r.rows.map((x) => [String(x.offer_id), x]));
    for (const p of postings) {
      for (const pd of (p.products || [])) {
        const m = map.get(String(pd.offer_id || ""));
        if (!m) continue;
        if (!pd.image && m.image) pd.image = m.image;
        if (!pd.name && m.name) pd.name = m.name;
        if (!pd.source_url_1688 && m.source_url_1688) pd.source_url_1688 = m.source_url_1688;
      }
    }
    return postings;
  }

  // 批量 upsert 一页（jsonb_to_recordset，一页一条 SQL）
  async function upsertPage(storeId, userId, rows) {
    const list = (rows || []).filter((r) => r && r.posting_number);
    if (!list.length) return { inserted: 0, updated: 0, changed: 0 };
    const numbers = list.map((r) => String(r.posting_number));
    const old = await q(
      `SELECT posting_number, status FROM app_order_cache WHERE store_id=$1 AND posting_number = ANY($2::text[])`,
      [storeId, numbers],
    );
    const oldMap = new Map(old.rows.map((r) => [String(r.posting_number), String(r.status)]));
    const records = list.map((r) => ({
      posting_number: String(r.posting_number),
      status: String(r.status || ""),
      substatus: String(r.substatus || ""),
      in_process_at: r.in_process_at || null,
      shipment_date: r.shipment_date || null,
      delivering_date: r.delivering_date || null,
      payload: r,
    }));
    const res = await q(
      `INSERT INTO app_order_cache
         (user_id, store_id, posting_number, status, display_status, substatus,
          in_process_at, shipment_date, delivering_date, payload, synced_at, status_checked_at, updated_at)
       SELECT $1, $2, x.posting_number, x.status, x.status, x.substatus,
              x.in_process_at, x.shipment_date, x.delivering_date, x.payload::jsonb, now(), now(), now()
         FROM jsonb_to_recordset($3::jsonb)
              AS x(posting_number text, status text, substatus text,
                   in_process_at timestamptz, shipment_date timestamptz, delivering_date timestamptz,
                   payload jsonb)
       ON CONFLICT (store_id, posting_number) DO UPDATE SET
         status = EXCLUDED.status,
         display_status = EXCLUDED.display_status,
         substatus = EXCLUDED.substatus,
         in_process_at = EXCLUDED.in_process_at,
         shipment_date = EXCLUDED.shipment_date,
         delivering_date = EXCLUDED.delivering_date,
         payload = EXCLUDED.payload,
         synced_at = now(),
         status_checked_at = now(),
         updated_at = now()
       RETURNING (xmax = 0) AS is_new, posting_number, status`,
      [userId, storeId, JSON.stringify(records)],
    );
    let inserted = 0, updated = 0;
    const changedNumbers = [];
    const becameCancelled = [];
    for (const row of res.rows) {
      if (row.is_new) inserted += 1; else updated += 1;
      const before = oldMap.get(String(row.posting_number));
      const afterStatus = String(row.status || '');
      if (before !== undefined && before !== afterStatus) changedNumbers.push(String(row.posting_number));
      // 2026-11-10 取消单要落结算日期：规则与月结统计（lib/statistics-analysis.js saveOrders）一致 ——
      //   只在「从非取消变成取消」时写，且只写 settled_date 为空的，值是检测到取消的当天（北京时间）。
      //   Ozon 不返回取消时间（cancellation 里只有原因/类型/发起方），所以只能取"我们发现的那天"。
      const beforeCancelled = before !== undefined && String(before).startsWith('cancelled');
      if (afterStatus.startsWith('cancelled') && !beforeCancelled) becameCancelled.push(String(row.posting_number));
    }
    if (changedNumbers.length) {
      await q(
        `UPDATE app_order_cache SET status_changed_at = now()
          WHERE store_id=$1 AND posting_number = ANY($2::text[])`,
        [storeId, changedNumbers],
      );
    }
    if (becameCancelled.length) {
      const set = new Set(becameCancelled);
      const payloads = records.filter((r) => set.has(r.posting_number)).map((r) => ({ posting_number: r.posting_number, payload: r.payload }));
      try {
        await q(
          `INSERT INTO app_statistics_orders (user_id, store_id, posting_number, payload, settled_date)
           SELECT $1, $2, x.posting_number, x.payload, $4::date
             FROM jsonb_to_recordset($3::jsonb) AS x(posting_number text, payload jsonb)
           ON CONFLICT (user_id, store_id, posting_number) DO UPDATE
             SET settled_date = COALESCE(app_statistics_orders.settled_date, EXCLUDED.settled_date),
                 updated_at = now()`,
          [userId, storeId, JSON.stringify(payloads), shanghaiToday()],
        );
      } catch (e) {
        // 统计表可能还没建（极端情况）；不影响订单缓存本身
        logger.warn?.('[order-sync] 取消日期写入失败', String(e.message || e).slice(0, 160));
      }
    }
    return { inserted, updated, changed: changedNumbers.length, cancelled: becameCancelled.length };
  }

  // ---------- 步骤 1：新单增量（水位线） ----------
  async function syncNew(storeId, userId, trigger = 'cron') {
    const state = await getState(storeId);
    const now = new Date();
    const anchor = state?.orders_watermark ? new Date(state.orders_watermark).getTime() : 0;
    const minAnchor = now.getTime() - 7 * 86400e3;   // 水位线最多回溯 7 天
    const since = new Date(Math.max(minAnchor, (anchor || now.getTime() - 24 * 3600e3) - 3600e3));
    const { postings, pages, complete } = await listAll({ storeId, userId, status: 'all', since, to: now });
    await enrich(postings);
    const stat = { pages, listed: postings.length, inserted: 0, updated: 0, changed: 0, cancelled: 0 };
    for (let i = 0; i < postings.length; i += PAGE_SIZE) {
      const r = await upsertPage(storeId, userId, postings.slice(i, i + PAGE_SIZE));
      stat.inserted += r.inserted; stat.updated += r.updated; stat.changed += r.changed;
      stat.cancelled = (stat.cancelled || 0) + (r.cancelled || 0);
    }
    if (complete) await saveState(storeId, userId, { watermark: now, okAt: new Date(), stats: stat });
    else await saveState(storeId, userId, { error: '新单同步未完整翻完，水位线不推进', stats: stat });
    return { ...stat, complete };
  }

  // ---------- 步骤 2/3/4/5：按状态同步（待处理/取消/运输中/签收 共用） ----------
  async function syncByStatus(storeId, userId, statuses, windowDays, task = 'status') {
    const now = new Date();
    const since = new Date(now.getTime() - windowDays * 86400e3);
    const stat = { task, window_days: windowDays, pages: 0, listed: 0, inserted: 0, updated: 0, changed: 0, cancelled: 0, complete: true };
    const seen = new Set();
    for (const status of statuses) {
      const r = await listAll({ storeId, userId, status, since, to: now, maxPages: 400 });
      await enrich(r.postings);
      for (const p of r.postings) if (p.posting_number) seen.add(String(p.posting_number));
      for (let i = 0; i < r.postings.length; i += PAGE_SIZE) {
        const u = await upsertPage(storeId, userId, r.postings.slice(i, i + PAGE_SIZE));
        stat.inserted += u.inserted; stat.updated += u.updated; stat.changed += u.changed;
        stat.cancelled += (u.cancelled || 0);
      }
      stat.pages += r.pages;
      stat.listed += r.postings.length;
      if (!r.complete) stat.complete = false;
    }
    return { stat, seen, complete: stat.complete };
  }

  // ---------- 步骤 6：兜底收口 ----------
  // 只处理「本地在途 + 本轮该状态完整拉过 + 没出现」的单，逐单 get 确认真实终态
  async function closing(storeId, userId, statuses, seen, layerComplete, { maxCheck = 200 } = {}) {
    const base = { checked: 0, fixed: 0, skipped: false, reason: '' };
    if (!layerComplete) return { ...base, skipped: true, reason: '上一层未完整翻完，跳过收口' };
    const local = await q(
      `SELECT posting_number, status FROM app_order_cache WHERE store_id=$1 AND status = ANY($2::text[])`,
      [storeId, statuses],
    );
    const candidates = local.rows.filter((r) => !seen.has(String(r.posting_number)));
    if (!candidates.length) return base;
    if (local.rows.length && candidates.length > local.rows.length * 0.3) {
      return { ...base, skipped: true, reason: `消失 ${candidates.length}/${local.rows.length} 超过 30%，判为拉取异常` };
    }
    const todo = candidates.slice(0, maxCheck);
    for (const row of todo) {
      try {
        const full = await getPosting(String(row.posting_number), storeId, userId);
        if (!full) continue;
        await enrich([full]);
        await upsertPage(storeId, userId, [full]);
        base.checked += 1;
        if (String(full.status || "") !== String(row.status || "")) base.fixed += 1;
      } catch (e) {
        logger.warn?.('[order-sync] closing get failed', row.posting_number, String(e.message || e).slice(0, 120));
      }
    }
    if (candidates.length > todo.length) base.reason = `还有 ${candidates.length - todo.length} 单留到下一轮`;
    return base;
  }

  // ---------- 步骤 7：跟踪池（超 30 天仍在运输中） ----------
  async function syncWatchPool(storeId, userId) {
    const entered = await q(
      `INSERT INTO app_order_watch_pool (store_id, user_id, posting_number, status_at_entry, status_now)
       SELECT $1, $2, posting_number, status, status
         FROM app_order_cache
        WHERE store_id=$1 AND status='delivering'
          AND delivering_date IS NOT NULL AND delivering_date < now() - interval '30 days'
       ON CONFLICT (store_id, posting_number) DO NOTHING
       RETURNING posting_number`,
      [storeId, userId],
    );
    const pool = await q(
      `SELECT posting_number, status_now, entered_at FROM app_order_watch_pool WHERE store_id=$1`,
      [storeId],
    );
    let checked = 0, released = 0, unresolved = 0;
    for (const row of pool.rows) {
      try {
        const full = await getPosting(String(row.posting_number), storeId, userId);
        if (!full) { unresolved += 1; continue; }
        await enrich([full]);
        await upsertPage(storeId, userId, [full]);
        checked += 1;
        const nowStatus = String(full.status || "");
        if (nowStatus !== String(row.status_now || "")) {
          await q(`DELETE FROM app_order_watch_pool WHERE store_id=$1 AND posting_number=$2`, [storeId, row.posting_number]);
          released += 1;
        } else {
          await q(
            `UPDATE app_order_watch_pool
                SET last_checked_at=now(), check_count=check_count+1, status_now=$3,
                    note = CASE WHEN entered_at < now() - interval '60 days' THEN '疑似丢件' ELSE note END
              WHERE store_id=$1 AND posting_number=$2`,
            [storeId, row.posting_number, nowStatus],
          );
        }
      } catch (e) {
        unresolved += 1;
        logger.warn?.('[order-sync] watchpool get failed', row.posting_number, String(e.message || e).slice(0, 120));
      }
    }
    const left = await q(`SELECT count(*)::int AS c FROM app_order_watch_pool WHERE store_id=$1`, [storeId]);
    return { added: entered.rowCount, checked, released, unresolved, pool: Number(left.rows[0]?.c || 0) };
  }

  // ---------- 组合执行 ----------
  async function runTask(taskKey, { storeIds = null, trigger = 'cron' } = {}) {
    const task = SYNC_TASKS[taskKey] || SYNC_TASKS.pending;
    if (running.get(taskKey)) return { skipped: true, reason: '上一轮还在跑' };
    running.set(taskKey, true);
    const q2 = (text, params) => db.query(text, params);
    const runId = await startCronRun(q2, task.key, trigger);
    const total = { task: taskKey, stores: 0, failed: 0, pages: 0, listed: 0, inserted: 0, updated: 0, changed: 0, closing_fixed: 0, closing_checked: 0, closing_ran: false, cancelled: 0, watch: null };
    try {
      const stores = storeIds ? storeIds.map((id) => ({ id })) : await activeStores();
      for (const store of stores) {
        const userId = store.user_id || (await q(`SELECT user_id FROM app_stores WHERE id=$1`, [store.id])).rows[0]?.user_id;
        if (!userId) continue;
        total.stores += 1;
        try {
          if (taskKey === 'new') {
            const r = await syncNew(store.id, userId, trigger);
            total.pages += r.pages; total.listed += r.listed;
            total.inserted += r.inserted; total.updated += r.updated; total.changed += r.changed;
            total.cancelled += (r.cancelled || 0);
          } else if (taskKey === 'watchpool') {
            const r = await syncWatchPool(store.id, userId);
            total.watch = total.watch || { added: 0, checked: 0, released: 0, pool: 0 };
            total.watch.added += r.added; total.watch.checked += r.checked;
            total.watch.released += r.released; total.watch.pool += r.pool;
          } else if (taskKey === 'monthly') {
            for (const statuses of [PENDING_STATUSES, ['delivering'], ['delivered'], ['cancelled']]) {
              const { stat, seen, complete } = await syncByStatus(store.id, userId, statuses, task.windowDays, 'monthly');
              total.pages += stat.pages; total.listed += stat.listed;
              total.inserted += stat.inserted; total.updated += stat.updated; total.changed += stat.changed;
              total.cancelled += (stat.cancelled || 0);
              const c = await closing(store.id, userId, statuses, seen, complete);
              total.closing_ran = true;
              total.closing_checked += c.checked;
              total.closing_fixed += c.fixed;
            }
            await syncWatchPool(store.id, userId);
          } else {
            const statuses = taskKey === 'cancelled' ? ['cancelled']
              : taskKey === 'delivering' ? ['delivering']
                : taskKey === 'delivered' ? ['delivered']
                  : PENDING_STATUSES;
            const { stat, seen, complete } = await syncByStatus(store.id, userId, statuses, task.windowDays, taskKey);
            total.pages += stat.pages; total.listed += stat.listed;
            total.inserted += stat.inserted; total.updated += stat.updated; total.changed += stat.changed;
            total.cancelled += (stat.cancelled || 0);
            // 兜底收口只对"在途类"状态做；取消/签收本身就是权威来源，不需要
            if (taskKey === 'pending' || taskKey === 'delivering' || taskKey === 'monthly') {
              const c = await closing(store.id, userId, statuses, seen, complete);
              total.closing_ran = true;
              total.closing_checked += c.checked;
              total.closing_fixed += c.fixed;
            }
          }
          if (taskKey !== 'new' && taskKey !== 'watchpool') {
            await saveState(store.id, userId, { okAt: new Date(), stats: total });
          }
        } catch (e) {
          total.failed += 1;
          await saveState(store.id, userId, { error: String(e.message || e).slice(0, 300) }).catch(() => {});
          logger.error?.('[order-sync]', taskKey, store.id, String(e.message || e).slice(0, 200));
        }
      }
      const summary = taskKey === 'watchpool'
        ? `池内 ${total.watch?.pool || 0} 单 · 新入池 ${total.watch?.added || 0} · 出池 ${total.watch?.released || 0} · 未变 ${total.watch?.checked || 0}`
        : `${total.stores} 店 · ${total.pages} 页 · 新增 ${total.inserted} · 更新 ${total.updated} · 状态变更 ${total.changed}${total.cancelled ? ` · 取消 ${total.cancelled}` : ''}${total.closing_fixed ? ` · 收口 ${total.closing_fixed}` : ''}${total.failed ? ` · ${total.failed} 店失败` : ''}`;
      await finishCronRun(q2, runId, {
        status: total.failed ? 'partial' : 'succeeded',
        summary,
        stats: total,
      });
      // 兜底收口单独记一条，让弹窗里能看到这个"步骤"的上次执行时间
      if (total.closing_ran && taskKey !== 'monthly') {
        const cid = await startCronRun(q2, 'order_sync_closing', trigger);
        await finishCronRun(q2, cid, {
          status: 'succeeded',
          summary: `核对 ${total.closing_checked} 单 · 纠正 ${total.closing_fixed} 单`,
          stats: { checked: total.closing_checked, fixed: total.closing_fixed, from: taskKey },
        });
      }
      return total;
    } catch (e) {
      await finishCronRun(q2, runId, { status: 'failed', summary: String(e.message || e).slice(0, 300), stats: total });
      throw e;
    } finally {
      running.delete(taskKey);
    }
  }

  // 手动「立即同步」= 步骤 1 + 2 + 3 + 兜底（一次跑完，同步返回结果）
  async function runQuick(storeIds) {
    const out = { new: null, pending: null, cancelled: null, closing_fixed: 0 };
    out.new = await runTask('new', { storeIds, trigger: 'manual' });
    out.pending = await runTask('pending', { storeIds, trigger: 'manual' });
    out.cancelled = await runTask('cancelled', { storeIds, trigger: 'manual' });
    out.closing_fixed = (out.pending?.closing_fixed || 0);
    return {
      inserted: (out.new?.inserted || 0) + (out.pending?.inserted || 0) + (out.cancelled?.inserted || 0),
      updated: (out.new?.updated || 0) + (out.pending?.updated || 0) + (out.cancelled?.updated || 0),
      changed: (out.new?.changed || 0) + (out.pending?.changed || 0) + (out.cancelled?.changed || 0),
      closing_fixed: out.closing_fixed,
      cancelled: (out.new?.cancelled || 0) + (out.cancelled?.cancelled || 0) + (out.pending?.cancelled || 0),
      stores: out.new?.stores || 0,
      failed: (out.new?.failed || 0) + (out.pending?.failed || 0) + (out.cancelled?.failed || 0),
    };
  }

  // ---------- 调度 ----------
  function start() {
    // 15 分钟：新单
    setInterval(() => runTask('new').catch(() => {}), 15 * 60 * 1000).unref?.();
    // 1 小时：待处理（2026-11-10 19:15 按用户要求从 15 分钟放宽到 60 分钟）
    //   注意：兜底收口（closing）挂在 pending 之后跑，所以老单状态核对也随之变成每小时一次；
    //   「待备货→待发运」这一段的变化最多晚 1 小时被发现。
    setInterval(() => runTask('pending').catch(() => {}), 60 * 60 * 1000).unref?.();
    // 2 小时：取消
    setInterval(() => runTask('cancelled').catch(() => {}), 2 * 60 * 60 * 1000).unref?.();
    // 12 小时：运输中、签收
    setInterval(() => runTask('delivering').catch(() => {}), 12 * 60 * 60 * 1000).unref?.();
    setInterval(() => runTask('delivered').catch(() => {}), 12 * 60 * 60 * 1000).unref?.();
    // 每天 05:00 跟踪池；每月最后一天 02:00 全量
    setInterval(() => {
      const now = new Date();
      const bj = new Date(now.getTime() + 8 * 3600e3);   // 服务器是 UTC，按北京时间判断
      const hour = bj.getUTCHours();
      const day = bj.getUTCDate();
      const dayKey = `${bj.getUTCFullYear()}-${bj.getUTCMonth() + 1}-${day}`;
      if (hour === 5 && lastMinute.daily !== dayKey) {
        lastMinute.daily = dayKey;
        runTask('watchpool', { trigger: 'schedule' }).catch(() => {});
      }
      const lastDay = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth() + 1, 0)).getUTCDate();
      if (day === lastDay && hour === 2 && lastMinute.monthly !== dayKey) {
        lastMinute.monthly = dayKey;
        runTask('monthly', { trigger: 'schedule' }).catch(() => {});
      }
    }, 60 * 1000).unref?.();
    // 启动 90 秒后先跑一轮基础同步（新单 + 待处理），避免重启后长时间空白
    setTimeout(() => {
      runTask('new', { trigger: 'startup' }).catch(() => {});
      setTimeout(() => runTask('pending', { trigger: 'startup' }).catch(() => {}), 30 * 1000);
    }, 90 * 1000).unref?.();
  }

  return { init, start, runTask, runQuick, syncWatchPool, getState, activeStores };
}
