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

    // 1. Find Cascader in Product List or Category Analysis
    console.log('--- Search for Cascader ---');
    await page.goto('http://test.renwz.cn/#/products/list');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/inspect_products.png' });
    
    // Check for any input that looks like a cascader
    const cascaderSearch = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('.el-cascader, .el-select, input[placeholder*="分类"], input[placeholder*="类目"]'));
        return els.map(el => ({
            className: el.className,
            placeholder: el.placeholder || el.getAttribute('placeholder'),
            innerText: el.innerText
        }));
    });
    console.log('Cascader Search (Products):', cascaderSearch);

    // 2. Select Orders and search for Merge Print
    console.log('--- Search for Merge Print ---');
    await page.goto('http://test.renwz.cn/#/orders/list');
    await page.waitForTimeout(3000);
    
    // Select all checkboxes in the table
    await page.evaluate(() => {
        const checkboxes = document.querySelectorAll('.el-table__header .el-checkbox__input, .el-table__row .el-checkbox__input');
        checkboxes.forEach(cb => cb.click());
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'screenshots/inspect_orders_selected.png' });
    
    const buttonsAfterSelection = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim());
    });
    console.log('Buttons after selection:', buttonsAfterSelection);

    // 3. Inspect branding area for Store Switcher
    console.log('--- Inspect Store Switcher ---');
    const brandingText = await page.evaluate(() => {
        const branding = document.querySelector('div[class*="logo"], div[class*="brand"], div[class*="title"]');
        return branding ? branding.innerText : 'Not found';
    });
    console.log('Branding Text:', brandingText);
    
    // Try clicking the text "未连接店铺"
    const unlinkedStore = await page.$('text=未连接店铺');
    if (unlinkedStore) {
        console.log('Found "未连接店铺", clicking...');
        await unlinkedStore.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'screenshots/inspect_store_dropdown.png' });
    }

  } catch (error) {
    console.error(error);
  } finally {
    await browser.close();
  }
}

run();
