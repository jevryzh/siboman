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

    // 1. Dashboard Store Switcher
    console.log('--- Dashboard Store Switcher ---');
    await page.goto('http://test.renwz.cn/#/dashboard');
    await page.waitForTimeout(3000);
    const dashboardText = await page.evaluate(() => document.body.innerText);
    console.log('Dashboard Text Includes "未连接店铺":', dashboardText.includes('未连接店铺'));
    
    const storeTrigger = await page.$('text=未连接店铺');
    if (storeTrigger) {
        await storeTrigger.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'screenshots/dashboard_store_dropdown.png' });
    }

    // 2. Upload Page Cascader
    console.log('--- Upload Page Cascader ---');
    await page.goto('http://test.renwz.cn/#/products/upload');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/inspect_upload.png' });
    const uploadCascader = await page.$('.el-cascader, .el-select');
    if (uploadCascader) {
        console.log('Found cascader/select in Upload page');
        await uploadCascader.click();
        await page.waitForTimeout(1000);
        await page.screenshot({ path: 'screenshots/upload_cascader_open.png' });
    }

    // 3. Order Page - Look for merge print in detail or more actions
    console.log('--- Order Page - Action Search ---');
    await page.goto('http://test.renwz.cn/#/orders/list');
    await page.waitForTimeout(3000);
    
    // Select all
    await page.evaluate(() => {
        const cb = document.querySelector('.el-table__header .el-checkbox__input');
        if (cb) cb.click();
    });
    await page.waitForTimeout(1000);
    
    // Look for "详情" or other buttons that might have dropdowns
    const detailBtns = await page.$$('button:has-text("详情")');
    if (detailBtns.length > 0) {
        await detailBtns[0].click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'screenshots/order_detail.png' });
        // Close detail if it's a dialog
        await page.keyboard.press('Escape');
    }

  } catch (error) {
    console.error(error);
  } finally {
    await browser.close();
  }
}

run();
