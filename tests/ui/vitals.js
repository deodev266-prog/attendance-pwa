// Lab measurement of Core Web Vitals on the real index.html (mock backend, CPU throttled 4x, 200ms fake API latency).
// Lab numbers are indicative only - real-user (field) data on real phones is what Google scores.
const { chromium } = (() => { try { return require('playwright'); } catch { return require('/opt/npm-tools/node_modules/playwright'); } })();
const fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8'), MOCK = fs.readFileSync(path.join(__dirname, 'mock.js'), 'utf8');
const PHOTO = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'avatar.png')).toString('base64');
const OBS = () => {
  window.__v = { lcp: 0, cls: 0, inp: 0, n: 0 };
  new PerformanceObserver(l => { for (const e of l.getEntries()) window.__v.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__v.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.interactionId) { window.__v.n++; window.__v.inp = Math.max(window.__v.inp, e.duration); } }).observe({ type: 'event', durationThreshold: 16, buffered: true });
};
async function run(browser, name, cfg, act) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(OBS); await page.addInitScript(c => { window.__cfg = c; }, { ...cfg, photo: PHOTO, delay: 200 });
  page.on('dialog', d => d.accept());
  await page.route('**/*', r => { const u = r.request().url(); if (u === 'http://app.test/') return r.fulfill({ contentType: 'text/html', body: HTML }); if (u.includes('cdn.jsdelivr.net')) return r.fulfill({ contentType: 'application/javascript', body: MOCK }); return r.abort(); });
  await page.goto('http://app.test/'); await page.waitForTimeout(1200); await act(page); await page.waitForTimeout(800);
  const v = await page.evaluate(() => window.__v); await ctx.close();
  const rate = (x, g, p) => x <= g ? 'good' : x <= p ? 'needs work' : 'poor';
  console.log(name.padEnd(34), 'LCP', (v.lcp / 1000).toFixed(2) + 's', rate(v.lcp, 2500, 4000).padEnd(10), 'CLS', v.cls.toFixed(3), rate(v.cls, .1, .25).padEnd(10), 'INP', v.n ? Math.round(v.inp) + 'ms ' + rate(v.inp, 200, 500) : 'n/a (no taps)');
  return v;
}
(async () => {
  const b = await chromium.launch();
  await run(b, 'Sign-in page', { role: 'none' }, async () => {});
  await run(b, 'Student dashboard', { role: 'student' }, async p => { await p.waitForSelector('text=My dashboard'); });
  await run(b, 'Student code entry (taps+verify)', { role: 'student' }, async p => {
    await p.waitForSelector('text=My dashboard'); await p.tap('text=Mark attendance'); await p.waitForSelector('.pad');
    for (const d of '246810') await p.tap(`.pad button:text-is("${d}")`); await p.tap('button.pill'); await p.waitForSelector('text=Attendance recorded'); });
  await run(b, 'Admin sessions + roster', { role: 'admin' }, async p => { await p.waitForSelector('text=Ada Obi'); await p.tap('text=Create session'); await p.waitForSelector('.code'); });
  await run(b, 'Admin report (1,506 rows)', { role: 'admin' }, async p => { await p.tap('.tabs >> text=Reports'); await p.tap('text=Preview report'); await p.waitForSelector('text=1506 rows'); });
  await b.close();
})();
