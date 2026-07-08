import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  console.log('Navigating to login page...');
  try {
    await page.goto('http://test.renwz.cn', { timeout: 60000 });
    
    // Check if we are already logged in or need to log in
    if (page.url().includes('login') || await page.$('input[name="username"]')) {
      console.log('Logging in...');
      await page.fill('input[name="username"]', 'eason');
      await page.fill('input[name="password"]', 'mTJbluVZXrmODQ');
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ timeout: 60000 });
    }

    console.log('Current URL:', page.url());
    await page.screenshot({ path: 'screenshots/dashboard.png', fullPage: true });
    console.log('Screenshot saved to screenshots/dashboard.png');

    // List links/menu items to help identify navigation
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.innerText.trim(),
        href: a.getAttribute('href')
      })).filter(l => l.text);
    });
    console.log('Available links:', JSON.stringify(links, null, 2));

  } catch (error) {
    console.error('Error:', error);
    await page.screenshot({ path: 'screenshots/error.png' });
  } finally {
    await browser.close();
  }
}

run();
