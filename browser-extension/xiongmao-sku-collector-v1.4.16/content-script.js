(() => {
  const COLLECTOR_VERSION = "1.4.16";
  if (globalThis.xiongmaoSkuCollector?.version === COLLECTOR_VERSION) return;

  const KNOWN_COLUMNS = [
    // 商品页列
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
    "操作",
    // 仓库订单页列
    "货件编号",
    "状态",
    "已接收",
    "发送日期",
    "不逾期",
    "照片",
    "数量",
    "货号",
    "价格",
    "仓库",
    "配送服务",
    "方式"
  ];

  const PRODUCT_COLUMNS = ["商品名称", "SKU", "商品编号", "品牌", "商品链接", "图片链接"];
  const ORDER_COLUMNS = [
    "货件编号",
    "状态",
    "已接收",
    "发送日期",
    "不逾期",
    "照片",
    "数量",
    "货号",
    "商品名称",
    "价格",
    "仓库",
    "配送服务",
    "方式"
  ];
  const WAIT_MS = 260;
  const MAX_VERTICAL_STEPS = 80;
  const MAX_HORIZONTAL_STEPS = 18;
  const SHIPMENT_NUMBER_PATTERN = /\b\d{8,12}[-‐-―]\d{3,5}[-‐-―]\d{1,4}\b/;

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
        .filter((row) => row && (row.SKU || row["商品名称"] || row["商品信息"] || row["货件编号"]));

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
        const hasProductTableSignal =
          text.includes("SKU") ||
          text.includes("商品信息") ||
          text.includes("所属类目") ||
          SHIPMENT_NUMBER_PATTERN.test(text) ||
          (text.includes("货件编号") && text.includes("仓库"));
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
    // 优先按嵌套表头展开 colspan/rowspan，得到与 tbody td 一一对应的列头
    const headerSelectors = [
      ".el-table__header-wrapper",
      ".ant-table-thead",
      "thead",
      ".vxe-table--header",
      ".arco-table-header"
    ];

    for (const selector of headerSelectors) {
      const headerEl = root.querySelector(selector);
      if (!headerEl) continue;
      const headers = expandHeaderColumns(headerEl);
      if (headers.length >= 2) return headers;
    }

    // 退化方案：直接拿所有 th（不展开 colspan），并在出现嵌套表头时退化为单层
    const allTh = [...root.querySelectorAll("th, [role='columnheader'], .vxe-header--column, .arco-table-th")];
    if (allTh.length >= 2) {
      return uniqueHeaderTexts(allTh.map(extractColumnHeaderText));
    }

    const text = compactText(root);
    const found = KNOWN_COLUMNS.filter((column) => text.includes(column));
    return found.length >= 2 ? found : [];
  }

  // 把多行表头展开成与 td 一一对应的列头列表
  // 只取第一行（父表头），按 colspan 展开成与 tbody td 一一对应的列数
  // 第二行的子标签（如"不逾期 / 商品名称 / 方式"）不拼到列名里，避免产生"发运日期不数量、货号"这种怪串
  function expandHeaderColumns(headerEl) {
    const rows = [...headerEl.querySelectorAll("tr")];
    if (!rows.length) return [];

    const expanded = [];
    for (const th of rows[0].querySelectorAll("th")) {
      const colspan = parseInt(th.getAttribute("colspan") || "1", 10);
      const text = extractColumnHeaderText(th);
      for (let i = 0; i < colspan; i += 1) expanded.push(text);
    }
    return uniqueHeaderTexts(expanded);
  }

  // "数量，货号" 这种合并表头展开成两个独立列，便于逐 cell 解析
  function extractColumnHeaderText(element) {
    const direct = compactText(element);
    if (direct) return direct;

    const innerTexts = [...element.querySelectorAll("*")]
      .filter((child) => ![...child.children].length)
      .map(compactText)
      .filter(Boolean);
    if (innerTexts.length) return innerTexts.join(",");
    return "";
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
        .filter((row) => isVisible(row) && isDataRow(row, headers));
      if (rows.length) return rows;
    }

    return [...root.querySelectorAll("div, li")]
      .filter((element) => {
        const text = compactText(element);
        if (!isVisible(element) || text.length > 1200) return false;
        return looksLikeProductText(element, text) || looksLikeOrderText(element, text);
      });
  }

  function isDataRow(rowElement, headers = []) {
    return isOrderDataRow(rowElement, headers) || isProductDataRow(rowElement, headers);
  }

  function parseRow(rowElement, headers) {
    const cells = getCells(rowElement);
    const row = {};
    const isOrderRow = isOrderLikeHeaders(headers) || cells.some((cell) => extractShipmentNumber(compactText(cell)));

    if (cells.length >= 2) {
      if (isOrderRow) {
        // 订单行：完全按内容匹配各列，避免嵌套表头索引错位
        parseOrderRow(row, cells);
      } else {
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
      }
    } else if (isOrderRow) {
      parseOrderFreeTextRow(rowElement, row);
    } else {
      parseFreeTextRow(rowElement, headers, row);
    }

    if (isOrderRow) {
      normalizeOrderRow(row);
    } else {
      normalizeSkuAndBrand(row);
    }
    return row;
  }

  function isOrderLikeHeaders(headers) {
    return headers.some((header) => ORDER_COLUMNS.includes(header));
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
        .filter((cell) => {
          if (!isVisible(cell)) return false;
          // 保留有文字或包含图片的 cell（避免遗漏纯图片列）
          return compactText(cell) || cell.querySelector("img");
        });
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

  function isOrderDataRow(rowElement, headers = []) {
    const text = compactText(rowElement);
    if (!text || text.length > 2500) return false;

    if (extractShipmentNumber(text)) return true;
    if (headers.includes("货件编号")) {
      const cells = getCells(rowElement);
      if (cells.length < 3) return false;
      const hasPrice = cells.some((cell) => /[\d][\d\s,. ]*₽|[\d][\d\s,. ]*￥|[\d][\d\s,. ]*¥/.test(compactText(cell)));
      const hasQuantity = cells.some((cell) => /\d+\s*[个件双套条瓶盒只袋包箱架捆份盒台套组款]/.test(compactText(cell)));
      return hasPrice || hasQuantity;
    }
    return false;
  }

  function looksLikeOrderText(element, text = compactText(element)) {
    if (extractShipmentNumber(text)) return true;
    if (!/\d+\s*[个件双套条瓶盒只袋包箱架捆份盒台套组款]/.test(text)) return false;
    return /₽|￥|¥|\d+[.,]\d{2}/.test(text) || text.includes("陆运") || text.includes("空运");
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
    const image = getImageUrl(cell.querySelector("img"));

    if (title) row["商品名称"] = title;
    if (sku) {
      row.SKU = sku;
      if (!/SKU\s*[:：]?/i.test(text)) row["商品编号"] = sku;
    }
    if (brand) row["品牌"] = brand;
    if (link) row["商品链接"] = link;
    if (image) row["图片链接"] = image;
  }

  function parseOrderRow(row, cells) {
    // 完全用内容匹配提取各列，避免嵌套表头索引错位 / 合并单元格被多次写入
    const visited = new Set();

    // 诊断：把整行所有 cell 的文本都打出来（方便排查 SKU 提取问题）
    const shipment = row["货件编号"] || "(无)";
    if (cells.length > 0) {
      console.groupCollapsed(`[xiongmao] 行 ${shipment} 共 ${cells.length} 个 cell`);
      cells.forEach((cell, i) => {
        const t = compactText(cell);
        console.log(`  #${i}: ${JSON.stringify(t.slice(0, 100))}${t.length > 100 ? "..." : ""}`);
      });
      console.groupEnd();
    }

    // 1) 货件编号：扫所有 cell 找匹配
    for (const cell of cells) {
      const text = compactText(cell);
      const shipment = extractShipmentNumber(text);
      if (shipment) {
        row["货件编号"] = shipment;
        visited.add(cell);
        break;
      }
    }

    // 2) 照片：找含图且无货件编号/数量特征的 cell（多数情况下图片在单独的"照片"列）
    for (const cell of cells) {
      if (visited.has(cell)) continue;
      const img = cell.querySelector("img[src], img[data-src], img[srcset]");
      if (!img) continue;
      const text = compactText(cell);
      const hasShipment = extractShipmentNumber(text);
      const hasQuantity = /\d+\s*[个件双套条瓶盒只袋包箱架捆份盒台套组款枚块张片把卷桶]|\d+\s*шт\.?|\d+\s*пар\.?/i.test(text);
      if (hasShipment || hasQuantity) continue;
      // 找带 src 或 data-src 的图，且 cell 内主要内容是图（文字不超过 80 字符，宽松一些）
      const textLength = text.replace(/[\s\u00a0]/g, "").length;
      if (textLength <= 80) {
        row["照片"] = getImageUrl(img);
        visited.add(cell);
        break;
      }
    }

    // 3) 数量 + 货号 + 商品名称 + 兜底照片：找含 "个/件/双..." 的 cell
    for (const cell of cells) {
      if (visited.has(cell)) continue;
      const text = compactText(cell);
      const hasQuantityPattern = /\d*\s*[个件双套条瓶盒只袋包箱架捆份盒台套组款枚块张片把卷桶]|\d+\s*шт\.?|\d+\s*пар\.?/i.test(text);
      // 排除纯日期/价格 cell
      const isDate = /\d{4}[\/\-]\d{1,2}/.test(text) || /\d+\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(text);
      const isPrice = /\d+[.,]\d{2}\s*(₽|￥|¥|руб\.?|RUB|\$)/i.test(text);
      if (!hasQuantityPattern || isDate || isPrice) continue;
      const parsed = parseOrderQuantityCell(cell);
      if (!parsed) {
        console.log("[xiongmao] 3-跳过 cell: parseOrderQuantityCell 返回 null. text=", JSON.stringify(text.slice(0, 80)));
        continue;
      }
      console.log("[xiongmao] 3-命中 cell: text=", JSON.stringify(text.slice(0, 80)), "→ 数量=", parsed["数量"], "货号=", parsed["货号"]);
      if (parsed["数量"]) row["数量"] = parsed["数量"];
      if (parsed["货号"]) row["货号"] = parsed["货号"];
      if (parsed["商品名称"]) row["商品名称"] = parsed["商品名称"];
      // 兜底：数量 cell 自带图时也写到照片
      if (parsed["照片"] && !row["照片"]) row["照片"] = parsed["照片"];
      visited.add(cell);
      break;
    }

    // 3b) 照片兜底：上面都没抓到的话，扫一遍所有 cell 里的 img（不限文字长度）
    if (!row["照片"]) {
      for (const cell of cells) {
        if (visited.has(cell)) continue;
        const img = cell.querySelector("img[src], img[data-src], img[srcset]");
        if (!img) continue;
        row["照片"] = getImageUrl(img);
        visited.add(cell);
        break;
      }
    }

    // 3c) 货号/商品名称兜底：上面没匹配上数量模式时，扫所有 cell 找 SKU 字符串 + 商品名
    if (!row["货号"]) {
      // 优先：找 "数字 + 中文单位 + SKU" 模式（如 "1 个 LZ01-3864266225"）
      // 或俄文 "Артикул: ABC-12345" 模式（Ozon 俄文站常用）
      for (const cell of cells) {
        if (visited.has(cell)) continue;
        const text = compactText(cell);
        if (extractShipmentNumber(text)) continue;
        let sku = null;
        let m = text.match(new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:[个件双套条瓶盒只袋包箱架捆份盒台套组款枚块张片把卷桶]|шт\\.?|пар\\.?|уп\\.?|компл\\.?)\\s*([A-Za-z0-9][A-Za-z0-9_\\-]{3,})`, "i"));
        if (m) {
          sku = m[1];
        } else {
          // 俄文 "Артикул/Арт./SKU: ABC-12345"
          m = text.match(/(?:артикул|арт\.?|sku|модель|код)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_\-]{3,})/i);
          if (m) sku = m[1];
        }
        if (!sku) continue;
        if (/^(https|http|www|com|cn|ru|jpg|png|gif|webp)/i.test(sku)) continue;
        row["货号"] = sku;
        // 数量
        const qtyMatch = text.match(/(\d+(?:\.\d+)?\s*[个件双套条瓶盒只袋包箱架捆份盒台套组款枚块张片把卷桶])/);
        if (qtyMatch && !row["数量"]) row["数量"] = qtyMatch[1].replace(/\s+/g, "");
        // 剩余文字当商品名称
        const rest = text.replace(qtyMatch ? qtyMatch[0] : "", " ").replace(sku, " ").replace(/\s{2,}/g, " ").trim();
        if (rest && !row["商品名称"] && rest.length >= 3) {
          row["商品名称"] = rest;
        }
        visited.add(cell);
        console.log("[xiongmao] 3c-兜底 货号=", sku, "qty=", row["数量"], "rest=", rest.slice(0, 40));
        break;
      }
    }

    // 3d) 货号兜底②：扫所有 cell 找评分最高的候选 SKU（处理"商品名称 cell 整段是 SKU"的情况）
    if (!row["货号"]) {
      const candidates = [];
      for (const cell of cells) {
        if (visited.has(cell)) continue;
        const text = compactText(cell);
        if (extractShipmentNumber(text)) continue;
        const hasCyrillic = /[\u0400-\u04FF]/.test(text);
        const allMatches = [...text.matchAll(/\b([A-Za-z0-9][A-Za-z0-9_\-]{3,})\b/g)];
        for (const m of allMatches) {
          const c = m[1];
          if (/^(https|http|www|com|cn|ru|jpg|png|gif|webp)/i.test(c)) continue;
          if (c.length > 40) continue;
          if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i.test(c)) continue;
          const hasDigit = /\d/.test(c) ? 100 : 0;
          const hasSep = /[_\-]/.test(c) ? 10 : 0;
          const lenScore = Math.min(c.length, 25);
          const cellPenalty = hasCyrillic ? 0 : 30;
          const score = hasDigit + hasSep + lenScore - cellPenalty;
          if (score > 0) candidates.push({ cell, text, sku: c, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length > 0) {
        const best = candidates[0];
        row["货号"] = best.sku;
        const rest = best.text.replace(best.sku, " ").replace(/\s{2,}/g, " ").trim();
        if (rest && !row["商品名称"] && rest.length >= 3) {
          row["商品名称"] = rest;
        }
        visited.add(best.cell);
        console.log("[xiongmao] 3d-评分 货号=", best.sku, "score=", best.score, "rest=", rest.slice(0, 40));
      }
    }

    // 3e) 最后兜底：把 cell 整段文字当商品名称
    if (!row["货号"] && !row["商品名称"]) {
      for (const cell of cells) {
        if (visited.has(cell)) continue;
        const text = compactText(cell);
        if (extractShipmentNumber(text)) continue;
        if (!text || text.length < 2) continue;
        if (text.length > 200) continue;
        row["商品名称"] = text;
        visited.add(cell);
        console.log("[xiongmao] 3e-兜底 商品名称=", text.slice(0, 40));
        break;
      }
    }

    // 4) 状态：badge 短文本（等待备货、已签收、运输中等）
    for (const cell of cells) {
      if (visited.has(cell)) continue;
      const text = compactText(cell);
      if (
        text.length > 0 && text.length <= 16 &&
        /^(等待|已|未|运输|取消|完成|备货|发货|签收|配货|打包|拒收|退货|售后|缺货|拣选|打包|出库|在途|已发|已收)/.test(text) &&
        !extractShipmentNumber(text) &&
        !/\d+[.,]\d{2}/.test(text) &&
        !/月|日|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i.test(text)
      ) {
        row["状态"] = text;
        visited.add(cell);
        break;
      }
    }

    // 5) 已接收 / 发送日期：扫所有时间 cell，短的先接收，带"至"的为发送日期
    const dateCells = [];
    for (const cell of cells) {
      if (visited.has(cell)) continue;
      const text = compactText(cell);
      if (/\d+\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(text) || /\d+\s*月\s*\d+\s*日?/.test(text) || /\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/.test(text)) {
        dateCells.push({ cell, text });
      }
    }
    if (dateCells[0]) {
      row["已接收"] = dateCells[0].text;
      visited.add(dateCells[0].cell);
    }
    // 发送日期：优先含 "至"，否则第二个时间
    const send = dateCells.find((d) => /至/.test(d.text)) || dateCells[1];
    if (send) {
      row["发送日期"] = send.text;
      visited.add(send.cell);
    }

    // 6) 价格
    for (const cell of cells) {
      if (visited.has(cell)) continue;
      const text = compactText(cell);
      if (/\d+[.,]\d{2}\s*(₽|￥|¥|руб\.?|RUB|\$)/i.test(text)) {
        row["价格"] = text.replace(/\s+/g, " ").trim();
        visited.add(cell);
        break;
      }
    }

    // 7) 仓库：短文本 + 陆运/空运 等
    for (const cell of cells) {
      if (visited.has(cell)) continue;
      const text = compactText(cell);
      if (
        text.length > 0 && text.length <= 16 &&
        /^(CEL\s*)?[一-龥A-Za-z0-9]*?(陆运|空运|海运|铁路|自提|送货|集运|保税|海外|国内)/.test(text) ||
        /^(陆运|空运|海运|铁路|自提|送货|集运|保税|海外|国内)/.test(text)
      ) {
        row["仓库"] = text;
        visited.add(cell);
        break;
      }
    }

    // 8) 配送服务 / 方式：以 CEL 开头英文短串 = 配送服务；带 PUDO/Xiamen 等长文本 = 方式
    for (const cell of cells) {
      if (visited.has(cell)) continue;
      const text = compactText(cell);
      const firstLine = text.split(/\n|\r/)[0].trim();
      if (/^CEL\s/i.test(firstLine) && firstLine.length <= 35) {
        row["配送服务"] = firstLine;
        visited.add(cell);
        break;
      }
    }
    for (const cell of cells) {
      if (visited.has(cell)) continue;
      const text = compactText(cell);
      if (/PUDO|Xiamen|EMS|快递|物流|送货上门/i.test(text) && text.length > 20) {
        row["方式"] = text.replace(/\s+/g, " ").trim();
        visited.add(cell);
        break;
      }
    }

    // 9) 兜底：还剩的 cell 全部内容拼成"备注"，方便人工补（排除按钮等纯 UI）
    const leftovers = cells
      .filter((cell) => !visited.has(cell))
      .map((cell) => ({ cell, text: compactText(cell) }))
      .filter(({ text, cell }) => text && !cell.querySelector?.("button"));
    if (leftovers.length) row["备注"] = leftovers.map((l) => l.text).join(" | ");
  }

  function parseOrderFreeTextRow(element, row) {
    const text = compactText(element);
    const shipment = extractShipmentNumber(text);
    if (shipment) row["货件编号"] = shipment;

    const parsed = parseOrderQuantityText(text);
    if (parsed) {
      if (parsed["数量"]) row["数量"] = parsed["数量"];
      if (parsed["货号"]) row["货号"] = parsed["货号"];
      if (parsed["商品名称"]) row["商品名称"] = parsed["商品名称"];
    }

    const img = element.querySelector?.("img[src], img[data-src], img[srcset]");
    if (img) row["照片"] = getImageUrl(img);

    const priceMatch = text.match(/(\d[\d\s]*[.,]\d{2})\s*(₽|￥|¥|руб|RUB)/);
    if (priceMatch) row["价格"] = priceMatch[0];
  }

  function parseOrderQuantityCell(cell, soft = false) {
    if (!cell) return null;
    const text = compactText(cell);
    if (!text) return null;

    const imgEl = cell.querySelector?.("img[src], img[data-src], img[srcset]");
    const image = getImageUrl(imgEl);
    const parsed = parseOrderQuantityText(text);

    if (!parsed && !soft) return null;
    if (!parsed) return { "照片": image, "图片链接": image };

    return {
      "数量": parsed["数量"] || "",
      "货号": parsed["货号"] || "",
      "商品名称": parsed["商品名称"] || "",
      "照片": image,
      "图片链接": image
    };
  }

  function parseOrderQuantityText(text) {
    const normalized = compactText(text);
    if (!normalized) return null;

    // 1) 数量: 数字 + 中文/俄文单位（Ozon 中文站/俄文站通用）
    // 单位支持：个/件/双/套/.../瓶/盒/只/袋/包/箱/架/捆/份/盒/台/套/组/款/枚/块/张/片/把/卷/桶 + шт/пар/уп/компл
    const UNIT = "(?:[个件双套条瓶盒只袋包箱架捆份盒台套组款枚块张片把卷桶]|шт\\.?|пар\\.?|уп\\.?|компл\\.?)";
    const quantityMatch = normalized.match(new RegExp(`(\\d+(?:\\.\\d+)?\\s*${UNIT})`, "i"));
    if (!quantityMatch) return null;

    let cursor = quantityMatch.index + quantityMatch[0].length;
    let remainder = normalized.slice(cursor).trimStart();

    // 2) 货号: 字母或数字开头的字母数字串（含 - _），遇到空白、Cyrillic/中文等非 ASCII、或字符串结尾就停
    // 单位后到 SKU 之间允许 0+ 空白（"5盒LZ01" 这种紧贴的情况）
    // 同时用 [A-Z][a-z] 作为大小写边界（NSDJB-QIANLAN → Levany 这种"突然变小写"的位置），避免把商品名前缀也吞进 SKU
    const skuMatch = remainder.match(/^([A-Za-z0-9][A-Za-z0-9_\-]*?)(?=[A-Z][a-z]|\s|[^\x00-\x7F]|$)/);
    let sku = "";
    if (skuMatch) {
      sku = skuMatch[1];
      remainder = remainder.slice(sku.length).trimStart();
    }

    // 3) 商品名称: 去掉 SKU/价格/数字噪点后剩下的文字
    let name = remainder
      .replace(/\s*\d[\d\s.,]*\s*(₽|￥|¥|руб|RUB)\s*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    // 如果名字太短或包含奇怪的前缀（如纯数字），尝试再剥一层
    if (!name) {
      const tail = remainder.match(/[\u0400-\u04FFA-Za-z][\u0400-\u04FFA-Za-z0-9 ,，.·・/&-]+/);
      if (tail) name = tail[0].trim();
    }

    return {
      "数量": quantityMatch[1].replace(/\s+/g, ""),
      "货号": sku,
      "商品名称": name
    };
  }

  function normalizeOrderRow(row) {
    // 货件编号兜底
    if (!row["货件编号"]) {
      const all = Object.values(row).join(" ");
      const shipment = extractShipmentNumber(all);
      if (shipment) row["货件编号"] = shipment;
    }

    // 图片链接兜底
    if (!row["照片"]) {
      const img = [...document.querySelectorAll(`[data-row-key]`)]
        .find((el) => compactText(el).includes(row["货件编号"] || ""))?.querySelector("img[src], img[data-src], img[srcset]");
      if (img) row["照片"] = getImageUrl(img);
    }

    // 日期字段精确到日（去掉 "至07:00" / " 07:00" 等时间部分）
    for (const key of ["发送日期", "已接收", "不逾期"]) {
      if (row[key]) {
        row[key] = stripTimeOfDay(row[key]);
      }
    }

    // 清理杂质字段：只保留订单相关 + 货件级别额外列
    const allowed = new Set([
      "货件编号",
      "状态",
      "已接收",
      "发送日期",
      "不逾期",
      "照片",
      "数量",
      "货号",
      "商品名称",
      "价格",
      "仓库",
      "配送服务",
      "方式",
      "备货",
      "操作",
      "重量",
      "声明重量",
      "贴标",
      "拣选",
      "包装",
      "备货",
      "商品编号",
      "SKU",
      "品牌",
      "商品链接",
      "图片链接",
      "备注"
    ]);

    for (const key of Object.keys(row)) {
      if (!allowed.has(key) && !/^列\d+$/.test(key)) {
        delete row[key];
      }
    }

    // 删除重复的合并表头残留
    delete row["数量，货号"];
    delete row["数量，货号，商品名称"];
    delete row["商品信息"];
    delete row["商品信息，货号"];

    // 价格清洗
    if (row["价格"]) {
      row["价格"] = row["价格"].replace(/\s+/g, " ").trim();
    }
  }

  // 去掉日期字符串里的时间部分（"4 Jul 至07:00" → "4 Jul"；"28 Jun 22:00" → "28 Jun"；"2026/6/29 19:54" → "2026/6/29"）
  function stripTimeOfDay(value) {
    return String(value ?? "")
      .replace(/\s*(至|~|-|—|–|~)\s*\d{1,2}[:.：]\d{2}.*$/u, "")
      .replace(/\s+\d{1,2}[:.：]\d{2}(?::\d{2})?(?:\s*[+\-]\d{1,2}[:.]\d{2})?$/u, "")
      .replace(/\s+\d{1,2}[:.：]\d{2}.*$/u, "")
      .trim();
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
        if (!looksLikeProductText(element, text) && !looksLikeOrderText(element, text)) return false;
        if (text.length > 1000) return false;
        return ![...element.children].some((child) => {
          const childText = compactText(child);
          return looksLikeProductText(child, childText) || looksLikeOrderText(child, childText);
        });
      })
      .map((element) => {
        const row = {};
        if (looksLikeOrderText(element)) {
          parseOrderFreeTextRow(element, row);
        } else {
          parseFreeTextRow(element, KNOWN_COLUMNS, row);
        }
        return row;
      })
      .filter((row) => row.SKU || row["货件编号"] || row["货号"]);

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
    if (row["货件编号"]) return `shipment:${row["货件编号"]}`;
    if (row.SKU) return `sku:${row.SKU}`;
    if (row["货号"]) return `article:${row["货号"]}`;
    if (row["商品名称"]) return `title:${row["商品名称"]}`;
    return "";
  }

  function normalizeColumns(discoveredColumns, rows) {
    const present = new Set();
    rows.forEach((row) => Object.keys(row).forEach((column) => present.add(column)));

    const isOrderSheet = rows.some((row) => row["货件编号"]);
    const preferred = isOrderSheet
      ? ORDER_COLUMNS
      : [...PRODUCT_COLUMNS, "商品信息"];

    // preferred 全保留（即使 row 没有这个 key，也输出空列，保持用户期望的列序）
    const seen = new Set();
    const ordered = [];
    preferred.forEach((column) => {
      if (!seen.has(column)) {
        seen.add(column);
        ordered.push(column);
      }
    });

    // 其它 row 里出现、preferred 没有覆盖的 key 追加到末尾（不引入 discovered headers，避免 _2 / 拼接怪串）
    [...present].forEach((column) => {
      if (!seen.has(column)) {
        seen.add(column);
        ordered.push(column);
      }
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
    const shipmentRows = rows.filter((row) => row["货件编号"]).length;
    const knownColumnCount = columns.filter((column) => KNOWN_COLUMNS.includes(column)).length;
    return skuRows * 100 + shipmentRows * 120 + rows.length * 10 + columns.length + knownColumnCount * 20;
  }

  function scoreRoot(element) {
    const text = compactText(element);
    const knownColumnCount = KNOWN_COLUMNS.filter((column) => text.includes(column)).length;
    const skuCount = (text.match(/SKU\s*[:：]?\s*\d{5,}/gi) || []).length;
    const productIdCount = (text.match(/\b\d{7,12}\b/g) || []).length;
    const shipmentCount = (text.match(new RegExp(SHIPMENT_NUMBER_PATTERN.source, "g")) || []).length;
    const productTableBonus = text.includes("商品信息") || text.includes("所属类目") ? 200 : 0;
    const orderTableBonus = text.includes("货件编号") && text.includes("仓库") ? 260 : 0;
    const rect = element.getBoundingClientRect();
    return (
      skuCount * 100 +
      productIdCount * 12 +
      shipmentCount * 140 +
      productTableBonus +
      orderTableBonus +
      knownColumnCount * 25 +
      rect.width * rect.height / 100000
    );
  }

  function extractSku(text) {
    const match = String(text || "").match(/SKU\s*[:：]?\s*([A-Za-z0-9_-]{5,})/i);
    return match ? match[1].trim() : "";
  }

  function extractShipmentNumber(text) {
    const source = compactText(text);
    if (!source) return "";
    const match = source.match(SHIPMENT_NUMBER_PATTERN);
    return match ? match[0] : "";
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

  function getImageUrl(img) {
    if (!img) return "";
    const candidates = [
      img.currentSrc,
      parseBestSrcset(img.getAttribute("srcset")),
      img.getAttribute("data-src"),
      img.getAttribute("data-original"),
      img.getAttribute("data-lazy-src"),
      img.getAttribute("src")
    ].filter(Boolean);

    const preferred = candidates.find((url) => /^https?:\/\//i.test(url) && !/placeholder|blank|transparent/i.test(url)) ||
      candidates.find((url) => /^\/\//.test(url)) ||
      candidates.find((url) => url && !/^data:image\/svg/i.test(url)) ||
      "";

    if (!preferred) return "";
    try {
      return new URL(preferred, location.href).href;
    } catch {
      return preferred;
    }
  }

  function parseBestSrcset(srcset) {
    if (!srcset) return "";
    const candidates = srcset
      .split(",")
      .map((part) => {
        const [url, descriptor = ""] = part.trim().split(/\s+/);
        const width = parseInt(descriptor, 10) || 0;
        return { url, width };
      })
      .filter((item) => item.url);
    candidates.sort((a, b) => b.width - a.width);
    return candidates[0]?.url || "";
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
      // 把所有空白 + 零宽字符（\u200B 零宽空格、\u200C/D 零宽非连接/连接符、\uFEFF BOM 等）都归一为普通空格
      // Ozon 数量列常用 "1\u200B 个 LZ01-..."，原版只处理 \u00A0 会导致 "1 个" 匹配不上
      .replace(/[\s\u200B-\u200D\uFEFF]/g, " ")
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
    const orderBonus = text.includes("货件编号") ? 500 : 0;
    const columnBonus = KNOWN_COLUMNS.filter((column) => text.includes(column)).length * 60;
    const sizeBonus = rect.width * rect.height / 3000;
    const scrollBonus = direction === "horizontal"
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight;
    return skuBonus + orderBonus + columnBonus + sizeBonus + scrollBonus / 10;
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
