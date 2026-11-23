// In-memory fake of the supabase-js client, so the real index.html code runs in a real browser without network.
(function () {
  const cfg = window.__cfg, calls = (window.__calls = []);
  const PHOTO = cfg.photo;
  const F1 = { name: 'Faculty of Agriculture & Renewable Natural Resources', sort_order: 1 }, F2 = { name: 'Faculty of Natural and Applied Sciences', sort_order: 2 };
  const depts = [{ id: 'd1', name: 'Agronomy', description: null, is_new: false, faculty_id: 'f1', faculties: F1 }, { id: 'd2', name: 'Plant Science', description: 'Botany', is_new: false, faculty_id: 'f2', faculties: F2 }, { id: 'd3', name: 'Cyber Security', description: null, is_new: true, faculty_id: 'f2', faculties: F2 }];
  const courses = [{ id: 'c1', code: 'AGR 101', title: 'Intro to Agronomy', department_id: 'd1' }, { id: 'c2', code: 'AGR 102', title: 'Soil Science', department_id: 'd1' }, { id: 'c3', code: 'NUR 201', title: 'Anatomy', department_id: 'd2' }];
  const admins = [{ id: 'u1', email: 'deodev266@gmail.com', full_name: null, role: 'super_admin', is_primary: true, is_active: true, created_at: '2026-11-18' }, { id: 'a2', email: 'second@x.test', full_name: 'Second Admin', role: 'admin', is_primary: false, is_active: true, created_at: '2026-11-19' }, { id: 'a3', email: 'off@x.test', full_name: 'Off Admin', role: 'admin', is_primary: false, is_active: false, created_at: '2026-11-20' }];
  let curRole = cfg.role;  // changes when a (mock) sign-in succeeds
  const me = { id: 'u1', student_id: 'st1', auth_user_id: 'u1', matric_no: 'U2024/001', full_name: 'Tamu Student', department_id: 'd1', level: '200', registration_completed: true, photo_path: 'u1/avatar.jpg', terms_accepted_at: '2026-11-18T10:00:00Z', terms_version: '1.0' };
  const bigStudents = Array.from({ length: 60 }, (_, i) => ({ id: 's' + i, full_name: 'Load Student ' + String(i + 1).padStart(2, '0'), matric_no: 'M' + String(i + 1).padStart(4, '0'), department_id: 'd1', level: '100', photo_path: 'x/' + i + '.jpg', registration_completed: true }));
  const roster = [0, 1, 2].map(i => ({ student_id: 'r' + i, students: { id: 'r' + i, full_name: ['Ada Obi', 'Bala Musa', 'Chinedu Eze'][i], matric_no: 'U2024/10' + i, department_id: 'd1', photo_path: 'r/' + i + '.jpg' } }));
  const overview = [
    { id: 's1', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 60000).toISOString(), closed_at: null, status: 'open', effective_status: 'open', course_id: 'c1', department_id: 'd1', course_code: 'AGR 101', course_title: 'Intro to Agronomy', department: 'Agronomy', total_students: 3, present_count: 1 },
    { id: 's0', created_at: '2026-11-10T09:00:00Z', expires_at: '2026-11-10T09:30:00Z', closed_at: '2026-11-10T09:25:00Z', status: 'closed', effective_status: 'closed', course_id: 'c1', department_id: 'd1', course_code: 'AGR 101', course_title: 'Intro to Agronomy', department: 'Agronomy', total_students: 3, present_count: 3 }];
  const records = [{ id: 'a', student_id: 'r0', status: 'present', marked_at: new Date().toISOString(), failed_attempts: 0, students: roster[0].students }, { id: 'b', student_id: 'r1', status: 'absent', marked_at: null, failed_attempts: 5, students: roster[1].students }, { id: 'c', student_id: 'r2', status: 'absent', marked_at: null, failed_attempts: 2, students: roster[2].students }];
  let wrong = 0;
  const summaryRows = cid => cid === 'c1' ? Array.from({ length: 1500 }, (_, i) => ({ matric_no: 'M' + i, full_name: 'Student ' + i, department: 'Agronomy', course_code: 'AGR 101', course_title: 'Intro to Agronomy', sessions_held: 10, sessions_attended: 8, attendance_percentage: 80 }))
    : [{ matric_no: 'X1', full_name: '=HYPERLINK("http://evil")', department: 'Agronomy', course_code: 'c', course_title: 't', sessions_held: 2, sessions_attended: 1, attendance_percentage: 50 }, { matric_no: 'X2', full_name: 'Plain, Name "q"', department: 'Agronomy', course_code: 'c', course_title: 't', sessions_held: 2, sessions_attended: 2, attendance_percentage: 100 }, { matric_no: 'X3', full_name: 'Zed', department: 'Agronomy', course_code: 'c', course_title: 't', sessions_held: 0, sessions_attended: 0, attendance_percentage: 0 }];
  const ok = d => ({ data: d, error: null });

  function handle(q) {
    const eq = k => (q.filters.find(f => f[0] === k) || [])[1];
    calls.push({ t: q.kind, n: q.name, op: q.op, f: q.filters, range: q.range, args: q.args, payload: q.payload });
    if (q.kind === 'rpc') {
      const a = q.args || {};
      switch (q.name) {
        case 'my_open_sessions': return ok(cfg.noSession ? [] : [{ session_id: 's1', course_code: 'AGR 101', course_title: 'Intro to Agronomy' }]);
        case 'mark_attendance': if (a.p_code === '246810') return ok('ok'); wrong++; return ok('invalid_code:' + Math.max(0, 5 - wrong));
        case 'reveal_session_code': return ok('246810');
        case 'create_attendance_session': return ok([{ session_id: 's1', code: '246810' }]);
        case 'admin_attendance_summary': { const all = summaryRows(a.p_course_id); const [f, t] = q.range || [0, all.length - 1]; return ok(all.slice(f, t + 1)); }
        default: return ok(null);
      }
    }
    const t = q.table;
    if (q.op === 'insert') return ok(q.single ? { ...q.payload, id: 'newst' } : null);
    if (q.op === 'update') return ok(null);
    if (t === 'administrators') { if (q.maybe) { const a = admins.find(x => x.id === eq('id')); return ok(curRole === 'student' || curRole === 'newstudent' ? null : a || null); } return ok(admins); }
    if (t === 'students') {
      if (curRole === 'student') return ok(me);
      if (q.maybe) return ok(curRole === 'newstudent' ? null : me);
      let rows = bigStudents; const or = q.or; if (or) { const m = or.match(/ilike\.%(.*?)%/); if (m) rows = rows.filter(r => r.full_name.toLowerCase().includes(m[1].toLowerCase()) || r.matric_no.toLowerCase().includes(m[1].toLowerCase())); }
      const [f, tt] = q.range || [0, rows.length]; return { data: rows.slice(f, tt + 1), count: rows.length, error: null };
    }
    if (t === 'departments') return ok(depts);
    if (t === 'faculties') return ok([{ id: 'f1', name: F1.name }, { id: 'f2', name: F2.name }]);
    if (t === 'courses') { const d = eq('department_id'); return ok(d ? courses.filter(c => c.department_id === d) : courses); }
    if (t === 'registrations') return ok(roster);
    if (t === 'student_attendance_summary') return ok([{ student_id: 'st1', course_id: 'c1', course_code: 'AGR 101', course_title: 'Intro to Agronomy', sessions_held: 10, sessions_attended: 8, attendance_percentage: 80 }]);
    if (t === 'admin_session_overview') return q.single ? ok(overview.find(s => s.id === eq('id')) || overview[0]) : ok(overview);
    if (t === 'attendance_records') return ok(records);
    return ok([]);
  }
  function Q(kind, name, args) { this.kind = kind; this.name = name; this.table = name; this.args = args; this.filters = []; this.op = 'select'; }
  Q.prototype = {
    select() { return this; }, order() { return this; }, limit() { return this; }, or(s) { this.or = s; return this; },
    eq(k, v) { this.filters.push([k, v]); return this; }, range(a, b) { this.range = [a, b]; return this; },
    single() { this.single = true; return this; }, maybeSingle() { this.maybe = true; return this; },
    insert(p) { this.op = 'insert'; this.payload = p; return this; }, update(p) { this.op = 'update'; this.payload = p; return this; },
    then(res, rej) { return Promise.resolve().then(() => handle(this)).then(res, rej); }
  };
  // properties that shadow prototype methods after being called
  const mk = (kind, name, args) => { const q = new Q(kind, name, args); const m = Q.prototype; ['or', 'range', 'single', 'maybeSingle'].forEach(k => { const f = m[k]; q[k] = function (...a) { f.apply(q, a); const keep = { or: 'or', range: 'range', single: 'single', maybeSingle: 'maybe' }[k]; return q; }; }); return q; };
  // simpler: wrap so state fields and methods don't collide
  function B(kind, name, args) {
    const st = { kind, name, table: name, args, filters: [], op: 'select' }, b = {};
    const chain = (k, fn) => { b[k] = (...a) => { fn(...a); return b; }; };
    ['select', 'order', 'limit'].forEach(k => chain(k, () => {}));
    chain('or', s => st.or = s); chain('eq', (k, v) => st.filters.push([k, v])); chain('range', (x, y) => st.range = [x, y]);
    chain('single', () => st.single = true); chain('maybeSingle', () => st.maybe = true);
    chain('insert', p => { st.op = 'insert'; st.payload = p; }); chain('update', p => { st.op = 'update'; st.payload = p; });
    b.then = (res, rej) => new Promise(r => setTimeout(r, cfg.delay || 0)).then(() => handle(st)).then(res, rej);
    return b;
  }
  const ids = { admin: ['u1', 'deodev266@gmail.com'], admin2: ['a2', 'second@x.test'], inactive: ['a3', 'off@x.test'], student: ['u1', 'stu@x.test'], newstudent: ['u1', 'new@x.test'] };
  const mkSession = r => r === 'none' ? null : { user: { id: ids[r][0], email: ids[r][1], user_metadata: { full_name: 'Tamu Student' } } };
  let session = mkSession(curRole);
  const client = {
    auth: { getSession: async () => ({ data: { session } }), onAuthStateChange: cb => { window.__authCb = cb; },
      signInWithPassword: async c => { calls.push({ t: 'auth', n: 'password', args: c }); if (cfg.loginFail) return { data: null, error: { message: 'Invalid login credentials' } }; curRole = cfg.loginAs; session = mkSession(curRole); return { data: { session }, error: null }; },
      signUp: async c => { calls.push({ t: 'auth', n: 'signUp', args: c }); if (cfg.signUpSession) { curRole = 'newstudent'; session = mkSession(curRole); } return { data: { session: cfg.signUpSession ? session : null, user: { identities: cfg.dupEmail ? [] : [{}] } }, error: null }; },
      resetPasswordForEmail: async (e, o) => { calls.push({ t: 'auth', n: 'reset', args: { e, o } }); return { error: null }; },
      updateUser: async a => { calls.push({ t: 'auth', n: 'updateUser', args: a }); return { error: cfg.updateFail ? { message: 'Auth session missing!' } : null }; }, signOut: async () => { calls.push({ t: 'auth', n: 'signOut' }); }, signInWithOAuth: async a => { calls.push({ t: 'auth', n: 'oauth', args: a }); return { error: null }; } },
    from: t => B('table', t), rpc: (n, a) => B('rpc', n, a),
    storage: { from: () => ({
      upload: async (path, blob, o) => { const bm = await createImageBitmap(blob); calls.push({ t: 'storage', n: 'upload', path, size: blob.size, type: blob.type, w: bm.width, h: bm.height, o }); return { error: null }; },
      createSignedUrls: async paths => { calls.push({ t: 'storage', n: 'sign', count: paths.length }); return { data: paths.map(p => ({ path: p, signedUrl: PHOTO })) }; } }) },
    functions: { invoke: async (n, o) => { calls.push({ t: 'fn', n, body: o.body });
      if (n === 'admin-users') return cfg.createFail ? { data: null, error: { message: 'non-2xx', context: { json: async () => ({ error: 'An account with that email already exists.' }) } } } : { data: { ok: true, id: 'new' }, error: null };
      if (cfg.sheets === 'ok') return { data: { ok: true, rows: 1506, url: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=1' }, error: null };
      return { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => ({ error: 'Google Sheets is not configured on the server yet (see README)' }) } } }; } }
  };
  window.supabase = { createClient: () => client };
})();
