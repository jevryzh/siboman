// Accio Work (2026-11-17) v2.2.9.226
// 毛线种类配置中心 —— 拣货单、标签、区间统计都从这里读取规则，
// 保证三处的色号识别/分类/换算 100% 一致。
//
// 未来新增毛线种类（比如人造丝 #R+N、麻线 #M+N）：
//   只需在 YARN_KINDS 数组里追加一条，所有导出接口自动识别。
//   颜色正则应和其他种类互斥；同一色号只能匹配一种 kind。
//
// 导出的核心能力：
//   - YARN_KINDS           : 配置数组
//   - getYarnKindByCode    : 按 code 取配置
//   - extractColor         : 从 offer_id 抽色号（和 yarn-range-export.js 同款）
//   - classifyColor        : 色号 → { kind, color }（kind=null 表示 unknown）
//   - isYarnName           : 商品名是否含毛线关键词（俄文 пряж）

// 毛线商品名识别（俄文：пряжа = 毛线）
export const YARN_NAME_RE = /пряж/i;

// -------- 种类配置 --------
export const YARN_KINDS = [
  {
    code: "mohar",
    label: "马海毛",
    // 色号识别：纯数字（01、02、18、32 等）
    colorRe: /^(\d+)$/,
    // 展示时保留原值（不足 2 位 Excel 可能把 "01" 变成 1，所以统一字符串）
    colorFmt: (c) => String(c),
    // 1 绞 = 4 根
    perQty: 4,
    unitPrice: 3.3,
  },
  {
    code: "alpaca",
    label: "羊驼毛",
    // 色号识别：W 开头 + 数字（W001、W023 等），大小写不敏感
    colorRe: /^W\d+$/i,
    colorFmt: (c) => String(c).toUpperCase(),
    // 1 绞 = 2 根
    perQty: 2,
    unitPrice: 4.5,
  },
  // 示例：未来加其他种类时取消注释、按实际规则改
  // {
  //   code: "rayon",
  //   label: "人造丝",
  //   colorRe: /^R\d+$/i,
  //   colorFmt: (c) => String(c).toUpperCase(),
  //   perQty: 3,
  //   unitPrice: 5.0,
  // },
];

export function getYarnKindByCode(code) {
  return YARN_KINDS.find((k) => k.code === code) || null;
}

// -------- 色号解析 --------
// offer_id 示例：
//   jz-260624fwg3-4736604207-01        → "01"   (mohar)
//   ALPACA-YARN-W023-2PCS              → "W023" (alpaca, 最后一段 "2PCS" 不是合法色号 → 回退一段)
// 规则：按 "-" 分段，从右往左找第一个能被某个 kind.colorRe 识别的段作为色号。
export function extractColor(offerId) {
  const s = String(offerId || "").trim();
  if (!s) return "";
  const parts = s.split("-");
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    for (const kind of YARN_KINDS) {
      if (kind.colorRe.test(seg)) {
        return kind.colorFmt(seg);
      }
    }
  }
  return "";
}

// 色号 → 种类 + 规范化色号。未识别返回 { kind: null, color: "" }。
export function classifyColor(color) {
  const c = String(color || "").trim();
  if (!c) return { kind: null, color: "" };
  for (const kind of YARN_KINDS) {
    if (kind.colorRe.test(c)) return { kind, color: kind.colorFmt(c) };
  }
  return { kind: null, color: c };
}

// 从 offer_id 直接到 { kind, color }
export function classifyOfferId(offerId) {
  return classifyColor(extractColor(offerId));
}

// 商品名是否含毛线关键词
export function isYarnName(name) {
  return YARN_NAME_RE.test(String(name || ""));
}

// 兼容 yarn-range-export.js 老接口（返回字符串 code）
export function colorKind(color) {
  const { kind } = classifyColor(color);
  return kind ? kind.code : "unknown";
}
