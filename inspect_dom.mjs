import { chromium } from 'playwright';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto('http://test.renwz.cn', { timeout: 60000 });
    if (page.url().includes('login') || await page.$('input[name="username"]')) {
      await page.fill('input[name="username"]', 'eason');
      await page.fill('input[name="password"]', 'mTJbluVZXrmODQ');
      await page.click('button[type="submit"]');
      await page.waitForNavigation();
    }

    console.log('--- Page: Dashboard ---');
    await page.screenshot({ path: 'screenshots/inspect_dashboard.png' });

    // Inspect Store Switcher
    const storeSwitchCandidates = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.el-dropdown, .el-select, .shop-select, div[class*="store"], div[class*="shop"]'))
            .map(el => ({
                tagName: el.tagName,
                className: el.className,
                innerText: el.innerText.substring(0, 50)
            }));
    });
    console.log('Store Switch Candidates:', JSON.stringify(storeSwitchCandidates, null, 2));

    // Inspect Orders page
    await page.goto('http://test.renwz.cn/#/orders/list');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/inspect_orders.png' });
    const orderButtons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim());
    });
    console.log('Order Page Buttons:', orderButtons);

    // Inspect Sourcing page
    await page.goto('http://test.renwz.cn/#/sourcing/batch');
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'screenshots/inspect_sourcing.png' });
    const sourcingElements = await page.evaluate(() => {
        return {
            textareas: document.querySelectorAll('textarea').length,
            inputs: document.querySelectorAll('input').length,
            buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim())
        };
    });
    console.log('Sourcing Page Elements:', sourcingElements);

  } catch (error) {
    console.error(error);
  } finally {
    await browser.close();
  }
}

run();
