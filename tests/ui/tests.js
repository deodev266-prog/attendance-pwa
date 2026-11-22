const { chromium } = (() => { try { return require('playwright'); } catch { return require('/opt/npm-tools/node_modules/playwright'); } })();
const fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const MOCK = fs.readFileSync(path.join(__dirname, 'mock.js'), 'utf8');
const PHOTO = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'avatar.png')).toString('base64');
let pass = 0, fail = 0; const log = (ok, name, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : '  -> ' + extra)); };

async function open(browser, cfg, shot) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, acceptDownloads: true });
  const page = await ctx.newPage(); const errors = []; page.errors = errors;
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.addInitScript(c => { window.__cfg = c; }, { ...cfg, photo: PHOTO });
  await page.route('**/*', r => { const u = r.request().url();
    if (u === 'http://app.test/') return r.fulfill({ contentType: 'text/html', body: HTML });
    if (u.includes('cdn.jsdelivr.net')) return r.fulfill({ contentType: 'application/javascript', body: MOCK });
    return r.abort(); });
  await page.goto('http://app.test/');
  return page;
}
fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
const calls = (p, f) => p.evaluate(() => window.__calls).then(c => f ? c.filter(f) : c);
const called = (p, n, k = 1) => p.waitForFunction(([n, k]) => window.__calls.filter(c => c.n === n).length >= k, [n, k]);
const snap = (p, n) => p.screenshot({ path: path.join(__dirname, 'shots', n + '.png') });
const txt = p => p.evaluate(() => document.body.innerText);

(async () => {
  const browser = await chromium.launch();

  // ===== 1. STUDENT: dashboard -> code screen -> wrong code -> right code =====
  let p = await open(browser, { role: 'student' });
  await p.waitForSelector('text=My dashboard');
  let t = await txt(p);
  log(t.includes('FEDERAL UNIVERSITY OF DEVELOPMENT AND AGRICULTURE STUDIES IRABIGI'), 'school name shown on student dashboard');
  const sch = await p.evaluate(() => { const e = document.querySelector('.school'); const c = getComputedStyle(e); return { color: c.color, weight: c.fontWeight, border: c.borderBottomWidth }; });
  log(sch.color === 'rgb(10, 125, 44)' && +sch.weight >= 700 && sch.border === '4px', 'school name is thick green (bold + 4px green rule)', JSON.stringify(sch));
  log(t.includes('80%') && t.includes('8 of 10 sessions'), 'dashboard shows attendance percentage', t.slice(0, 200));
  log(await p.locator('.av img').count() === 1, 'dashboard shows student photo');
  await snap(p, '1a-student-dashboard');
  await p.click('text=Mark attendance');
  await p.waitForSelector('.pad');
  t = await txt(p);
  log(t.includes('Tamu Student') && t.includes('U2024/001') && await p.locator('.av.lg img').count() === 1, 'code screen shows student photo + name + matric before code entry');
  log(await p.locator('input').count() === 0, 'no text input on code screen (keypad only, nothing for the code to leak into)');
  await snap(p, '1b-code-screen-empty');
  for (const d of '246811') await p.click(`.pad button:text-is("${d}")`);
  log(await p.locator('.box.on').count() === 6, 'six masked boxes fill as digits are pressed');
  log((await p.locator('button.pill').getAttribute('class')).includes('go'), 'Verify turns active at 6 digits');
  log(!(await txt(p)).includes('246811'), 'typed digits are never shown on screen (masked)');
  await snap(p, '1c-code-filled');
  await p.click('button.pill');
  await p.waitForSelector('text=Please enter the valid code');
  t = await txt(p);
  log(t.includes('4 attempt(s) left') && await p.locator('.box.on').count() === 0, 'wrong code -> red error, attempts left, boxes cleared', t);
  await snap(p, '1d-wrong-code');
  for (const d of '246810') await p.click(`.pad button:text-is("${d}")`);
  await p.click('button.pill'); await p.waitForSelector('text=Attendance recorded');
  log(true, 'correct code -> success screen');
  log(!(await txt(p)).includes('246810'), 'code not visible anywhere after success');
  await snap(p, '1e-success');
  const mk = await calls(p, c => c.n === 'mark_attendance');
  log(mk.length === 2 && mk[0].args.p_session_id === 's1' && /^\d{6}$/.test(mk[1].args.p_code), 'mark_attendance RPC called with session id + 6-digit code', JSON.stringify(mk.map(m => m.args)));
  // shield on blur (screen-capture deterrent)
  await p.click('text=Mark attendance').catch(() => {});
  log(p.errors.length === 0, 'no JS errors in student flow', p.errors.join(' | '));
  await p.close();

  // student with no open session
  p = await open(browser, { role: 'student', noSession: true });
  await p.waitForSelector('text=My dashboard'); await p.click('text=Mark attendance');
  await p.waitForSelector('text=No open attendance session');
  log(true, 'empty state when no open session'); await p.close();

  // ===== 2. NEW STUDENT: registration with photo + terms =====
  p = await open(browser, { role: 'newstudent' });
  await p.waitForSelector('text=Student registration');
  await snap(p, '2a-registration');
  const fi = await p.evaluate(() => { const f = document.querySelector('input[type=file]'); return { capture: f.hasAttribute('capture'), accept: f.accept }; });
  log(!fi.capture && fi.accept.includes('image/jpeg'), 'photo input has no camera-only capture flag (opens the device file picker)', JSON.stringify(fi));
  t = await txt(p); log(t.includes('Registration number') && !/matric/i.test(t), 'form says "Registration number" (no "matric" wording)');
  const lv = await p.locator('select').nth(1).locator('option').allInnerTexts();
  log(JSON.stringify(lv) === JSON.stringify(['Select level', '100', '200', '300', '400']), 'level is a dropdown with exactly 100, 200, 300, 400', JSON.stringify(lv));
  const dp = await p.locator('select').nth(0).locator('option').allInnerTexts();
  log(JSON.stringify(dp) === JSON.stringify(['Select department', 'Agronomy', 'Plant Science (Botany)', 'Cyber Security · New']), 'department dropdown lists departments (with description and New tag)', JSON.stringify(dp));
  const og = await p.locator('select').nth(0).locator('optgroup').evaluateAll(o => o.map(x => x.label));
  log(og.length === 2 && og[0].startsWith('Faculty of Agriculture') && og[1] === 'Faculty of Natural and Applied Sciences', 'departments are grouped under their faculty', JSON.stringify(og));
  await p.click('text=Continue'); await p.waitForSelector('text=from your device');
  log(true, 'blocked without photo');
  await p.setInputFiles('input[type=file]', path.join(__dirname, 'face.jpg'));
  await p.waitForSelector('.av.lg img'); log(true, 'photo preview appears after choosing a picture');
  await p.fill('input[placeholder="Enter your registration number"]', 'U2024/777'); await p.locator('select').nth(0).selectOption('d1');
  await p.click('text=Continue'); await p.waitForSelector('text=including department and level');
  log(true, 'blocked until a level is chosen');
  await p.locator('select').nth(1).selectOption('200');
  await p.click('text=Continue'); await p.waitForSelector('text=Terms and Conditions', { state: 'visible' });
  t = await txt(p); log(t.includes('You must accept the Terms'), 'blocked until Terms accepted', t.slice(-200));
  await p.click('summary'); await snap(p, '2b-terms-open');
  const tt = await p.locator('.terms').innerText(); log(tt.includes('deodev266@gmail.com') && tt.includes('09152649961'), 'terms text shows support contact');
  await p.check('input[type=checkbox]'); await p.click('text=Continue');
  await p.waitForSelector('text=Select your courses');
  const up = (await calls(p, c => c.n === 'upload'))[0], ins = (await calls(p, c => c.op === 'insert'))[0];
  log(up && /^u1\/avatar\.(webp|jpg)$/.test(up.path) && /^image\/(webp|jpeg)$/.test(up.type) && up.o.contentType === up.type && Math.max(up.w, up.h) <= 360 && up.size < 40000, 'photo resized to <=360px, encoded as WebP (JPEG fallback) and uploaded to own folder', JSON.stringify(up));
  log(ins && /^u1\/avatar\.(webp|jpg)$/.test(ins.payload.photo_path) && /^data:image\//.test(ins.payload.photo_lqip) && ins.payload.photo_lqip.length < 3000 && !!ins.payload.terms_accepted_at && ins.payload.terms_version === '1.0' && ins.payload.matric_no === 'U2024/777' && ins.payload.level === '200', 'student row saved with photo path + terms acceptance', JSON.stringify(ins && ins.payload));
  await snap(p, '2c-courses');
  log(p.errors.length === 0, 'no JS errors in registration flow', p.errors.join(' | ')); await p.close();

  // ===== 3. ADMIN (primary): sessions, code controls, admins, students =====
  p = await open(browser, { role: 'admin' });
  await p.waitForSelector('text=Attendance sessions');
  t = await txt(p); log(t.includes('FEDERAL UNIVERSITY') && t.includes('Active (1)') && t.includes('Completed'), 'admin sessions page + school name + active/completed lists');
  await p.waitForSelector('text=Ada Obi'); log((await p.locator('label.chk').count()) === 3, 'roster shows registered students with checkboxes');
  await snap(p, '3a-admin-sessions');
  await p.click('text=Create session'); await p.waitForSelector('.code');
  log((await p.locator('.code').innerText()) === '••••••', 'new session: code hidden by default');
  await p.locator('text=Hold to show code').dispatchEvent('pointerdown');
  log((await p.locator('.code').innerText()) === '246810', 'hold-to-show reveals the code (decrypted by server RPC)');
  await snap(p, '3b-code-revealed');
  await p.locator('text=Hold to show code').dispatchEvent('pointerup');
  log((await p.locator('.code').innerText()) === '••••••', 'releasing hides the code again');
  await p.evaluate(() => window.dispatchEvent(new Event('blur')));
  log(await p.evaluate(() => document.body.classList.contains('shield')), 'screen shield activates when app loses focus');
  await p.evaluate(() => window.dispatchEvent(new Event('focus')));
  await p.fill('input[placeholder="6 digits"]', '123'); await p.click('text=Set my own code'); await p.waitForSelector('text=Enter exactly 6 digits');
  log(true, 'custom code must be 6 digits');
  await p.fill('input[placeholder="6 digits"]', '135790'); await p.click('text=Set my own code'); await called(p, 'set_session_code');
  await p.waitForSelector('text=Attendance code');
  log((await calls(p, c => c.n === 'set_session_code'))[0]?.args.p_code === '135790', 'set_session_code RPC called with custom code');
  await p.fill('input[type=number]', '45'); await p.click('text=Update time'); await called(p, 'set_session_expiry');
  await p.waitForSelector('text=Session time');
  log((await calls(p, c => c.n === 'set_session_expiry'))[0]?.args.p_minutes === 45, 'set_session_expiry RPC called with 45 minutes');
  await p.click('text=Close session now'); await called(p, 'close_attendance_session'); await p.waitForSelector('text=Session time');
  log((await calls(p, c => c.n === 'close_attendance_session')).length === 1, 'close_attendance_session RPC called');
  t = await txt(p); log(t.includes('Locked · Unlock') && t.includes('Ada Obi') && t.includes('Present'), 'records list shows present student and locked student with Unlock');
  await p.click('text=Locked · Unlock'); await called(p, 'reset_failed_attempts'); await p.waitForSelector('text=Session time');
  log((await calls(p, c => c.n === 'reset_failed_attempts'))[0]?.args.p_student_id === 'r1', 'Unlock calls reset_failed_attempts for the right student');
  await snap(p, '3c-session-detail');
  // Setup -> administrators
  await p.click('.tabs >> text=Setup'); await p.waitForSelector('text=Administrators (2)');
  t = await txt(p); log(t.includes('PRIMARY') && t.includes('second@x.test') && t.includes('Deactivate') && t.includes('Add administrator'), 'primary admin sees admin list, PRIMARY badge, Deactivate, Add form');
  log((await p.locator('text=Deactivate').count()) === 1, 'no Deactivate button on the primary admin itself');
  await p.fill('input[type=email]', 'new@x.test'); await p.click('button:text-is("Add administrator")'); await called(p, 'add_administrator'); await p.waitForSelector('text=Administrators (2)');
  log((await calls(p, c => c.n === 'add_administrator'))[0]?.args.p_email === 'new@x.test', 'Add administrator calls add_administrator RPC');
  await snap(p, '3d-setup-admins');
  t = await txt(p); log(t.includes('Faculty of Agriculture') && t.includes('Plant Science (Botany)') && t.includes('Cyber Security · New'), 'Setup lists departments grouped by faculty');
  // Students tab: paging + search
  await p.click('.tabs >> text=Students'); await p.waitForSelector('text=Students (60)');
  log((await p.locator('.item.who2').count()) === 25, 'students tab shows 25 per page of 60');
  await p.click('text=Next →'); await p.waitForSelector('text=Page 2 of 3'); log(true, 'pagination works (page 2 of 3)');
  await p.fill('input[placeholder^="Search"]', 'Load Student 07'); await p.waitForSelector('text=Students (1)');
  log(true, 'server-side search narrows to 1 student'); await snap(p, '3e-students');
  log(p.errors.length === 0, 'no JS errors in admin flow', p.errors.join(' | ')); await p.close();

  // ===== 4. ADMIN (not primary) =====
  p = await open(browser, { role: 'admin2' });
  await p.waitForSelector('text=Attendance sessions'); await p.click('.tabs >> text=Setup'); await p.waitForSelector('text=Administrators (2)');
  t = await txt(p);
  log(t.includes('Only the primary administrator can add or remove') && !t.includes('Add administrator') && !t.includes('Deactivate'), 'non-primary admin cannot see add/deactivate controls');
  await p.close();

  // ===== 5. REPORTS: paging past 1000 rows, preview cap, CSV safety, Sheets =====
  p = await open(browser, { role: 'admin', sheets: 'fail' });
  await p.waitForSelector('text=Attendance sessions'); await p.click('.tabs >> text=Reports'); await p.waitForSelector('text=Filters');
  await p.click('text=Preview report'); await p.waitForSelector('text=1506 rows');
  const sm = await calls(p, c => c.n === 'admin_attendance_summary');
  log(sm.length === 4 && sm.filter(c => c.args.p_course_id === 'c1').length === 2 && sm.filter(c => c.args.p_course_id === 'c1').map(c => c.range.join('-')).join() === '0-999,1000-1999', 'report pages past the 1000-row limit (course 1 fetched in 2 pages)', JSON.stringify(sm.map(c => [c.args.p_course_id, c.range])));
  log((await p.locator('table tr').count()) === 201, 'preview renders only 200 rows (+header) of 1506');
  t = await txt(p); log(t.includes('preview shows the first 200'), 'preview explains the 200-row cap');
  await snap(p, '5a-report-preview');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('text=Download CSV')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8').replace(/^\ufeff/, ''); const lines = csv.trim().split('\r\n');
  log(lines.length === 1507 && lines[0].startsWith('"Registration No","Name"'), 'CSV has header + all 1506 rows (not just the preview)', lines.length + ' lines');
  log(csv.includes(`"'=HYPERLINK(""http://evil"")"`), 'CSV neutralises spreadsheet formula injection');
  log(csv.includes('"Plain, Name ""q"""'), 'CSV quotes commas and quotes correctly');
  await p.click('text=Export to Google Sheets'); await p.waitForSelector('text=not configured on the server');
  log(true, 'Sheets failure shows the real server message (not a generic error)');
  await snap(p, '5b-sheets-error');
  await p.close();
  p = await open(browser, { role: 'admin', sheets: 'ok' });
  await p.waitForSelector('text=Attendance sessions'); await p.click('.tabs >> text=Reports'); await p.click('text=Preview report'); await p.waitForSelector('text=1506 rows');
  await p.fill('input[placeholder^="https://docs.google.com"]', 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0');
  await p.click('text=Export to Google Sheets'); await p.waitForSelector('text=Exported 1506 rows');
  const fn = (await calls(p, c => c.t === 'fn'))[0];
  log(fn.n === 'export-to-sheets' && fn.body.spreadsheet_id === '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'Sheets export sends only filters + parsed spreadsheet ID (no secrets)', JSON.stringify(fn.body));
  log((await p.locator('a:text-is("Open sheet")').getAttribute('href')).startsWith('https://docs.google.com/spreadsheets/'), 'success shows link to the sheet');
  await snap(p, '5c-sheets-ok'); await p.close();

  // ===== 6a. skeleton loading screens + static shell =====
  p = await open(browser, { role: 'student', delay: 700 });
  await p.waitForSelector('.skel-wrap', { state: 'attached' });
  t = await txt(p); log(await p.locator('.sk').count() > 0 && t.includes('FEDERAL UNIVERSITY'), 'skeleton placeholders + school name show while data loads');
  await snap(p, '6a-skeleton');
  await p.waitForSelector('text=My dashboard'); log(await p.locator('.skel-wrap').count() === 0, 'skeleton is replaced by the real screen');
  await p.click('text=Mark attendance'); log(await p.locator('.skel-wrap').count() === 1, 'skeleton also shows when switching tabs');
  await p.close();
  // ===== 6b. PWA / iOS / performance basics (static checks) =====
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, '../../manifest.webmanifest'), 'utf8'));
  const sizes = man.icons.map(i => i.sizes + ':' + i.purpose).join();
  log(man.display === 'standalone' && man.theme_color && man.start_url && sizes === '192x192:any,512x512:any,512x512:maskable' && man.id, 'manifest: standalone, theme colour, 192/512 + separate maskable icon', sizes);
  for (const f of man.icons.map(i => i.src).concat(['icons/apple-touch-icon.png'])) log(fs.existsSync(path.join(__dirname, '../..', f)), 'icon file exists: ' + f);
  for (const k of ['apple-mobile-web-app-capable', 'apple-mobile-web-app-status-bar-style', 'apple-mobile-web-app-title', 'mobile-web-app-capable']) log(HTML.includes('name="' + k + '"'), 'iOS/PWA meta tag: ' + k);
  log(HTML.includes('rel="apple-touch-icon"') && HTML.includes('viewport-fit=cover') && HTML.includes('rel="manifest"'), 'apple-touch-icon, viewport-fit=cover and manifest link present');
  log(/<script defer src="https:\/\/cdn\.jsdelivr\.net[^"]*supabase-js@2\.45\.4/.test(HTML) && HTML.includes('<script type="module">'), 'scripts are deferred and the library URL is version-pinned');
  log(HTML.includes('rel="preconnect" href="https://ovdprijwhvmkiahxjqrx.supabase.co"') && HTML.includes("media=\"print\" onload=\"this.media='all'\""), 'preconnect to Supabase and non-blocking font loading');
  const swSrc = fs.readFileSync(path.join(__dirname, '../../sw.js'), 'utf8');
  log(swSrc.includes('endsWith("supabase.co")') && swSrc.includes('networkFirst') && swSrc.includes('cacheFirst'), 'service worker: Network First pages, Cache First assets, Supabase never cached');
  log(!/PushManager|pushManager|SyncManager|registration\.sync/.test(HTML + swSrc), 'no Push / Background Sync (limited on iOS)');

  // ===== 6. signed out =====
  p = await open(browser, { role: 'none' });
  await p.waitForSelector('text=Sign in with Google'); t = await txt(p);
  log(t.includes('FEDERAL UNIVERSITY') && t.includes('WhatsApp 09152649961') && t.includes('Email'), 'sign-in page shows school name + support contacts');
  await p.click('button:has-text("Sign in with Google")'); await p.waitForTimeout(200); log((await calls(p, c => c.n === 'oauth'))[0]?.args.provider === 'google', 'Google sign-in button triggers OAuth with provider=google');
  await snap(p, '6-signin'); await p.close();

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
})();
