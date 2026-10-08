// Optional visual smoke check: requires Playwright and a server on port 8000.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import { SYMBOLS,isSession,expectedSession } from '../js/market-data.js';
const browser=await chromium.launch({headless:true});
try {
  for(const width of [390,1280]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const now=new Date(), end=expectedSession(now),year=now.getUTCFullYear();
    const rows=[];
    for(let d=new Date(`${year-1}-12-01T00:00Z`);d.toISOString().slice(0,10)<=end;d=new Date(+d+86400000)) {
      const date=d.toISOString().slice(0,10);if(isSession(date)) rows.push({date,close:100,adjustedClose:date===end?90:100});
    }
    let calls=0;
    await page.route('**/data/market-data.json?*',async route=>{
      calls++;
      if(calls===3) return route.abort();
      const funds= calls===1?{}:Object.fromEntries(SYMBOLS.map(symbol=>[symbol,{symbol,rows}]));
      await route.fulfill({json:{schemaVersion:1,attemptedAt:now.toISOString(),funds}});
    });
    await page.goto('http://localhost:8000');
    await page.waitForFunction(()=>document.querySelector('#dataStatus').textContent.includes('Last refresh attempt:'));
    await page.waitForFunction(()=>!document.querySelector('#refreshButton').disabled);
    assert.match(await page.locator('#dataBadge').textContent(),/unavailable/);
    assert.equal(await page.locator('.card').count(),5);
    await page.locator('#refreshButton').click();
    await page.waitForFunction(()=>document.querySelector('.card-ytd').textContent.includes('-10.00%'));
    assert.equal(await page.locator('.negative').count(),10);
    assert.match(await page.locator('#dataBadge').textContent(),/End-of-day/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
    await page.locator('#refreshButton').click();
    await page.waitForFunction(()=>document.querySelector('#dataStatus').textContent.includes('Unable to load'));
    assert.match(await page.locator('.card-ytd').first().textContent(),/-10.00%/);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:`/tmp/etf-${width}.png`,fullPage:true});
    await page.close();console.log(`Browser ${width}px: unavailable, fresh negative returns, refresh failure retention, no overflow or JS errors passed`);
  }
} finally {await browser.close();}
