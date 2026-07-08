import { chromium } from 'playwright';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto('http://test.renwz.cn', { timeout: 60000 });
    await page.fill('input[name="username"]', 'eason');
    await page.fill('input[name="password"]', 'mTJbluVZXrmODQ');
    await page.click('button[type="submit"]');
    await page.waitForNavigation();

    console.log('--- Testing 1688 Image Scrape Result ---');
    await page.goto('http://test.renwz.cn/#/sourcing/batch');
    await page.waitForTimeout(2000);
    
    const inputs = await page.$$('input');
    await inputs[0].fill('https://www.ozon.ru/product/1660183171/');
    await page.click('button:has-text("开始批量采集")');
    
    console.log('Waiting 30s for scraping...');
    await page.waitForTimeout(30000);
    await page.screenshot({ path: 'screenshots/scraping_result_final.png' });
    
    const resultsTable = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.el-table__row'));
        return rows.map(row => ({
            ozon: row.querySelector('td:nth-child(1)')?.innerText,
            status: row.querySelector('td:nth-child(4)')?.innerText,
            images: Array.from(row.querySelectorAll('img')).map(img => img.src)
        }));
    });
    console.log('Scraping Results:', JSON.stringify(resultsTable, null, 2));

  } catch (error) {
    console.error(error);
  } finally {
    await browser.close();
  }
}

run();
