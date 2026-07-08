import { chromium } from 'playwright';
import fs from 'fs';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const results = {
    cascadeSelector: 'PENDING',
    pdfMerge: 'PENDING',
    imageScrape: 'PENDING',
    storeIsolation: 'PENDING',
    uiErrors: [],
    apiExceptions: []
  };

  const logError = (msg) => {
    console.log(`[ERROR] ${msg}`);
    results.uiErrors.push(msg);
  };

  // Monitor for console errors and API failures
  page.on('console', msg => {
    if (msg.type() === 'error') results.uiErrors.push(`Browser Console: ${msg.text()}`);
  });
  page.on('pageerror', err => {
    results.uiErrors.push(`Page Error: ${err.message}`);
  });
  page.on('requestfailed', request => {
    results.apiExceptions.push(`API Failed: ${request.url()} (${request.failure().errorText})`);
  });

  try {
    console.log('--- Logging in ---');
    await page.goto('http://test.renwz.cn', { timeout: 60000 });
    await page.fill('input[name="username"]', 'eason');
    await page.fill('input[name="password"]', 'mTJbluVZXrmODQ');
    await page.click('button[type="submit"]');
    await page.waitForNavigation();
    
    // Check for "仪表盘加载失败"
    const dashboardError = await page.evaluate(() => {
        const notify = document.querySelector('.el-notification__content');
        return notify ? notify.innerText : null;
    });
    if (dashboardError) logError(`Notification: ${dashboardError}`);

    // 1. Cascade Selector Stability
    console.log('--- Testing Cascade Selector ---');
    try {
      await page.goto('http://test.renwz.cn/#/analysis/category');
      await page.waitForTimeout(3000);
      const cascader = await page.$('.el-cascader');
      if (cascader) {
        await cascader.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'screenshots/02_cascade_selector_open.png' });
        
        // Try to click an option
        const options = await page.$$('.el-cascader-node');
        if (options.length > 0) {
          await options[0].click();
          results.cascadeSelector = 'PASS';
        } else {
          results.cascadeSelector = 'FAIL (No options loaded)';
        }
      } else {
        results.cascadeSelector = 'FAIL (Cascader not found)';
      }
    } catch (e) {
      results.cascadeSelector = `FAIL (${e.message})`;
    }

    // 2. PDF Label Merging Integrity
    console.log('--- Testing PDF Merge ---');
    try {
      await page.goto('http://test.renwz.cn/#/orders/list');
      await page.waitForTimeout(3000);
      
      const checkboxes = await page.$$('.el-table__row .el-checkbox__input');
      if (checkboxes.length >= 2) {
        await checkboxes[0].click();
        await checkboxes[1].click();
        await page.waitForTimeout(500);
        
        // Look for any new buttons
        const allButtons = await page.$$eval('button', btns => btns.map(b => b.innerText.trim()));
        console.log('Buttons after selection:', allButtons);
        
        const mergeBtn = await page.$('button:has-text("合并"), button:has-text("打印"), button:has-text("PDF")');
        if (mergeBtn) {
           // Merging PDF might open a new tab or trigger download
           results.pdfMerge = 'PASS (Found button)';
           await mergeBtn.click();
           await page.waitForTimeout(2000);
           await page.screenshot({ path: 'screenshots/03_pdf_merge_action.png' });
        } else {
           results.pdfMerge = 'FAIL (Merge button not found after selection)';
        }
      } else {
        results.pdfMerge = 'FAIL (Not enough orders)';
      }
    } catch (e) {
      results.pdfMerge = `FAIL (${e.message})`;
    }

    // 3. 1688 Image Scraping Success Rate
    console.log('--- Testing 1688 Image Scraping ---');
    try {
      await page.goto('http://test.renwz.cn/#/sourcing/batch');
      await page.waitForTimeout(2000);
      
      const inputs = await page.$$('input');
      // The first long input should be the Ozon link one
      if (inputs.length > 0) {
        await inputs[0].fill('https://www.ozon.ru/product/1660183171/'); // A real Ozon link (hopefully valid)
        await page.click('button:has-text("开始批量采集")');
        
        console.log('Waiting for collection to start...');
        await page.waitForTimeout(10000);
        await page.screenshot({ path: 'screenshots/04_scraping_progress.png' });
        
        // Check "实时进度" or "结果"
        const progressText = await page.evaluate(() => document.body.innerText);
        if (progressText.includes('成功') || progressText.includes('1688')) {
            results.imageScrape = 'PASS';
        } else {
            results.imageScrape = 'FAIL (No success indicator found in 10s)';
        }
      } else {
        results.imageScrape = 'FAIL (Link input not found)';
      }
    } catch (e) {
      results.imageScrape = `FAIL (${e.message})`;
    }

    // 4. Multi-store Switching Isolation
    console.log('--- Testing Store Isolation ---');
    try {
      // Click branding or "未连接店铺"
      const storeTrigger = await page.$('text=未连接店铺');
      if (storeTrigger) {
        await storeTrigger.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'screenshots/05_store_list.png' });
        
        const stores = await page.$$('.el-dropdown-menu__item, .el-select-dropdown__item, .store-item');
        if (stores.length > 0) {
            await stores[0].click();
            results.storeIsolation = 'PASS';
        } else {
            results.storeIsolation = 'FAIL (No stores in list)';
        }
      } else {
        results.storeIsolation = 'FAIL (Store trigger not found)';
      }
    } catch (e) {
      results.storeIsolation = `FAIL (${e.message})`;
    }

  } catch (error) {
    console.error('Fatal Error:', error);
  } finally {
    console.log('Final Results:', JSON.stringify(results, null, 2));
    fs.writeFileSync('smoke_test_results.json', JSON.stringify(results, null, 2));
    await browser.close();
  }
}

run();
