/**
 * AI 套图前端客户端（唯一实现）
 * ------------------------------------------------------------------
 * 收敛说明：采集箱 / 批量上架 之前各自抄了一份「提交 → 轮询 → 回写」循环，
 * 这里统一成一处；页面只保留自己的响应式状态与提示。
 *
 * 依赖：window.axios（由 index.html 引入）
 * 用法：
 *   ImageSetClient.runOzonItem({ itemId, keys, onState })
 *     onState({ phase, processed, total, images, jobId })   ← 每次进度变化回调
 *   返回 { status: 'done'|'error'|'timeout', count, images, error }
 */
window.ImageSetClient = (function () {
  const TERMINAL = ['done', 'error', 'canceled'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 采集箱商品一键套图：提交 → 轮询 → 成功后写回 collect_items 图片
   * @param {object} opts
   * @param {string} opts.itemId   采集项 id（UUID）
   * @param {string[]} [opts.keys] 只生成部分模板
   * @param {number} [opts.total]  预期张数（仅用于进度显示）
   * @param {number} [opts.intervalMs]
   * @param {number} [opts.maxRounds]
   * @param {function} [opts.onState]
   */
  async function runOzonItem(opts) {
    const itemId = String(opts?.itemId || '');
    if (!itemId) throw new Error('缺少采集项 ID');
    const intervalMs = Number(opts?.intervalMs || 10000);
    const maxRounds = Number(opts?.maxRounds || 80);
    const emit = (patch) => { try { opts?.onState?.(patch); } catch (_e) {} };

    emit({ phase: '正在提交出图任务…', processed: 0, total: Number(opts?.total || 7), images: [], error: '' });
    const submit = await axios.post('/api/ozon/ai-image-set', { itemId, keys: opts?.keys || null }, { timeout: 60000 });
    const jobId = submit.data?.jobId || '';
    if (!jobId) throw new Error(submit.data?.error || '出图服务没有返回任务号');
    emit({ jobId, phase: '已提交，排队等待生成…' });

    for (let i = 0; i < maxRounds; i += 1) {
      await sleep(intervalMs);
      const jr = await axios.get('/api/image-set/jobs/' + encodeURIComponent(jobId), { timeout: 30000 });
      const job = jr.data?.job || {};
      const images = (job.images || []).filter((x) => x.ok && x.url).map((x) => x.url);
      emit({
        jobId,
        phase: `${job.phase || '生成中'}（成功 ${images.length}/${Number(job.total || opts?.total || 7)}）`,
        processed: Number(job.processed || images.length || 0),
        total: Number(job.total || opts?.total || 7),
        images,
      });
      if (!TERMINAL.includes(job.status)) continue;

      if (job.status !== 'done') {
        const error = String(job.error || job.phase || '生成失败');
        emit({ error });
        return { status: job.status === 'canceled' ? 'canceled' : 'error', count: images.length, images, error };
      }
      const ap = await axios.post(`/api/ozon/ai-image-set/${encodeURIComponent(jobId)}/apply`, { itemId, mode: 'all' }, { timeout: 60000 });
      const count = Number(ap.data?.count || images.length);
      emit({ phase: `✓ 已写入商品图片（共 ${count} 张，主图置首）`, images, error: '' });
      return { status: 'done', count, images };
    }
    const error = '出图超时（超过 ' + Math.round((intervalMs * maxRounds) / 60000) + ' 分钟仍未完成）';
    emit({ error });
    return { status: 'timeout', count: 0, images: [], error };
  }

  return { runOzonItem };
})();
