import { chromium } from 'playwright';
import fs from 'fs';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const debugInfo = {
    consoleErrors: [],
    networkLogs: [],
    localStorage: {},
    hiddenButtons: [],
    categoryApi: null
  };

  // 1. Monitor Network
  page.on('request', request => {
    debugInfo.networkLogs.push({
      method: request.method(),
      url: request.url(),
      type: request.resourceType()
    });
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('api')) {
      let body = 'Error reading body';
      try { body = await response.json(); } catch (e) { body = 'Not JSON'; }
      debugInfo.networkLogs.push({
        url: url,
        status: response.status(),
        body: body
      });
    }
  });

  // 2. Monitor Console with Stack Trace
  page.on('console', msg => {
    if (msg.type() === 'error') {
      debugInfo.consoleErrors.push({
        text: msg.text(),
        location: msg.location()
      });
    }
  });

  try {
    console.log('--- Debug Session Start ---');
    await page.goto('http://test.renwz.cn', { timeout: 60000 });
    await page.fill('input[name="username"]', 'eason');
    await page.fill('input[name="password"]', 'mTJbluVZXrmODQ');
    await page.click('button[type="submit"]');
    await page.waitForNavigation();

    // Debug Task 1: innerHTML crash
    console.log('Wait for dashboard errors...');
    await page.waitForTimeout(5000);

    // Debug Task 4: LocalStorage & Store ID
    debugInfo.localStorage = await page.evaluate(() => {
        const storage = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            storage[key] = localStorage.getItem(key);
        }
        return storage;
    });

    // Debug Task 2: PDF Buttons
    await page.goto('http://test.renwz.cn/#/orders/list');
    await page.waitForTimeout(3000);
    
    // Select orders to trigger potential UI changes
    await page.evaluate(() => {
        const cb = document.querySelector('.el-table__header .el-checkbox__input');
        if (cb) cb.click();
    });
    await page.waitForTimeout(1000);

    debugInfo.hiddenButtons = await page.evaluate(() => {
        const keywords = ['打印', '面单', 'PDF', '合并', 'Print', 'Label'];
        return Array.from(document.querySelectorAll('button, a, div[role="button"]'))
            .filter(el => {
                const text = el.innerText || '';
                const matches = keywords.some(k => text.includes(k));
                if (!matches) return false;
                const style = window.getComputedStyle(el);
                return style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0 || el.offsetHeight === 0;
            })
            .map(el => ({
                text: (el.innerText || '').trim(),
                className: el.className,
                style: {
                    display: window.getComputedStyle(el).display,
                    visibility: window.getComputedStyle(el).visibility,
                    zIndex: window.getComputedStyle(el).zIndex
                }
            }));
    });

    // Debug Task 3: Category Tree
    await page.goto('http://test.renwz.cn/#/products/upload');
    await page.waitForTimeout(2000);
    const categorySelector = await page.$('text=— 选择类目 —');
    if (categorySelector) {
        await categorySelector.click();
        await page.waitForTimeout(3000);
    }

  } catch (error) {
    console.error('Debug session failed:', error);
  } finally {
    console.log('Debug Results saved.');
    fs.writeFileSync('debug_report.json', JSON.stringify(debugInfo, null, 2));
    await browser.close();
  }
}

run();
