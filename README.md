# Campus Attendance PWA

Admin-verified attendance. The administrator creates a session (course + students + duration),
gets a six-digit code that only they see, and types it on each student's device. The code is
checked in Postgres; students never receive it.

## Structure
```
index.html                         App: sign-in, registration (photo + terms), dashboard, code entry screen,
                                   admin sessions/reports/students/setup
manifest.webmanifest, sw.js, icons/   PWA files (service worker never caches Supabase calls)
supabase/migrations/               Schema, RLS, functions, views (apply in filename order)
supabase/functions/export-to-sheets/  Edge Function: report -> Google Sheets
package.json                       Project + dependency info
```
Dependency: `@supabase/supabase-js@2.45.4` from jsDelivr (no npm install). Edge Function uses Deno.

## How it works
| Step | Where it is enforced |
|---|---|
| Admin-only actions (create/close/reopen/rotate/unlock/report) | `is_admin()` check inside each security-definer function + RLS |
| Code verification, expiry, duplicates, roster check | `mark_attendance()` (bcrypt hash; plain code never stored) |
| Failed attempts | 5 wrong codes lock that student for that session; admin taps **Unlock** |
| Students see | only `student_attendance_summary` (percentages) and `my_open_sessions()` — no code, no status/time |
| Sheets export | Edge Function forwards the admin's JWT, so Postgres re-checks `is_admin()`; Google credentials live in server secrets only |

Percentages count only **closed or expired** sessions. Expired = past its duration; no need to close manually.

## New in v1.2
- **Photo + name on the code screen.** Students take a photo at registration (private `student-photos` bucket). The
  verification screen shows their photo, name and matric number so the administrator can confirm who is present.
  Admins also see photos in session rosters and the Students tab.
- **Terms and Conditions** shown and accepted at registration (acceptance time + version stored; the database refuses
  a registration without it). The text in `index.html` (`TERMS`) is a **draft** - have your institution review it.
- **Admin controls:** change the time left (also reopens a session), set your own six-digit code or generate a new one,
  close/unlock, and edit student name/matric/department/level (Students tab). Registered courses stay locked.
- **Encrypted codes.** Verification uses a bcrypt hash. A second copy is AES-encrypted (pgcrypto) with a key held in
  Supabase Vault so admins can view/continue a session on any device; only `reveal_session_code()` (admin-only) decrypts it.
  Traffic is HTTPS. The plain code is never stored.
- **UI** follows your OTP mock: gradient background, white card, dark-blue digit boxes, on-screen keypad. Same colours for admin.
- **Support contact** (email + WhatsApp) appears at the bottom of every screen.

## v1.3: school name, admins, 10,000 users
- **School name** (FEDERAL UNIVERSITY OF DEVELOPMENT AND AGRICULTURE STUDIES IRABIGI) in bold green at the top of every screen.
- **Admins:** the first administrator is the **primary** admin and is permanent: a database trigger blocks deleting,
  deactivating, demoting or changing it, and there can only ever be one. Only the primary admin can add other admins
  (Setup > Administrators; the person must sign in with Google once first) and deactivate/reactivate them.
  Any active admin can run sessions, reports and edit students.
- **Scale (10,000 students):** load-tested in Postgres with 10,000 students and 240,000 attendance records - a
  10,000-row course report ran in about 0.6 s, a 30,000-row department report in about 0.75 s, searches in
  under 0.05 s. The app pages past Supabase's 1,000-rows-per-request limit, searches students server-side
  (25 per page), builds big reports one course at a time, previews only 200 rows (CSV/Sheets get everything), and
  shows photos in rosters only for classes of 200 or fewer.
- **Plan limits:** 10,000 photos (about 25-50 KB each after compression) plus hundreds of thousands of attendance
  rows will likely exceed free-plan storage/database limits. Check your current Supabase plan and expect to need Pro.
- Redeploy the export function after pulling this version (`supabase functions deploy export-to-sheets --no-verify-jwt`).

### Screen recording: what is and isn't possible
A website/PWA **cannot block** screen recording or screenshots - only a native app can (Android `FLAG_SECURE`, iOS
equivalents). What this app does instead: the code is hidden unless you hold a button, the screen blanks when the app
loses focus or goes to the background, text selection and long-press menus are disabled, and every code change/view is
audit-logged. If you need real blocking, wrap the PWA in a native shell (e.g. Capacitor) with secure-screen enabled.

## Setup
1. **Database**: already applied to project `ovdprijwhvmkiahxjqrx`. For a new project run all migration files in
   `supabase/migrations/` in order in the SQL editor.
2. **Auth**: Authentication > Providers > Google (client ID/secret). Authentication > URL Configuration:
   add your hosted URL as Site URL + Redirect URL.
3. **First admin** (after signing in once with Google):
   ```sql
   insert into administrators (id, email) select id, email from auth.users where email = 'you@example.com';
   ```
4. **Host** this folder over HTTPS (Netlify Drop / Vercel / GitHub Pages) or `npx serve .`
5. **Setup tab**: add departments and courses. Students then register; you can create sessions.

## Google Sheets export (manual configuration required)
CSV download works with no setup. For Sheets:
1. Google Cloud Console: create a project, enable **Google Sheets API**.
2. IAM > Service Accounts: create one, then Keys > Add key > JSON.
3. Create a Google Sheet and **share it (Editor) with the service account's email**.
4. Supabase > Edge Functions > Secrets: add `GOOGLE_SERVICE_ACCOUNT_JSON` (paste the whole JSON). Optionally
   `GOOGLE_SHEET_ID` as the default sheet.
5. Deploy if on a new project: `supabase functions deploy export-to-sheets --no-verify-jwt`
   (the function verifies the user itself and the database enforces admin rights).
6. Reports tab > Preview > paste the sheet link > Export. Each export adds a new tab.

Never put the service_role key or the Google JSON in `index.html`.

## Daily use
1. Sessions > pick department, course, length, students > **Create**. Keep the screen with the code.
2. Student opens **Mark attendance** on their phone and hands it over.
3. Admin enters the code (masked) and taps Verify. Student's percentage updates.
4. Lost the code? Open the session > **Generate a new code** (old one stops working).
5. Student locked out after 5 wrong tries? Open the session > **Unlock**.

## Automated UI tests
`tests/ui/` runs the real `index.html` in headless Chromium against an in-memory fake of the Supabase client
(no network). 53 checks cover student registration (photo resize/upload, terms), the OTP-style code screen
(masking, wrong/right code, attempts), admin sessions (hold-to-show code, custom code, time, close, unlock),
primary vs non-primary admin controls, students paging/search, report paging past 1,000 rows, CSV safety and the
Sheets call. Run: `npm i -D playwright && npx playwright install chromium && node tests/ui/tests.js`.
These prove the app's logic, not your live project: a real phone camera, real Google sign-in and a real
Google Sheet still need one manual run.

## Tested (SQL-level, against the live project, rolled back afterwards)
Non-admin create blocked; wrong code counts down attempts; correct code records; duplicate rejected;
unselected student rejected; lockout after 5 and admin unlock; bad format rejected; expired and
closed sessions rejected and hidden; student cannot read sessions/records/admin report or edit
registrations; student and admin percentages correct; reopen + code rotation.
Also tested: encrypted code differs from plain text, admin-only reveal/set/extend, students blocked from all of them,
registration without terms/photo refused.
Not tested here: the browser UI, camera capture, photo upload/signed URLs, Google sign-in, and the live Google Sheets call (needs your credentials).

## Known limits
- Admins can view the code from any device (server-decrypted). Keep admin accounts to trusted people.
- A student could call `mark_attendance` directly, but only 5 guesses per session are allowed.
- Very large classes (over 200) show initials instead of photos on the admin roster.
