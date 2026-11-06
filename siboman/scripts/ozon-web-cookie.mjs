#!/usr/bin/env node
// 从本机 Chrome 里取 Ozon 卖家后台的 Cookie（macOS）
//
// 用法：
//   node scripts/ozon-web-cookie.mjs                 # 打印 cookie 头
//   node scripts/ozon-web-cookie.mjs --copy          # 打印并复制到剪贴板
//   node scripts/ozon-web-cookie.mjs --profile "Profile 1"
//
// 原理：Chrome 用 Keychain 里的 "Chrome Safe Storage" 派生密钥（PBKDF2-SHA1, saltysalt, 1003 轮），
// 再用 AES-128-CBC 加密 cookie 值（v10 前缀）。脚本只读本机数据库，不做任何写操作。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const profile = value('--profile', 'Default');
const root = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', profile);
const source = path.join(root, 'Cookies');
if (!fs.existsSync(source)) {
  console.error(`找不到 Chrome cookie 数据库：${source}`);
  console.error('如果用的是别的浏览器/配置，用 --profile "Profile 1" 指定目录名。');
  process.exit(1);
}

// 数据库可能被 Chrome 锁住，复制一份再读
const temp = path.join(os.tmpdir(), `ozon-cookies-${process.pid}.db`);
fs.copyFileSync(source, temp);
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, temp + suffix);
}

function keychainPassword() {
  try {
    return execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], { encoding: 'utf8' }).replace(/\n$/, '');
  } catch {
    console.error('读取钥匙串失败：需要允许终端访问 "Chrome Safe Storage"（会弹一次系统授权框）。');
    process.exit(1);
  }
}

function decrypt(encrypted, key) {
  const prefix = encrypted.subarray(0, 3).toString('utf8');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // v20 是 Chrome 的应用绑定加密，普通钥匙串密钥解不开
    throw new Error(`cookie 使用了不支持的加密版本 ${JSON.stringify(prefix)}，请改为手动从 F12 复制 Cookie`);
  }
  const iv = Buffer.alloc(16, ' ');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
}

// 用 sqlite3 的 JSON 输出，避免手工解析分隔符
const sql = `SELECT host_key, name, value, hex(encrypted_value) AS enc FROM cookies WHERE host_key LIKE '%ozon%'`;
const raw = execFileSync('sqlite3', ['-json', temp, sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
fs.rmSync(temp, { force: true });
for (const suffix of ['-wal', '-shm']) fs.rmSync(temp + suffix, { force: true });

const rows = raw ? JSON.parse(raw) : [];
if (!rows.length) {
  console.error('Chrome 里没有 ozon 相关的 cookie，请先在 Chrome 登录 seller.ozon.ru。');
  process.exit(1);
}

const key = crypto.pbkdf2Sync(keychainPassword(), 'saltysalt', 1003, 16, 'sha1');
const jar = new Map();
for (const row of rows) {
  let plain = row.value;
  if (!plain && row.enc) {
    try { plain = decrypt(Buffer.from(row.enc, 'hex'), key).toString('utf8'); } catch { continue; }
  }
  if (plain) jar.set(row.name, `${row.name}=${plain}`);
}

const wanted = ['__Secure-access-token', '__Secure-sid', '__Secure-refresh-token', 'sc_company_id', '__Secure-user-id'];
const picked = [...jar.values()];
if (!picked.length) {
  console.error('没有解出可用的 cookie，请改为手动从 F12 复制。');
  process.exit(1);
}
// 关键的排前面，便于人工核对
picked.sort((a, b) => wanted.indexOf(a.split('=')[0]) - wanted.indexOf(b.split('=')[0]));
const header = picked.join('; ');

if (flag('--copy')) {
  try {
    execFileSync('pbcopy', { input: header });
    console.log('已复制到剪贴板，直接粘贴到 ERP 的输入框即可。');
  } catch { console.log(header); }
} else {
  console.log(header);
}
console.error(`\n共 ${picked.length} 个 cookie；关键项：${wanted.filter((name) => jar.has(name)).join(', ') || '未找到'}`);
