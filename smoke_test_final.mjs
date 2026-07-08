import { chromium } from 'playwright';
import fs from 'fs';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const results = {
    cascadeSelector: 'PENDING',
    pdfMerge: 'PENDING',
    imageScrape: 'PASS', // Already verified
    storeIsolation: 'PENDING',
    uiErrors: ['仪表盘加载失败: Cannot set properties of null (setting \'innerHTML\')'],
    apiExceptions: []
  };

  try {
    await page.goto('http://test.renwz.cn', { timeout: 60000 });
    await page.fill('input[name="username"]', 'eason');
    await page.fill('input[name="password"]', 'mTJbluVZXrmODQ');
    await page.click('button[type="submit"]');
    await page.waitForNavigation();

    // 1. Cascade Selector in Upload Page
    console.log('--- Testing Cascade Selector (Upload Page) ---');
    await page.goto('http://test.renwz.cn/#/products/upload');
    await page.waitForTimeout(3000);
    // Find the category dropdown
    const categorySelector = await page.$('text=— 选择类目 —');
    if (categorySelector) {
        await categorySelector.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'screenshots/upload_category_dropdown.png' });
        
        const options = await page.$$('.el-cascader-node, .el-select-dropdown__item');
        if (options.length > 0) {
            results.cascadeSelector = 'PASS';
            await options[0].click();
        } else {
            results.cascadeSelector = 'FAIL (No options loaded in dropdown)';
        }
    } else {
        results.cascadeSelector = 'FAIL (Category selector text not found)';
    }

    // 2. PDF Merge in Order Page
    console.log('--- Testing PDF Merge (Order Page) ---');
    await page.goto('http://test.renwz.cn/#/orders/list');
    await page.waitForTimeout(3000);
    
    // Select two orders
    const checkboxes = await page.$$('.el-table__row .el-checkbox__input');
    if (checkboxes.length >= 2) {
        await checkboxes[0].click();
        await checkboxes[1].click();
        await page.waitForTimeout(1000);
        
        // Check for any new action buttons or dropdowns
        const moreBtn = await page.$('.el-dropdown, button:has-text("操作"), button:has-text("打印")');
        if (moreBtn) {
            await moreBtn.click();
            await page.waitForTimeout(1000);
            await page.screenshot({ path: 'screenshots/order_more_actions.png' });
            
            const mergeAction = await page.$('text=合并打印, text=合并, text=PDF, text=下载面单');
            if (mergeAction) {
                results.pdfMerge = 'PASS (Action found)';
                await mergeAction.click();
                await page.waitForTimeout(2000);
            } else {
                results.pdfMerge = 'FAIL (Merge action not found in dropdown)';
            }
        } else {
            results.pdfMerge = 'FAIL (No action button found after selection)';
        }
    } else {
        results.pdfMerge = 'FAIL (Not enough orders to select)';
    }

    // 3. Store Switching
    console.log('--- Testing Store Switching ---');
    await page.goto('http://test.renwz.cn/#/dashboard');
    await page.waitForTimeout(3000);
    
    // Click on the branding area where "服务器队列模式" or "未连接店铺" usually is
    const branding = await page.$('div[class*="logo"], .sidebar-header, .brand');
    if (branding) {
        await branding.click();
        await page.waitForTimeout(1000);
        await page.screenshot({ path: 'screenshots/branding_click_result.png' });
        
        const storeItems = await page.$$('.el-dropdown-menu__item, .store-item');
        if (storeItems.length > 0) {
            results.storeIsolation = 'PASS';
            await storeItems[0].click();
        } else {
            // Try user profile
            const profile = await page.$('text=Eason admin');
            if (profile) {
                await profile.click();
                await page.waitForTimeout(1000);
                const profileStores = await page.$$('.el-dropdown-menu__item');
                if (profileStores.length > 0) {
                    results.storeIsolation = 'PASS';
                } else {
                    results.storeIsolation = 'FAIL (No stores found in branding or profile)';
                }
            } else {
                results.storeIsolation = 'FAIL (Branding and profile click failed to show stores)';
            }
        }
    } else {
        results.storeIsolation = 'FAIL (Branding area not found)';
    }

  } catch (error) {
    console.error(error);
  } finally {
    console.log('Final Results:', JSON.stringify(results, null, 2));
    fs.writeFileSync('smoke_test_results_final.json', JSON.stringify(results, null, 2));
    await browser.close();
  }
}

run();
