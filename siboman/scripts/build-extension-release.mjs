#!/usr/bin/env node
/**
 * 打包「混淆发布版」Ozon 我的商品销售 插件
 *
 * 为什么需要：Chrome 扩展的 JS 一定在用户机器上，源码可直接解压查看。
 *   本脚本产出一个混淆版，让「复制 zip 改个名就上架」的成本从几分钟变成几天。
 *   ⚠️ 这只是提高门槛，不是绝对防护 —— 真正能防住的是服务端授权（见 DEV-NOTES）。
 *
 * 用法：
 *   node scripts/build-extension-release.mjs            # 产出 dist/ 与 release zip
 *   node scripts/build-extension-release.mjs --no-zip   # 只产出目录
 *
 * 产出：
 *   siboman/public/extension/ozon-funnel/dist/          混淆后的解压目录
 *   siboman/public/extension/ozon-funnel.release.zip    对外分发的安装包
 *
 * 源码（public/extension/ozon-funnel/content.js）保持可读，只用于自己维护。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import JavaScriptObfuscator from "javascript-obfuscator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "public/extension/ozon-funnel");
const DIST_DIR = path.join(SRC_DIR, "dist");
const RELEASE_ZIP = path.join(ROOT, "public/extension/ozon-funnel.release.zip");

const noZip = process.argv.includes("--no-zip");

function log(msg) { process.stdout.write(`[release] ${msg}\n`); }

// ── 1. 读源码 ──
const manifestSrc = fs.readFileSync(path.join(SRC_DIR, "manifest.json"), "utf8");
const contentSrc = fs.readFileSync(path.join(SRC_DIR, "content.js"), "utf8");
const readmeSrc = fs.readFileSync(path.join(SRC_DIR, "README.md"), "utf8");
const manifest = JSON.parse(manifestSrc);

// 发布包绝不带这些东西
for (const name of ["DEV-NOTES.md", "dist"]) {
  if (manifest.web_accessible_resources?.some?.((r) => String(r).includes(name))) {
    throw new Error(`manifest 里不该暴露 ${name}`);
  }
}

log(`源码内容 ${(contentSrc.length / 1024).toFixed(1)} KB · v${manifest.version}`);

// ── 2. 混淆 ──
// 取舍说明：
//   · debugProtection 故意不开 —— 会让开发者工具卡死，卖家本来就要用 F12 看后台
//   · deadCodeInjection 不开 —— 体积翻倍、收益低
//   · selfDefending 开 —— 格式化/改一行就崩，阻碍「读一遍再改写」
//   · stringArray + base64 —— 把接口路径、请求头名这些关键字符串藏进字符串数组
const obfuscated = JavaScriptObfuscator.obfuscate(contentSrc, {
  compact: true,
  target: "browser",
  // 字符串保护
  stringArray: true,
  stringArrayThreshold: 1,
  stringArrayEncoding: ["base64"],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 3,
  stringArrayWrappersType: "variable",
  stringArrayWrappersChainedCalls: true,
  splitStrings: true,
  splitStringsChunkLength: 6,
  // 标识符与结构
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,          // 入口是 IIFE，不动全局
  transformObjectKeys: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  numbersToExpressions: true,
  simplify: true,
  selfDefending: true,
  debugProtection: false,
  disableConsoleOutput: true,
  unicodeEscapeSequence: false,
  sourceMap: false,
  seed: 0,
}).getObfuscatedCode();

if (/seller-analytics\/charts|posting-service|x-o3-company-id/.test(obfuscated)) {
  throw new Error("混淆后仍能直接搜到关键接口字符串，检查 stringArray 配置");
}

log(`混淆后 ${(obfuscated.length / 1024).toFixed(1)} KB（${(obfuscated.length / contentSrc.length).toFixed(1)}×）`);

// ── 3. 产出 ──
fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });
fs.writeFileSync(path.join(DIST_DIR, "content.js"), obfuscated);
// 发布版 manifest：去掉 version 里的开发后缀、保持字段一致
fs.writeFileSync(path.join(DIST_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(DIST_DIR, "README.md"), readmeSrc);
log(`已产出 ${path.relative(ROOT, DIST_DIR)}`);

// ── 4. 打 zip（显式列文件，避免把 dist / DEV-NOTES 打进去）──
if (!noZip) {
  fs.rmSync(RELEASE_ZIP, { force: true });
  execFileSync("zip", ["-qr", RELEASE_ZIP, "manifest.json", "content.js", "README.md"], { cwd: DIST_DIR });
  const size = fs.statSync(RELEASE_ZIP).size;
  log(`已产出 ${path.relative(ROOT, RELEASE_ZIP)}（${(size / 1024).toFixed(1)} KB）`);
}

log("完成。源码仍留在 public/extension/ozon-funnel/ 供自己维护。");
