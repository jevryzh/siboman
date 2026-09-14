#!/usr/bin/env node
// 价格守护：检测「大批商品被外部程序把价格压到基准价 50% 以下」→ 自动回滚 + 发邮件
// 背景：某个同时能访问 Ozon/Yandex 的外部程序每晚会把 Yandex 价格改成 Ozon 价（降幅常 >50%），
//       而 Yandex 的防错价保护会因此把商品自动禁售（DISABLED_AUTOMATICALLY / Цена сильно снизилась）。
// 用法：node scripts/price-guard.mjs [--dry-run]
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import tls from "node:tls";

const APP_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENV_FILE = process.env.PRICE_GUARD_ENV || path.join(APP_DIR, ".env");
const BASELINE_FILE = process.env.PRICE_GUARD_BASELINE || path.join(APP_DIR, "data", "price_baseline.json");
const LOG_FILE = process.env.PRICE_GUARD_LOG || path.join(APP_DIR, "logs", "price-guard.log");
const DRY = process.argv.includes("--dry-run") || /^(1|true|yes)$/i.test(process.env.PRICE_GUARD_DRY_RUN || "");
const MIN_COUNT = Math.max(1, Number(process.env.PRICE_GUARD_MIN_COUNT || 25));
const DROP_RATIO = Math.min(0.99, Math.max(0.1, Number(process.env.PRICE_GUARD_DROP_RATIO || 0.51)));
const COOLDOWN_MS = Math.max(60_000, Number(process.env.PRICE_GUARD_COOLDOWN_MS || 60 * 60 * 1000));

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_e) {}
};
const readEnv = (file) => {
  const out = {};
  try { for (const l of fs.readFileSync(file, "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) out[m[1]] = m[2].trim(); } } catch (_e) {}
  return out;
};
const env = readEnv(ENV_FILE);
const SECRET = String(process.env.YANDEX_MARKET_API_SECRET || env.YANDEX_MARKET_API_SECRET || "").trim();
const BIZ = String(process.env.YANDEX_MARKET_BUSINESS_ID || env.YANDEX_MARKET_CLIENT_ID || "216994951").trim();
if (!SECRET) { log("缺少 YANDEX_MARKET_API_SECRET，退出"); process.exit(0); }

const yReq = (method, apiPath, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : "";
  const r = https.request({ host: "api.partner.market.yandex.ru", path: apiPath, method, family: 4, timeout: 120000,
    headers: { "Api-Key": SECRET, "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } },
    (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => { try { resolve(JSON.parse(t)); } catch { resolve({}); } }); });
  r.on("error", reject); if (data) r.write(data); r.end();
});

async function sendMail({ subject, text }) {
  const host = String(process.env.ALERT_SMTP_HOST || env.ALERT_SMTP_HOST || "").trim();
  const user = String(process.env.ALERT_SMTP_USER || env.ALERT_SMTP_USER || "").trim();
  const pass = String(process.env.ALERT_SMTP_PASS || env.ALERT_SMTP_PASS || "").trim();
  const port = Number(process.env.ALERT_SMTP_PORT || env.ALERT_SMTP_PORT || 465) || 465;
  const from = String(process.env.ALERT_MAIL_FROM || env.ALERT_MAIL_FROM || user).trim();
  const to = String(process.env.ALERT_MAIL_TO || env.ALERT_MAIL_TO || "").trim();
  if (!host || !user || !pass || !to) return { ok: false, error: "SMTP 未配置" };
  const enc = (s) => `=?UTF-8?B?${Buffer.from(String(s), "utf8").toString("base64")}?=`;
  const bodyB64 = Buffer.from(String(text || ""), "utf8").toString("base64");
  const message = [
    `From: ${enc("逐梦ERP价格守护")} <${from}>`, `To: <${to}>`, `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
    (bodyB64.match(/.{1,76}/g) || []).join("\r\n"), "",
  ].join("\r\n");
  return await new Promise((resolve) => {
    let settled = false; let socket = null;
    const done = (r) => { if (settled) return; settled = true; try { socket?.destroy(); } catch (_e) {} resolve(r); };
    const script = [
      { send: null, expect: [220] }, { send: "EHLO zhumeng-price-guard", expect: [250] },
      { send: "AUTH LOGIN", expect: [334] }, { send: Buffer.from(user).toString("base64"), expect: [334] },
      { send: Buffer.from(pass).toString("base64"), expect: [235] }, { send: `MAIL FROM:<${from}>`, expect: [250] },
      { send: `RCPT TO:<${to}>`, expect: [250, 251] }, { send: "DATA", expect: [354] },
      { send: `${message}\r\n.`, expect: [250] }, { send: "QUIT", expect: [221, 250] },
    ];
    let step = 0; let buf = ""; let lines = [];
    socket = tls.connect({ host, port, servername: host, timeout: 20000 });
    socket.setEncoding("utf8");
    const runStep = () => { if (step >= script.length) return done({ ok: true }); const cur = script[step]; if (cur.send !== null) socket.write(`${cur.send}\r\n`); };
    const reply = (code, ls) => {
      const exp = script[step]?.expect || [];
      if (!exp.includes(code)) return done({ ok: false, error: `SMTP step ${step} got ${code} ${ls[0] || ""}`.slice(0, 200) });
      step += 1; lines = []; runStep();
      if (step >= script.length) done({ ok: true });
    };
    socket.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const m = line.match(/^(\d{3})([ -])(.*)$/);
        if (!m) continue;
        lines.push(line);
        if (m[2] === " ") { const code = Number(m[1]); const ls = lines.slice(); lines = []; reply(code, ls); }
      }
    });
    socket.on("error", (e) => done({ ok: false, error: String(e.message).slice(0, 200) }));
    socket.on("timeout", () => done({ ok: false, error: "SMTP 超时" }));
    socket.on("connect", () => { /* 等 220 */ });
  });
}

const main = async () => {
  if (!fs.existsSync(BASELINE_FILE)) { log(`基准文件不存在：${BASELINE_FILE}，退出`); return; }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  const ids = Object.keys(baseline);
  if (!ids.length) { log("基准为空，退出"); return; }
  const cur = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const j = await yReq("POST", `/v2/businesses/${encodeURIComponent(BIZ)}/offer-prices`, { offerIds: ids.slice(i, i + 200) });
    for (const o of (j?.result?.offers || [])) cur.set(String(o.offerId), Number(o.price?.value || 0));
  }
  const dropped = [];
  for (const id of ids) {
    const want = Number(baseline[id].price || baseline[id] || 0);
    const now = cur.get(id);
    if (!(want > 0) || now === undefined || !(now > 0)) continue;
    if (now < want * DROP_RATIO) dropped.push({ id, from: now, to: want });
  }
  log(`巡检：基准 ${ids.length} 个，读到现价 ${cur.size} 个，被压价 >${Math.round((1 - DROP_RATIO) * 100)}% 的 ${dropped.length} 个`);
  if (dropped.length < MIN_COUNT) { log(`未达触发阈值（${MIN_COUNT}），本次不处理`); return; }
  const sample = dropped.slice(0, 8).map((x) => `  · ${x.id}: ${x.from} → 恢复 ${x.to}`).join("\n");
  if (DRY) { log(`[dry-run] 将回滚 ${dropped.length} 个\n${sample}`); return; }
  let ok = 0, fail = 0;
  for (let i = 0; i < dropped.length; i += 200) {
    const chunk = dropped.slice(i, i + 200);
    const r = await yReq("POST", `/v2/businesses/${encodeURIComponent(BIZ)}/offer-prices/updates`, {
      offers: chunk.map((x) => ({ offerId: x.id, price: { value: x.to, currencyId: "CNY", discountBase: Math.ceil(x.to * 2) } })),
    });
    if (r?.status === "OK") ok += chunk.length; else fail += chunk.length;
    await new Promise((r2) => setTimeout(r2, 400));
  }
  for (let i = 0; i < dropped.length; i += 200) await yReq("POST", `/v2/businesses/${encodeURIComponent(BIZ)}/offer-prices/price-quarantine/confirm`, { offerIds: dropped.slice(i, i + 200).map((x) => x.id) }).catch(() => {});
  await yReq("POST", `/v2/businesses/${encodeURIComponent(BIZ)}/price-quarantine/confirm`, { offerIds: dropped.slice(0, 200).map((x) => x.id) }).catch(() => {});
  log(`已回滚 ${ok} 个（失败 ${fail}）`);
  const stateFile = path.join(APP_DIR, "data", "price_guard_state.json");
  let last = 0; try { last = Number(JSON.parse(fs.readFileSync(stateFile, "utf8")).lastMailAt || 0); } catch (_e) {}
  const now = Date.now();
  if (now - last < COOLDOWN_MS) { log("距上次邮件不足冷却时间，跳过发信"); return; }
  const mail = await sendMail({
    subject: `⚠️ Yandex 价格被外部程序压价，已自动回滚 ${ok} 个`,
    text: [
      `检测到 ${dropped.length} 个商品的 Yandex 售价被压到基准价的 ${Math.round(DROP_RATIO * 100)}% 以下（典型特征：等于 Ozon 售价）。`,
      `已自动回滚 ${ok} 个（失败 ${fail}），并确认价格隔离区。`,
      "", "样例：", sample, "",
      `时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      `完整日志：${LOG_FILE}`,
      "", "提醒：这次回滚只解决价格，若商品仍被隐藏，多半是 Extra Small 仓限制（价格 >1500₽ 或 重量 >500g）需要另开配送方式。",
    ].join("\n"),
  });
  log(`邮件发送：${JSON.stringify(mail).slice(0, 160)}`);
  try { fs.writeFileSync(stateFile, JSON.stringify({ lastMailAt: now, lastRunAt: now, lastRolledBack: ok, lastDropped: dropped.length })); } catch (_e) {}
};

main().catch((e) => { log(`异常：${String(e?.stack || e).slice(0, 400)}`); process.exit(0); });
