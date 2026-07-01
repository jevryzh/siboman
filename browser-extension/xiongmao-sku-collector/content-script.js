(() => {
  const COLLECTOR_VERSION = "1.1.0";
  if (globalThis.xiongmaoSkuCollector?.version === COLLECTOR_VERSION) return;

  const KNOWN_COLUMNS = [
    "商品信息",
    "类目",
    "所属类目",
    "主类目",
    "子类目",
    "机会判断",
    "机会标签",
    "月销量",
    "月销售额",
    "均价",
    "月销售额环比",
    "月浏览量",
    "日均销量",
    "日均销售额",
    "日均浏览量",
    "操作"
  ];

  const PRODUCT_COLUMNS = ["商品名称", "SKU", "商品编号", "品牌", "商品链接", "图片链接"];
  const WAIT_MS = 260;
  const MAX_VERTICAL_STEPS = 80;
  const MAX_HORIZONTAL_STEPS = 18;

  globalThis.xiongmaoSkuCollector = {
    version: COLLECTOR_VERSION,
    collect
  };

  async function collect(options = {}) {
    const startedAt = new Date().toISOString();
    const collector = createCollector();
    const scrollTargets = getScrollTargets();
    const originalPositions = scrollTargets.map((target) => ({
      target,
      top: target.scrollTop,
      left: target.scrollLeft
    }));

    await collectAtCurrentPosition(collector, options);

    if (options.autoScroll) {
      await scanVertically(collector, options);
    }

    restoreScrollPositions(originalPositions);

    const rows = collector.getRows();
    const columns = normalizeColumns(collector.getColumns(), rows);

    return {
      sourceUrl: location.href,
      collectedAt: startedAt,
      rowCount: rows.length,
      columns,
      rows: rows.map((row) => orderRow(row, columns))
    };
  }

  async function scanVertically(collector, options) {
    const target = getBestVerticalScroller();
    if (!target) return;

    const seenPositions = new Set();
    let idleSteps = 0;

    target.scrollTop = 0;
    await sleep(WAIT_MS);

    for (let step = 0; step < MAX_VERTICAL_STEPS; step += 1) {
      await collectAtCurrentPosition(collector, options);

      const before = target.scrollTop;
      const positionKey = `${Math.round(before)}:${target.scrollHeight}:${target.clientHeight}`;
      if (seenPositions.has(positionKey)) idleSteps += 1;
      seenPositions.add(positionKey);

      const nextTop = Math.min(
        target.scrollTop + Math.max(320, Math.floor(target.clientHeight * 0.82)),
        target.scrollHeight - target.clientHeight
      );
      target.scrollTop = nextTop;
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.dispatchEvent(new Event("scroll"));
      await sleep(WAIT_MS);

      if (Math.abs(target.scrollTop - before) < 8) idleSteps += 1;
      if (idleSteps >= 3) break;
    }
  }

  async function collectAtCurrentPosition(collector, options) {
    if (!options.scanHorizontal) {
      collector.add(extractVisibleData());
      return;
    }

    const horizontalScroller = getBestHorizontalScroller();
    if (!horizontalScroller) {
      collector.add(extractVisibleData());
      return;
    }

    const originalLeft = horizontalScroller.scrollLeft;
    horizontalScroller.scrollLeft = 0;
    await sleep(80);

    const seenLefts = new Set();
    for (let step = 0; step < MAX_HORIZONTAL_STEPS; step += 1) {
      collector.add(extractVisibleData());

      const before = Math.round(horizontalScroller.scrollLeft);
      seenLefts.add(before);

      const nextLeft = Math.min(
        horizontalScroller.scrollLeft + Math.max(360, Math.floor(horizontalScroller.clientWidth * 0.72)),
        horizontalScroller.scrollWidth - horizontalScroller.clientWidth
      );
      horizontalScroller.scrollLeft = nextLeft;
      horizontalScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(100);

      const after = Math.round(horizontalScroller.scrollLeft);
      if (seenLefts.has(after) || Math.abs(after - before) < 8) break;
    }

    horizontalScroller.scrollLeft = originalLeft;
    horizontalScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  }

  function extractVisibleData() {
    const tableExtraction = extractFromTables();
    if (tableExtraction.rows.length) return tableExtraction;
    return extractFromTextBlocks();
  }

  function extractFromTables() {
    const tableRoots = getTableRoots();
    const best = { columns: [], rows: [] };

    for (const root of tableRoots) {
      const columns = readHeaders(root);
      const rowElements = readRows(root, columns);
      const rows = rowElements
        .map((rowElement) => parseRow(rowElement, columns))
        .filter((row) => row && (row.SKU || row["商品名称"] || row["商品信息"]));

      if (scoreExtraction(columns, rows) > scoreExtraction(best.columns, best.rows)) {
        best.columns = columns;
        best.rows = rows;
      }
    }

    return best;
  }

  function getTableRoots() {
    const selectors = [
      ".el-table",
      ".ant-table",
      ".vxe-table",
      ".arco-table",
      "[role='table']",
      "table"
    ];
    const roots = new Set();

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((element) => roots.add(element));
    }

    if (!roots.size) {
      document.querySelectorAll("main, section, article, div").forEach((element) => {
        const text = compactText(element);
        const hasProductTableSignal = text.includes("SKU") || text.includes("商品信息") || text.includes("所属类目");
        if (hasProductTableSignal && KNOWN_COLUMNS.some((column) => text.includes(column))) {
          roots.add(element);
        }
      });
    }

    return [...roots]
      .filter(isVisible)
      .sort((a, b) => scoreRoot(b) - scoreRoot(a))
      .slice(0, 8);
  }

  function readHeaders(root) {
    const selectors = [
      ".el-table__header-wrapper th",
      ".ant-table-thead th",
      "thead th",
      "[role='columnheader']",
      ".vxe-header--column",
      ".arco-table-th"
    ];

    for (const selector of selectors) {
      const headers = uniqueHeaderTexts([...root.querySelectorAll(selector)].map(compactText));
      if (headers.length >= 2) return headers;
    }

    const text = compactText(root);
    const found = KNOWN_COLUMNS.filter((column) => text.includes(column));
    return found.length >= 2 ? found : [];
  }

  function readRows(root, headers = []) {
    const selectors = [
      ".el-table__body-wrapper tbody tr.el-table__row",
      ".el-table__body-wrapper tbody tr",
      ".ant-table-tbody tr",
      "tbody tr",
      "[role='row']",
      ".vxe-body--row",
      ".arco-table-tr"
    ];

    for (const selector of selectors) {
      const rows = [...root.querySelectorAll(selector)]
        .filter((row) => isVisible(row) && isProductDataRow(row, headers));
      if (rows.length) return rows;
    }

    return [...root.querySelectorAll("div, li")]
      .filter((element) => {
        const text = compactText(element);
        return isVisible(element) && looksLikeProductText(element, text) && text.length < 1200;
      });
  }

  function parseRow(rowElement, headers) {
    const cells = getCells(rowElement);
    const row = {};

    if (cells.length >= 2) {
      cells.forEach((cell, index) => {
        const header = headers[index] || `列${index + 1}`;
        const text = header.includes("机会") ? readBadgeText(cell) : compactText(cell);
        if (text) row[header] = text;

        if (header === "所属类目") {
          const categoryLines = getTextLines(cell);
          if (categoryLines[0]) row["主类目"] = categoryLines[0];
          if (categoryLines.length > 1) row["子类目"] = categoryLines.slice(1).join(" / ");
        }
      });
      parseProductCell(findProductCell(cells) || cells[0], row);
    } else {
      parseFreeTextRow(rowElement, headers, row);
    }

    normalizeSkuAndBrand(row);
    return row;
  }

  function getCells(rowElement) {
    const selectors = [
      "td",
      "[role='cell']",
      ".el-table__cell",
      ".ant-table-cell",
      ".vxe-body--column",
      ".arco-table-td"
    ];

    for (const selector of selectors) {
      const cells = [...rowElement.querySelectorAll(selector)]
        .filter((cell) => isVisible(cell) && compactText(cell));
      if (cells.length >= 2) return removeNestedCells(cells);
    }

    return [];
  }

  function removeNestedCells(cells) {
    return cells.filter((cell) => !cells.some((other) => other !== cell && other.contains(cell)));
  }

  function isProductDataRow(rowElement, headers = []) {
    const text = compactText(rowElement);
    if (!text || text.length > 2500) return false;
    if (/SKU\s*[:：]?\s*\d{5,}/i.test(text)) return true;

    const cells = getCells(rowElement);
    if (cells.length < 2) return false;

    const productCell = findProductCell(cells);
    if (!productCell || !extractProductIdentifier(productCell)) return false;

    const headerSignal = headers.some((header) => [
      "商品信息",
      "类目",
      "所属类目",
      "月销量",
      "月销售额",
      "机会判断"
    ].includes(header));
    const rowSignal = cells.length >= 4 || Boolean(productCell.querySelector("a[href], img"));

    return headerSignal || rowSignal;
  }

  function looksLikeProductText(element, text = compactText(element)) {
    if (/SKU\s*[:：]?\s*\d{5,}/i.test(text)) return true;
    if (!extractProductIdentifier(element)) return false;

    const lines = getTextLines(element);
    const hasProductName = lines.some((line) => line.length >= 8 && !/^\d{7,12}\b/.test(line));
    return hasProductName || Boolean(element?.querySelector?.("a[href], img"));
  }

  function findProductCell(cells) {
    const scored = cells
      .map((cell) => ({ cell, score: scoreProductCell(cell) }))
      .sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? scored[0].cell : null;
  }

  function scoreProductCell(cell) {
    const text = compactText(cell);
    let score = 0;

    if (/SKU\s*[:：]?\s*\d{5,}/i.test(text)) score += 120;
    if (extractProductIdentifier(cell)) score += 90;
    if (cell.querySelector("a[href]")) score += 35;
    if (cell.querySelector("img[src]")) score += 35;
    if (extractBrand(text)) score += 10;
    if (/^(一键|操作|加入|清空|已选)/.test(text)) score -= 100;

    return score;
  }

  function findProductLink(cell) {
    const links = [...cell.querySelectorAll("a[href]")]
      .filter((link) => isVisible(link) && compactText(link) && !/^(一键|操作|加入|清空|已选)/.test(compactText(link)));
    return links[0] || null;
  }

  function readBadgeText(cell) {
    const badges = [...cell.querySelectorAll("*")]
      .filter((element) => isVisible(element))
      .filter((element) => ![...element.children].some((child) => compactText(child) === compactText(element)))
      .map(compactText)
      .filter((text) => text && text.length <= 16);

    return badges.length ? [...new Set(badges)].join(" ") : compactText(cell);
  }

  function parseProductCell(cell, row) {
    const text = compactText(cell);
    if (!row["商品信息"]) row["商品信息"] = text;

    const linkElement = findProductLink(cell);
    const titleFromLink = linkElement ? compactText(linkElement) : "";
    const title = titleFromLink || extractTitle(text);
    const sku = extractSku(text) || extractProductIdentifier(cell, title);
    const brand = extractBrand(text) || extractBrandFromProductCell(cell, sku, title);
    const link = linkElement?.href || "";
    const image = cell.querySelector("img[src]")?.src || "";

    if (title) row["商品名称"] = title;
    if (sku) {
      row.SKU = sku;
      if (!/SKU\s*[:：]?/i.test(text)) row["商品编号"] = sku;
    }
    if (brand) row["品牌"] = brand;
    if (link) row["商品链接"] = link;
    if (image) row["图片链接"] = image;
  }

  function parseFreeTextRow(element, headers, row) {
    const text = compactText(element);
    const sku = extractSku(text) || extractProductIdentifier(element);
    const brand = extractBrand(text) || extractBrandFromProductCell(element, sku);
    const title = extractTitle(text);

    row["商品信息"] = text;
    if (title) row["商品名称"] = title;
    if (sku) {
      row.SKU = sku;
      if (!/SKU\s*[:：]?/i.test(text)) row["商品编号"] = sku;
    }
    if (brand) row["品牌"] = brand;

    const values = splitKnownColumnValues(text, headers);
    Object.assign(row, values);
  }

  function extractFromTextBlocks() {
    const rows = [...document.querySelectorAll("body *")]
      .filter((element) => {
        if (!isVisible(element)) return false;
        const text = compactText(element);
        if (!looksLikeProductText(element, text)) return false;
        if (text.length > 1000) return false;
        return ![...element.children].some((child) => looksLikeProductText(child, compactText(child)));
      })
      .map((element) => {
        const row = {};
        parseFreeTextRow(element, KNOWN_COLUMNS, row);
        return row;
      })
      .filter((row) => row.SKU);

    return {
      columns: normalizeColumns(KNOWN_COLUMNS, rows),
      rows
    };
  }

  function normalizeSkuAndBrand(row) {
    const source = row["商品信息"] || Object.values(row).join(" ");
    if (!row.SKU) row.SKU = extractSku(source) || extractProductIdentifier(source, row["商品名称"] || "");
    if (row.SKU && !row["商品编号"] && !/SKU\s*[:：]?/i.test(source)) row["商品编号"] = row.SKU;
    if (!row["品牌"]) row["品牌"] = extractBrand(source) || extractBrandFromProductCell(source, row.SKU, row["商品名称"]);
    if (!row["商品名称"]) row["商品名称"] = extractTitle(source);
  }

  function splitKnownColumnValues(text, headers) {
    const result = {};
    const usableHeaders = headers.length ? headers : KNOWN_COLUMNS;

    usableHeaders.forEach((header) => {
      const escaped = escapeRegExp(header);
      const nextHeaders = usableHeaders.filter((item) => item !== header).map(escapeRegExp).join("|");
      const pattern = nextHeaders
        ? new RegExp(`${escaped}\\s*[:：]?\\s*(.*?)(?=\\s*(?:${nextHeaders})\\s*[:：]?|$)`)
        : new RegExp(`${escaped}\\s*[:：]?\\s*(.*)$`);
      const match = text.match(pattern);
      if (match?.[1]) result[header] = cleanCellText(match[1]);
    });

    return result;
  }

  function createCollector() {
    const rowsByKey = new Map();
    const columnSet = new Set();

    return {
      add(extraction) {
        extraction.columns.forEach((column) => columnSet.add(column));

        extraction.rows.forEach((row) => {
          const cleanRow = cleanRowObject(row);
          const key = rowKey(cleanRow);
          if (!key) return;

          Object.keys(cleanRow).forEach((column) => columnSet.add(column));
          if (rowsByKey.has(key)) {
            rowsByKey.set(key, mergeRows(rowsByKey.get(key), cleanRow));
          } else {
            rowsByKey.set(key, cleanRow);
          }
        });
      },
      getRows() {
        return [...rowsByKey.values()];
      },
      getColumns() {
        return [...columnSet];
      }
    };
  }

  function mergeRows(existing, incoming) {
    const merged = { ...existing };
    Object.entries(incoming).forEach(([key, value]) => {
      if (value && (!merged[key] || String(value).length > String(merged[key]).length)) {
        merged[key] = value;
      }
    });
    return merged;
  }

  function cleanRowObject(row) {
    const cleanRow = {};
    Object.entries(row).forEach(([key, value]) => {
      const cleanKey = cleanCellText(key);
      const cleanValue = cleanCellText(value);
      if (cleanKey && cleanValue) cleanRow[cleanKey] = cleanValue;
    });
    return cleanRow;
  }

  function rowKey(row) {
    if (row.SKU) return `sku:${row.SKU}`;
    if (row["商品名称"]) return `title:${row["商品名称"]}`;
    return "";
  }

  function normalizeColumns(discoveredColumns, rows) {
    const present = new Set();
    rows.forEach((row) => Object.keys(row).forEach((column) => present.add(column)));
    discoveredColumns.forEach((column) => present.add(column));

    const preferred = [...PRODUCT_COLUMNS, "商品信息"];
    const ordered = preferred.filter((column) => present.has(column));

    KNOWN_COLUMNS.forEach((column) => {
      if (present.has(column) && !ordered.includes(column)) ordered.push(column);
    });

    [...present].forEach((column) => {
      if (!ordered.includes(column)) ordered.push(column);
    });

    return ordered;
  }

  function orderRow(row, columns) {
    const ordered = {};
    columns.forEach((column) => {
      ordered[column] = row[column] || "";
    });
    return ordered;
  }

  function uniqueHeaderTexts(headers) {
    const result = [];
    headers
      .map(normalizeHeaderText)
      .filter(Boolean)
      .forEach((header) => {
        let next = header;
        if (result.includes(next)) {
          let index = 2;
          while (result.includes(`${header}_${index}`)) index += 1;
          next = `${header}_${index}`;
        }
        result.push(next);
      });
    return result;
  }

  function scoreExtraction(columns, rows) {
    const skuRows = rows.filter((row) => row.SKU || row["商品编号"]).length;
    const knownColumnCount = columns.filter((column) => KNOWN_COLUMNS.includes(column)).length;
    return skuRows * 100 + rows.length * 10 + columns.length + knownColumnCount * 20;
  }

  function scoreRoot(element) {
    const text = compactText(element);
    const knownColumnCount = KNOWN_COLUMNS.filter((column) => text.includes(column)).length;
    const skuCount = (text.match(/SKU\s*[:：]?\s*\d{5,}/gi) || []).length;
    const productIdCount = (text.match(/\b\d{7,12}\b/g) || []).length;
    const productTableBonus = text.includes("商品信息") || text.includes("所属类目") ? 200 : 0;
    const rect = element.getBoundingClientRect();
    return skuCount * 100 + productIdCount * 12 + productTableBonus + knownColumnCount * 25 + rect.width * rect.height / 100000;
  }

  function extractSku(text) {
    const match = String(text || "").match(/SKU\s*[:：]?\s*([A-Za-z0-9_-]{5,})/i);
    return match ? match[1].trim() : "";
  }

  function extractProductIdentifier(source, title = "") {
    const text = compactText(source);
    const sku = extractSku(text);
    if (sku) return sku;

    for (const line of getTextLines(source)) {
      const id = extractIdentifierFromLine(line);
      if (id) return id;
    }

    const searchText = title ? text.replace(title, " ") : text;
    const match = searchText.match(/(?:^|\s)(\d{7,12})(?=\s*(?:[·•・.|,，-]|\s|$))/);
    return match ? match[1] : "";
  }

  function extractIdentifierFromLine(line) {
    const text = cleanCellText(line);
    const sku = extractSku(text);
    if (sku) return sku;

    const match = text.match(/^(\d{7,12})(?:\D.*)?$/);
    return match ? match[1] : "";
  }

  function extractBrand(text) {
    const match = String(text || "").match(/(?:品牌|brand)\s*[:：]\s*([^|,\n\r]+?)(?=\s*(?:SKU\s*[:：]?|类目|月销量|月销售|均价|$))/i);
    return match ? cleanBrand(match[1]) : "";
  }

  function extractBrandFromProductCell(source, sku = "", title = "") {
    const id = sku || extractProductIdentifier(source, title);
    if (!id) return "";

    const lines = getTextLines(source);
    const idLineIndex = lines.findIndex((line) => line.includes(id));

    if (idLineIndex >= 0) {
      const idLine = lines[idLineIndex];
      const afterId = cleanBrand(idLine.slice(idLine.indexOf(id) + id.length));
      if (afterId) return afterId;

      for (const line of lines.slice(idLineIndex + 1)) {
        const candidate = cleanBrand(line);
        if (isBrandCandidate(candidate)) return candidate;
      }
    }

    const text = compactText(source);
    const afterText = text.includes(id) ? text.slice(text.indexOf(id) + id.length) : "";
    return cleanBrand(afterText);
  }

  function extractTitle(text) {
    const normalized = String(text || "").trim();
    const lines = getTextLines(normalized);
    const idLineIndex = lines.findIndex((line) => extractIdentifierFromLine(line));

    if (idLineIndex > 0) {
      return cleanCellText(lines.slice(0, idLineIndex).join(" "));
    }

    const beforeIdentifier = normalized.match(/^(.*?)(?:\s+\d{7,12}\s*(?:[·•・.|,，-]|\s|$))/s);
    if (beforeIdentifier?.[1]) return cleanCellText(beforeIdentifier[1]);

    const withoutSku = normalized
      .replace(/\s*SKU\s*[:：]?\s*[A-Za-z0-9_-]{5,}.*$/is, "")
      .replace(/\s*品牌\s*[:：].*$/is, "")
      .trim();

    if (!withoutSku) return "";
    return cleanCellText(withoutSku.split(/\n|\r/)[0] || withoutSku);
  }

  function getTextLines(source) {
    const raw = typeof source === "string"
      ? source
      : source?.innerText || source?.textContent || "";
    return raw
      .split(/\n|\r/)
      .map(cleanCellText)
      .filter(Boolean);
  }

  function cleanBrand(value) {
    const withoutBadges = String(value ?? "")
      .replace(/(LEADER|高增长|高加购|高GMV|快发|可跟卖|一键跟卖|复制)/gi, "");
    return cleanCellText(withoutBadges)
      .replace(/^[·•・.|,，\-\s]+/, "")
      .replace(/[·•・.|,，\-\s]+$/, "");
  }

  function isBrandCandidate(value) {
    if (!value || /^\d/.test(value)) return false;
    return !/^(高增长|高加购|高GMV|快发|可跟卖|一键跟卖|复制|LEADER)$/i.test(value);
  }

  function normalizeHeaderText(header) {
    return cleanCellText(header)
      .replace(/[↕↑↓▲▼△▽⇅⇵]/g, "")
      .replace(/\s+/g, "")
      .replace(/^(全选|选择)$/g, "");
  }

  function cleanCellText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, " ")
      .trim();
  }

  function compactText(elementOrText) {
    if (typeof elementOrText === "string") return cleanCellText(elementOrText);
    return cleanCellText(elementOrText?.innerText || elementOrText?.textContent || "");
  }

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getBestVerticalScroller() {
    const candidates = getScrollTargets()
      .filter((element) => element.scrollHeight > element.clientHeight + 80)
      .sort((a, b) => scoreScroller(b, "vertical") - scoreScroller(a, "vertical"));
    return candidates[0] || document.scrollingElement || document.documentElement;
  }

  function getBestHorizontalScroller() {
    const candidates = getScrollTargets()
      .filter((element) => element.scrollWidth > element.clientWidth + 80)
      .sort((a, b) => scoreScroller(b, "horizontal") - scoreScroller(a, "horizontal"));
    return candidates[0] || null;
  }

  function getScrollTargets() {
    const targets = new Set([document.scrollingElement, document.documentElement, document.body]);
    document.querySelectorAll("main, section, article, div, table, .el-table__body-wrapper, .ant-table-body").forEach((element) => {
      if (!isVisible(element)) return;
      const style = getComputedStyle(element);
      const canScrollY = /(auto|scroll|overlay)/.test(`${style.overflowY}${style.overflow}`);
      const canScrollX = /(auto|scroll|overlay)/.test(`${style.overflowX}${style.overflow}`);
      if (canScrollY || canScrollX || element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
        targets.add(element);
      }
    });
    return [...targets].filter(Boolean);
  }

  function scoreScroller(element, direction) {
    const text = compactText(element);
    const rect = element.getBoundingClientRect();
    const skuBonus = text.includes("SKU") ? 400 : 0;
    const columnBonus = KNOWN_COLUMNS.filter((column) => text.includes(column)).length * 60;
    const sizeBonus = rect.width * rect.height / 3000;
    const scrollBonus = direction === "horizontal"
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight;
    return skuBonus + columnBonus + sizeBonus + scrollBonus / 10;
  }

  function restoreScrollPositions(positions) {
    positions.forEach(({ target, top, left }) => {
      if (!target) return;
      target.scrollTop = top;
      target.scrollLeft = left;
    });
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
