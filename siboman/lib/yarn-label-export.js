import { PDFDocument } from "pdf-lib";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Accio Work (2026-11-06)
// 背景：Ozon /v2/posting/fbs/package-label 是逐单接口，独立限流，192 单导出必然撞
//   HTTP 429 "You have reached request rate limit per second"。
//   旧实现（Codex）命中 429 后只做有限重试，一旦某个货件重试耗尽就整体 throw，
//   导致跑了 8 分多钟的标签全部丢弃（日志里 20:11、21:00 两次都是这个原因）。
// 本次改动（Accio Work）：
//   1. 自适应限速：命中 429 就把请求间隔翻倍（2s→4s→8s…上限 30s），且只升不降；
//   2. 重试预算提高到 15 次，退避 20s 起、上限 180s，并优先遵守 Retry-After；
//   3. 单个货件重试耗尽后不再立即中断：记录失败、继续跑完，最后对失败项做一轮
//      「冷却后补抓」（默认冷却 120s）；
//   4. allowPartial（默认 true，由服务端显式传入）：补抓仍失败时保留已取到的标签，
//      生成 PDF 并在结果上挂 missing 列表，而不是整份作废。
export async function buildOrderedYarnLabels(postings, options) {
  const {
    baseUrl,
    clientId,
    apiKey,
    fetchImpl = fetch,
    onProgress = () => {},
    sleep = pause,
    allowPartial = false,
    retryPassCooldownMs = 120000,
    maxAttempts = 15,
  } = options;

  const slots = new Array(postings.length);
  let cursor = 0;
  let completed = 0;
  let rateLimited = 0;
  const failures = [];
  let requestedAt = 0;
  let requestInterval = 2000;

  const pace = async () => {
    // Accio Work：全局节流按「距上次请求的真实间隔」计算，命中 429 后间隔翻倍且不回落
    const wait = requestInterval - (Date.now() - requestedAt);
    if (wait > 0) await sleep(wait);
    requestedAt = Date.now();
  };

  const backoffFor = (response, attempt) => {
    const retryAfter = response.headers.get("retry-after");
    const seconds = Number(retryAfter);
    const fromHeader = retryAfter
      ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now())
      : 0;
    const exponential = Math.min(180000, 20000 * 1.6 ** (attempt - 1));
    return Math.max(fromHeader > 0 ? Math.min(300000, fromHeader) : 0, exponential);
  };

  const fetchOne = async (posting) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await pace();
        const response = await fetchImpl(`${baseUrl}/v2/posting/fbs/package-label`, {
          method: "POST",
          headers: {
            "Client-Id": clientId,
            "Api-Key": apiKey,
            "Content-Type": "application/json",
            Accept: "application/pdf, application/json",
          },
          body: JSON.stringify({ posting_number: [posting] }),
          signal: AbortSignal.timeout(45000),
        });
        const body = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get("content-type") || "";
        if (response.ok && !contentType.includes("json") && body.subarray(0, 4).toString() === "%PDF") return body;

        if (response.status === 429) {
          rateLimited += 1;
          // Accio Work：命中限流立即降速，后续所有请求都受益，避免反复撞线
          requestInterval = Math.min(30000, requestInterval * 2);
          onProgress({ completed, total: postings.length, rateLimited, intervalMs: requestInterval });
          if (attempt < maxAttempts) {
            await sleep(backoffFor(response, attempt));
            continue;
          }
        }
        throw new Error(`HTTP ${response.status}: ${body.toString("utf8").slice(0, 160)}`);
      } catch (error) {
        if (error.message?.startsWith("HTTP ")) throw error;
        if (attempt >= maxAttempts) throw new Error(`请求失败或超时：${String(error.message || error).slice(0, 160)}`);
        await sleep(Math.min(15000, 1500 * 2 ** (attempt - 1)));
      }
    }
    throw new Error("未返回标签");
  };

  const worker = async () => {
    while (cursor < postings.length) {
      const index = cursor++;
      try {
        slots[index] = await fetchOne(postings[index]);
      } catch (error) {
        // Accio Work：单件失败不再中断整批，先记下来继续跑
        failures.push({ posting: postings[index], index, error: String(error.message || error).slice(0, 160) });
      }
      completed += 1;
      onProgress({ completed, total: postings.length, rateLimited, intervalMs: requestInterval });
    }
  };
  await worker();

  // Accio Work：冷却一段时间后只补抓失败项，命中过 429 的情况下这里通常能捞回来
  if (failures.length) {
    await sleep(retryPassCooldownMs);
    const pending = failures.splice(0, failures.length);
    for (const item of pending) {
      try {
        slots[item.index] = await fetchOne(item.posting);
      } catch (error) {
        failures.push({ posting: item.posting, index: item.index, error: String(error.message || error).slice(0, 160) });
      }
    }
  }

  const missing = failures.map((f) => f.posting);
  if (failures.length && !allowPartial) {
    throw new Error(
      `货件 ${failures[0].posting} 获取标签失败：${failures[0].error}。共 ${failures.length} 单未取到，没有生成不完整的 PDF。`,
    );
  }

  const output = await PDFDocument.create();
  for (const buffer of slots) {
    if (!buffer) continue;
    const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach((page) => output.addPage(page));
  }
  const pdf = Buffer.from(await output.save());
  // Accio Work：把未取到的货件号挂在结果上，服务端写入 job.missing，前端可提示
  pdf.missing = missing;
  pdf.rateLimited = rateLimited;
  return pdf;
}
