// AlphaShop (遨虾) MCP SSE client —— 短会话调用，供 server.js 按需使用
// 鉴权：AccessKey/SecretKey 生成 JWT(HS256)，key=<JWT> 走 MCP SSE
// 参考验证代码: /tmp/alpha_mcp_call.mjs (2026-09-04 已实测 SUCCESS)
import crypto from 'node:crypto';

function makeJwt(ak, sk) {
  const b64url = (b) => Buffer.from(b).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ iss: ak, exp: now + 1800, nbf: now - 5 }));
  return h + '.' + p + '.' + crypto.createHmac('sha256', sk).update(h + '.' + p).digest('base64url');
}

function getCreds() {
  const ak = process.env.ALPHASHOP_ACCESS_KEY || '';
  const sk = process.env.ALPHASHOP_SECRET_KEY || '';
  if (!ak || !sk) return null;
  return { ak, sk, jwt: makeJwt(ak, sk) };
}

/**
 * 调用 AlphaShop MCP 工具（短会话：建 SSE → initialize → notifications/initialized → tools/call）
 * @param {string} tool 工具名: imageSearchProduct / keywordSearchProduct / productDetailQuery ...
 * @param {object} args 工具参数
 * @param {number} timeoutMs 超时(默认 60s)
 * @returns {Promise<object>} 解析后的 result（content[0].text 的 JSON）
 */
async function alphaShopMcpCall(tool, args, timeoutMs = 60000) {
  const creds = getCreds();
  if (!creds) throw new Error('AlphaShop 凭据未配置 (ALPHASHOP_ACCESS_KEY/SECRET_KEY)');
  const SSE_URL = `https://mcp.alphashop.cn/sse?key=${creds.jwt}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(SSE_URL, { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`SSE 连接失败 status=${resp.status}`);
    const reader = resp.body.getReader();
    let buf = '', msgUrl = '';
    const responses = [];
    let resolveEp;
    const epP = new Promise((r) => { resolveEp = r; });
    const pump = (async () => {
      while (true) {
        let chunk;
        try { ({ value: chunk } = await reader.read()); } catch { return; }
        if (!chunk) continue;
        buf += Buffer.from(chunk).toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const m = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = 'message'; const da = [];
          for (const ln of m.split('\n')) { if (ln.startsWith('event:')) ev = ln.slice(6).trim(); else if (ln.startsWith('data:')) da.push(ln.slice(5).trim()); }
          const d = da.join('\n');
          if (ev === 'endpoint') { msgUrl = d.startsWith('http') ? d : 'https://mcp.alphashop.cn' + d; resolveEp(msgUrl); }
          else if (d) { try { responses.push(JSON.parse(d)); } catch {} }
        }
      }
    })();
    await Promise.race([epP, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE endpoint 超时')), 30000))]);
    const send = (j) => fetch(msgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(j), signal: ctrl.signal }).catch(() => {});
    await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ozon-erp', version: '1.0.0' } } });
    await new Promise((r) => setTimeout(r, 2500));
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 1200));
    await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
    // 轮询等响应
    const deadline = Date.now() + timeoutMs - 5000;
    while (Date.now() < deadline && !responses.some((x) => x.id === 2)) await new Promise((r) => setTimeout(r, 1000));
    const msg = responses.find((x) => x.id === 2);
    ctrl.abort();
    if (!msg) throw new Error(`AlphaShop MCP 工具 ${tool} 响应超时`);
    if (msg.error) throw new Error(`AlphaShop MCP 错误: ${JSON.stringify(msg.error)}`);
    const content = (msg.result && msg.result.content) || [];
    for (const c of content) {
      if (c.text) {
        try { return JSON.parse(c.text); } catch { return { rawText: c.text }; }
      }
    }
    return msg.result || {};
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`AlphaShop MCP 调用超时(${tool})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export { alphaShopMcpCall, getCreds, makeJwt };
