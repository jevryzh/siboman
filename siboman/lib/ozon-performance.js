import crypto from 'node:crypto';
import { datesBetween, fail, moneyCents } from './ozon-settlement.js';

const HOST = 'https://api-performance.ozon.ru';
export function sealCredential(value, secret) {
  if (!secret) throw fail('服务端未配置广告密钥加密参数', 503);
  const iv = crypto.randomBytes(12), key = crypto.createHash('sha256').update('statistics-performance:' + secret).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64url')).join('.');
}
export function openCredential(value, secret) {
  try {
    const [iv, tag, data] = value.split('.').map((s) => Buffer.from(s, 'base64url'));
    const key = crypto.createHash('sha256').update('statistics-performance:' + secret).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch { throw fail('广告授权无法解密，请重新保存授权', 503); }
}
function reportRows(body) {
  if (Array.isArray(body)) return body;
  for (const key of ['rows', 'list', 'report']) if (Array.isArray(body?.[key])) return body[key];
  if (body?.result && body.result !== body) return reportRows(body.result);
  throw fail('广告统计响应结构无法识别，未写入零费用', 502);
}
function reportMoney(value) {
  if (value == null || typeof value === 'boolean') throw fail('广告统计缺少金额', 502);
  const text = typeof value === 'string' ? value.trim().replace(/[ \u00a0\u202f]/g, '').replace(',', '.') : String(value);
  try { return moneyCents(text); } catch { throw fail('广告统计金额格式无效', 502); }
}
export function normalizePerformanceDaily(body, campaigns, start, end) {
  const days = new Map(datesBetween(start, end).map((date) => [date, { spend_date: date, cpo_rub: 0, cpc_rub: 0 }]));
  const campaignMap = new Map(campaigns.map((c) => [String(c.id), String(c.PaymentType || c.paymentType || c.payment_type || '').toUpperCase()]));
  const seen = new Set();
  for (const row of reportRows(body)) {
    const date = String(row.date || row.day || ''), id = String(row.id ?? row.campaignId ?? row.campaign_id ?? '');
    if (!days.has(date) || !campaignMap.has(id)) throw fail('广告统计日期或活动ID无法核对', 502);
    const key = date + ':' + id;
    if (seen.has(key)) throw fail('广告统计出现重复活动/日期，未重复计费', 502);
    seen.add(key);
    const type = campaignMap.get(id);
    if (!type) throw fail('广告活动缺少付费类型', 502);
    if (!['CPC', 'CPO', 'CPA', 'CPO_ALL'].includes(type)) continue;
    const amount = reportMoney(row.moneySpent ?? row.money_spent ?? row.expense);
    const day = days.get(date), field = type === 'CPC' ? 'cpc_rub' : 'cpo_rub';
    day[field] = (moneyCents(day[field]) + amount) / 100;
  }
  return [...days.values()];
}

export function createPerformanceClient({ clientId, clientSecret, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let token = '', expiresAt = 0;
  async function request(path, { method = 'GET', body, auth = true } = {}) {
    if (auth && (!token || Date.now() >= expiresAt)) {
      const response = await request('/api/client/token', { method: 'POST', auth: false,
        body: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' } });
      if (typeof response.access_token !== 'string' || !Number.isFinite(Number(response.expires_in))) throw fail('广告授权响应异常', 502);
      token = response.access_token; expiresAt = Date.now() + Math.max(0, Number(response.expires_in) - 60) * 1000;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl(HOST + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: 'Bearer ' + token } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch { if (attempt === 2) throw fail('广告接口连接超时或网络异常', 502); await sleep(1000 * 2 ** attempt); continue; }
      if (response.status === 401 || response.status === 403) throw fail('广告接口授权无效或无访问权限，请检查 Performance Client ID / Secret', 502);
      if (response.status === 429 || response.status >= 500) { if (attempt < 2) { await sleep(1000 * 2 ** attempt); continue; } }
      if (!response.ok) throw fail(`广告接口返回 HTTP ${response.status}`, 502);
      try { return await response.json(); } catch { throw fail('广告接口未返回有效JSON数据', 502); }
    }
  }
  return {
    async daily(start, end) {
      const campaignResponse = await request('/api/client/campaign');
      if (campaignResponse?.hasNext || campaignResponse?.has_next) throw fail('广告活动列表不完整，暂不写入日费用', 502);
      const campaigns = reportRows(campaignResponse);
      if (campaigns.some((c) => c.id == null || !(c.PaymentType || c.paymentType || c.payment_type))) throw fail('广告活动付费类型无法识别', 502);
      const params = new URLSearchParams({ dateFrom: start, dateTo: end });
      const response = await request('/api/client/statistics/daily/json?' + params);
      return normalizePerformanceDaily(response, campaigns, start, end);
    },
  };
}
