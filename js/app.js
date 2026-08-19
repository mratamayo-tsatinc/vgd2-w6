/* ============================================================
   IMAGE QUIZ GRADER — js/app.js
   App — Client-Side SPA Logic   (Phase 5 — grouped/incremental UI)

   PORTED (Supabase migration, PROJECT_BRIEF §7/§8/§11): this file is the
   same App IIFE as before, with exactly two areas changed —
     1. call() — no longer wraps google.script.run; it now calls the
        Supabase Edge Function at window.SUPABASE_FUNCTIONS_URL (see
        js/supabaseClient.js), forwarding the signed-in user's access
        token as a bearer token. An internal ACTION_MAP translates every
        existing call('oldFunctionName', ...args) call site — none of
        which were touched — into the { action, payload } shape the
        Edge Function's router expects (PROJECT_BRIEF §7 table).
     2. init() — no longer reads a server-injected window.APP_CONTEXT
        synchronously. It now checks for a Supabase Auth session, and if
        one exists, calls the `context` action (get-current-user-context)
        to resolve isTeacher/allowed/studentNumber/studentName — exactly
        the identity Code.gs used to inject server-side. See
        bootstrapAuth()/applyRoleUI() below.
   Every other function in this file — scoring UI, rendering, drag/drop,
   the whole rest of the ~2,500 lines — is unchanged.
   ============================================================ */

const App = (() => {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  let sectionsData      = [];  // NEW — Phase 2C: full Sections rows (teacher), array-driven editor
  let currentSectionId  = '';  // NEW — Phase 2C: which section's answer key is shown below the list
  let answerKeyData    = [];   // grouped answer key rows for currentSectionId (teacher)
  let akPendingRecords = [];   // NEW — Phase 3 (pHash feature): ImageProcessor records staged for
                                // the "Upload Model Answers" flow, scoped to currentSectionId
  let resultsData      = [];   // grouped per-student results (teacher)
  let pendingRecords    = [];  // ImageProcessor records staged for the self-service Submit
  let sectionsPublicData   = []; // NEW — Phase 6: public (folder-ID-free) Sections list for the Upload page
  let selectedSectionId    = ''; // NEW — Phase 6: which section the Upload page is currently scoped to
  let lastActivityProgress = null; // NEW — Phase 6: last {activityScore, activityMax, percentage, sections}
                                    // seen from either submitFileBatch() or getMySubmissionStatusGrouped(),
                                    // so switching sections client-side never needs a new server round trip
  let currentChecklistItems = {}; // NEW — mockup-mirroring UI: items[] per sectionId, for whichever
                                   // section cards are currently rendered in #studentSectionResults,
                                   // so a row's eye-button click can look its record back up.
  let confirmCb        = null;
  let confirmModal     = null;
  let isTeacher         = false;
  let currentUserEmail  = '';
  let currentStudentNumber = ''; // auto-retrieved from the Students sheet by email, for non-teachers
  let currentStudentName   = '';

  // Batch Grade (teacher): one entry per student block
  const batchBlocks = {};     // id -> { studentNumber, records: [] }
  let batchBlockSeq = 0;

  const PAGE_TITLES = {
    dashboard: 'Dashboard',
    answerkey: 'Answer Key',
    upload:    'Upload Submission',
    results:   'Results',
    settings:  'Settings'
  };

  // ── Initialization ─────────────────────────────────────────
  async function init() {
    document.getElementById('sidebarToggle')
      .addEventListener('click', toggleSidebar);

    document.querySelectorAll('.sidebar-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        showPage(link.dataset.page);
      });
    });

    // Drag-and-drop for the main (self-service) multi-file dropzone
    const dropZone = document.getElementById('dropZone');
    if (dropZone) {
      dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
      dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files);
      });
    }

    // Drag-and-drop for the Answer Key page's "Upload Model Answers" dropzone
    // (pHash-feature Phase 3) — only present in the teacher UI.
    const akDropZone = document.getElementById('akDropZone');
    if (akDropZone) {
      akDropZone.addEventListener('dragover', e => { e.preventDefault(); akDropZone.classList.add('dragover'); });
      akDropZone.addEventListener('dragleave', () => akDropZone.classList.remove('dragover'));
      akDropZone.addEventListener('drop', e => {
        e.preventDefault();
        akDropZone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length) handleAkFileSelect(e.dataTransfer.files);
      });
    }

    confirmModal = new bootstrap.Modal(document.getElementById('confirmModal'));
    document.getElementById('confirmActionBtn').addEventListener('click', () => {
      confirmModal.hide();
      if (typeof confirmCb === 'function') confirmCb();
    });

    const btnSignIn = document.getElementById('btnSignIn');
    if (btnSignIn) btnSignIn.addEventListener('click', signIn);
    const btnSignOut = document.getElementById('btnSignOut');
    if (btnSignOut) btnSignOut.addEventListener('click', signOut);
    const btnSignOutDenied = document.getElementById('btnSignOutDenied');
    if (btnSignOutDenied) btnSignOutDenied.addEventListener('click', signOut);

    // PORTED — see the file header note above. doGet() used to decide
    // isTeacher/accessDenied server-side, before a single byte of HTML/JS
    // reached an unregistered visitor. A static bundle can't do that (every
    // visitor's browser receives this whole file — see PROJECT_BRIEF §3) —
    // so identity resolution now happens here, after the page has already
    // loaded, against the get-current-user-context Edge Function. Nothing
    // below this point in init() runs until that's resolved.
    await bootstrapAuth();
  }

  /**
   * PORTED — replaces the old synchronous `window.APP_CONTEXT` read.
   * Shows the loading screen, checks for a Supabase Auth session, and
   * (if signed in) calls the `context` action to resolve isTeacher /
   * allowed / studentNumber / studentName — the same identity Code.gs
   * used to inject server-side into Index.html. Never assume "the UI
   * didn't show the page" is a security control (PROJECT_BRIEF §3): the
   * screen this function shows for a disallowed visitor is UX only, and
   * makes no further calls that could expose data.
   */
  async function bootstrapAuth() {
    showAuthScreen('loading');

    if (!window.sbClient) {
      console.error('Supabase client not initialized — check js/supabaseClient.js.');
      showAuthScreen('signin');
      return;
    }

    const { data: { session } } = await window.sbClient.auth.getSession();
    if (!session) {
      showAuthScreen('signin');
      return;
    }

    let ctx;
    try {
      ctx = await call('getCurrentUserContext');
    } catch (e) {
      toast('Could not verify your account: ' + (e && e.message ? e.message : String(e)), 'danger');
      showAuthScreen('signin');
      return;
    }

    if (!ctx || !ctx.success) {
      toast((ctx && ctx.error) || 'Could not verify your account.', 'danger');
      showAuthScreen('signin');
      return;
    }

    currentUserEmail = ctx.email || '';

    if (!ctx.allowed) {
      const emailEl = document.getElementById('accessDeniedEmail');
      if (emailEl) emailEl.textContent = currentUserEmail || '(no email detected)';
      showAuthScreen('denied');
      return; // Deliberately no further calls — see the function doc above.
    }

    isTeacher            = !!ctx.isTeacher;
    currentStudentNumber = ctx.studentNumber || '';
    currentStudentName   = ctx.studentName   || '';

    applyRoleUI();
    showAuthScreen('app');

    if (isTeacher) {
      try {
        addBatchStudentBlock();
      } catch (e) {
        console.error('addBatchStudentBlock failed — batchStudentBlocks container missing?', e);
      }
    }
    await loadUploadSections();

    showPage(isTeacher ? 'dashboard' : 'upload');

    // Students land with their progress already loaded — no need to click
    // "Check My Progress" first just to see where they stand.
    if (!isTeacher && currentStudentNumber) {
      checkMyResult(true);
    }

    // If student, populate the mockup stat cards asynchronously
    try {
      if (!isTeacher) populateStudentStats();
    } catch (e) { /* ignore */ }
  }

  /**
   * Swaps between the four top-level screens added for the Supabase port
   * (loading / sign-in / access-denied / the real app). Only one is ever
   * visible at a time. This has no equivalent in the old app — Apps
   * Script rendered exactly one of these server-side per request.
   */
  function showAuthScreen(which) {
    const ids = { loading: 'loadingScreen', signin: 'signInScreen', denied: 'accessDeniedScreen', app: 'appRoot' };
    Object.keys(ids).forEach(key => {
      const el = document.getElementById(ids[key]);
      if (!el) return;
      const visible = key === which;
      el.style.display = visible ? (key === 'app' ? 'block' : 'flex') : 'none';
    });
  }

  /**
   * Applies the identity resolved by bootstrapAuth() to the DOM: shows/
   * hides every element carrying the `.teacher-only` / `.student-only`
   * classes (added in index.html in place of the old server-side
   * `<? if (isTeacher) { ?>` blocks — see PROJECT_BRIEF §8 step 3), and
   * fills in the small handful of user-identity strings the server used
   * to interpolate directly into the page (email, student name/number,
   * role badge). PURELY COSMETIC — see PROJECT_BRIEF §3: every one of
   * these toggles can be defeated in devtools, and that's fine, because
   * no Edge Function trusts this file's role check for anything.
   */
  function applyRoleUI() {
    document.querySelectorAll('.teacher-only').forEach(el => { el.style.display = isTeacher ? '' : 'none'; });
    document.querySelectorAll('.student-only').forEach(el => { el.style.display = isTeacher ? 'none' : ''; });

    const emailBadge = document.getElementById('userEmailBadge');
    const emailText  = document.getElementById('userEmailText');
    if (currentUserEmail && emailBadge && emailText) {
      emailText.textContent = currentUserEmail;
      emailBadge.style.display = '';
    }

    const topbarBadge     = document.getElementById('topbarBadge');
    const topbarBadgeText = document.getElementById('topbarBadgeText');
    if (topbarBadge && topbarBadgeText) {
      topbarBadge.classList.remove('bg-primary-soft', 'text-primary', 'bg-success-soft', 'text-success');
      topbarBadge.classList.add(isTeacher ? 'bg-primary-soft' : 'bg-success-soft', isTeacher ? 'text-primary' : 'text-success');
      topbarBadgeText.textContent = isTeacher ? 'Teacher' : 'Student';
    }

    if (!isTeacher) {
      const initials = currentStudentName ? currentStudentName.substring(0, 2).toUpperCase() : 'ST';
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('studentInitials', initials);
      set('studentNameText', currentStudentName);
      set('studentNumberText', currentStudentNumber);
      set('studentNameText2', currentStudentName);
      set('studentNumberText2', currentStudentNumber);
      const hidden = document.getElementById('studentNumberInput');
      if (hidden) hidden.value = currentStudentNumber;
    }
  }

  /** Starts the Google OAuth sign-in redirect. Bound to #btnSignIn. */
  async function signIn() {
    if (!window.sbClient) return;
    await window.sbClient.auth.signInWithOAuth({ provider: 'google' });
  }

  /** Signs out and returns to the sign-in screen. Bound to #btnSignOut
   *  (topbar) and #btnSignOutDenied (access-denied screen). */
  async function signOut() {
    if (window.sbClient) await window.sbClient.auth.signOut();
    location.reload();
  }

  async function populateStudentStats() {
    try {
      const r = await call('getMySubmissionStatusGrouped');
      if (!r || !r.success) return;
      const activity = { activityScore: r.activityScore || 0, activityMax: r.activityMax || 0, sections: r.sections || [] };
      // Derive simple counts: correct = total CORRECT rows, rejected = REJECTED, notSubmitted = itemCount - attempted
      let correct = 0, rejected = 0, attempted = 0, totalSlots = 0;
      activity.sections.forEach(s => {
        totalSlots += s.itemCount;
        if (s.items && s.items.length) {
          s.items.forEach(it => {
            attempted += it.result && it.result !== 'NOT_SUBMITTED' ? 1 : 0;
            if (it.result === 'CORRECT') correct += 1;
            if (it.result === 'REJECTED') rejected += 1;
          });
        }
      });
      const notSubmitted = Math.max(0, totalSlots - attempted);
      const pct = activity.activityMax > 0 ? Math.round((activity.activityScore / activity.activityMax) * 100) : 0;
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('stat-correct', correct);
      set('stat-rejected', rejected);
      set('stat-not-submitted', notSubmitted);
      set('stat-total-slots', totalSlots);
      const badge = document.getElementById('studentCompletionBadge'); if (badge) badge.textContent = pct + '%';
    } catch (e) {
      /* ignore */
    }
  }

  // ── Navigation ────────────────────────────────────────────
  function showPage(page) {
    const target = document.getElementById('page-' + page);
    if (!target) return;

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    target.classList.add('active');

    document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
    const link = document.querySelector('[data-page="' + page + '"]');
    if (link) link.classList.add('active');

    document.getElementById('pageTitle').textContent = PAGE_TITLES[page] || page;

    if (page === 'dashboard') loadDashboard();
    if (page === 'answerkey') loadAnswerKey();
    if (page === 'results')   loadResults();
    if (page === 'settings')  loadSettings();
    if (page === 'upload')    loadUploadSections();
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const main    = document.getElementById('mainContent');
    if (window.innerWidth <= 768) {
      sidebar.classList.toggle('mobile-open');
    } else {
      sidebar.classList.toggle('mini');
      main.classList.toggle('mini');
    }
  }

  // ── Server Call Wrapper (Promise) ───────────────────────────
  // PORTED — see the file header note. Every call site elsewhere in this
  // file (call('getSections'), call('saveSections', sectionsData), etc.)
  // is completely unchanged; ACTION_MAP is what translates each old
  // Code.gs function name into the { action, payload } shape the
  // Supabase Edge Function's router expects (PROJECT_BRIEF §7 table) —
  // this keeps the diff against the rest of App's ~2,500 lines to zero.
  //
  // payload(...) builders receive exactly the arguments the old call()
  // site passed to google.script.run; each returns whatever `payload`
  // the matching Edge Function action needs (see supabase/functions/api
  // on the backend — PROJECT_BRIEF §11.6). Actions with no payload
  // builder listed send `undefined`.
  const ACTION_MAP = {
    getCurrentUserContext:      { action: 'context' },
    getSections:                { action: 'sections' },
    saveSections:                { action: 'save_sections',       payload: (arr) => arr },
    getSectionsPublic:          { action: 'sections_public' },
    getAnswerKeyGrouped:        { action: 'answer_key',           payload: (sectionId) => ({ sectionId }) },
    saveAnswerKeyFromUpload:    { action: 'save_answer_key',      payload: (sectionId, records) => ({ sectionId, records }) },
    clearAnswerKey:              { action: 'clear_answer_key' },
    submitFileBatch:             { action: 'submit',               payload: (sectionId, studentNumber, records) => ({ sectionId, studentNumber, records }) },
    getMySubmissionStatusGrouped:{ action: 'my_status',            payload: (studentNumber) => ({ studentNumber }) },
    getDashboardStats:          { action: 'dashboard' },
    getResultsGrouped:          { action: 'results' },
    clearSubmissions:            { action: 'clear_submissions' },
    changeSectionType:           { action: 'change_section_type',  payload: (sectionId, newType) => ({ sectionId, newType }) },
    getSettings:                 { action: 'settings' },
    saveSettings:                 { action: 'save_settings',        payload: (obj) => obj },
    getImageTypeAliases:         { action: 'aliases' },
    saveImageTypeAliases:        { action: 'save_aliases',         payload: (arr) => arr },
    getUsers:                    { action: 'teachers' },
    saveUsers:                    { action: 'save_teachers',        payload: (arr) => arr }
  };

  function call(fn, ...args) {
    const mapping = ACTION_MAP[fn];
    if (!mapping) return Promise.reject(new Error('Unknown server action: ' + fn));
    const payload = mapping.payload ? mapping.payload(...args) : undefined;
    return callAction(mapping.action, payload);
  }

  /**
   * The actual HTTP call — POSTs { action, payload } to the single Edge
   * Function that holds all of this app's server logic (PROJECT_BRIEF
   * §11.6's router skeleton), with the current Supabase session's access
   * token as a bearer token so the function can independently re-verify
   * who's calling on every single invocation (never trust a cached
   * isTeacher/studentNumber from earlier in the session — mirrors
   * requireTeacher_()/getStudentByEmail_() re-checking every call today).
   */
  async function callAction(action, payload) {
    if (!window.sbClient) throw new Error('Supabase client not initialized.');
    const { data: { session } } = await window.sbClient.auth.getSession();
    const res = await fetch(window.SUPABASE_FUNCTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (session ? session.access_token : '')
      },
      body: JSON.stringify({ action, payload })
    });
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new Error('Server returned a non-JSON response (HTTP ' + res.status + ').');
    }
    if (!res.ok && !body) throw new Error('Request failed (HTTP ' + res.status + ').');
    return body;
  }

  // ── Toast Notifications ───────────────────────────────────
  function toast(message, type) {
    type = type || 'success';
    const icons = {
      success: 'bi-check-circle-fill',
      danger:  'bi-x-circle-fill',
      warning: 'bi-exclamation-triangle-fill',
      info:    'bi-info-circle-fill'
    };
    const colors = {
      success: '#059669',
      danger:  '#dc2626',
      warning: '#d97706',
      info:    '#0ea5e9'
    };
    const id  = 'toast-' + Date.now();
    const msg = String(message).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const html = '<div id="' + id + '" class="toast align-items-center text-white border-0 show" ' +
      'role="alert" style="background:' + colors[type] + ';min-width:260px;max-width:400px">' +
      '<div class="d-flex"><div class="toast-body d-flex align-items-start gap-2">' +
      '<i class="bi ' + icons[type] + ' flex-shrink-0 mt-1"></i>' +
      '<span>' + msg + '</span></div>' +
      '<button class="btn-close btn-close-white me-2 m-auto flex-shrink-0" ' +
      'onclick="document.getElementById(\'' + id + '\').remove()"></button></div></div>';
    document.getElementById('toastContainer').insertAdjacentHTML('beforeend', html);
    setTimeout(() => { const el = document.getElementById(id); if (el) el.remove(); }, 5000);
  }

  // ── Loading Overlay ───────────────────────────────────────
  function showLoading(show, msg) {
    const existing = document.getElementById('loadingOverlay');
    if (show) {
      if (existing) return;
      const el = document.createElement('div');
      el.id = 'loadingOverlay';
      el.className = 'loading-overlay';
      el.innerHTML = '<div class="spinner-container">' +
        '<div class="spinner-border text-primary" style="width:2rem;height:2rem"></div>' +
        '<span>' + (msg || 'Please wait…') + '</span></div>';
      document.body.appendChild(el);
    } else {
      if (existing) existing.remove();
    }
  }

  // ── Confirmation Modal ────────────────────────────────────
  function showConfirm(title, body, callback) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmBody').textContent  = body;
    confirmCb = callback;
    confirmModal.show();
  }

  // ── Score / Status Badges ─────────────────────────────────
  function scoreBadge(pct) {
    pct = parseFloat(pct) || 0;
    const cls = pct >= 90 ? 'score-excellent'
              : pct >= 75 ? 'score-good'
              : pct >= 50 ? 'score-average'
              : 'score-poor';
    return '<span class="score-badge ' + cls + '">' + pct.toFixed(1) + '%</span>';
  }

  function resultBadge(result) {
    if (result === 'CORRECT')  return '<span class="badge bg-success"><i class="bi bi-check-lg me-1"></i>CORRECT</span>';
    // NEW — Phase 6: PARTIAL — found in the section's answer key but not
    // every enabled attribute matched (or the section has nothing enabled
    // to score at all). Amber/warning treatment, distinct from both the
    // "all good" green and the "not found" red.
    if (result === 'PARTIAL')  return '<span class="badge bg-warning text-dark"><i class="bi bi-dash-circle-fill me-1"></i>PARTIAL</span>';
    if (result === 'REJECTED') return '<span class="badge bg-danger"><i class="bi bi-x-lg me-1"></i>REJECTED</span>';
    if (result === 'SKIPPED')  return '<span class="badge bg-secondary"><i class="bi bi-skip-forward-fill me-1"></i>ALREADY SUBMITTED</span>';
    if (result === 'NOT_SUBMITTED') return '<span class="badge bg-secondary-subtle text-secondary border">NOT SUBMITTED</span>';
    return '<span class="badge bg-secondary-subtle text-secondary border">NOT SUBMITTED</span>';
  }

  // ── HTML Escape ───────────────────────────────────────────
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function spinnerRow(cols) {
    return '<tr><td colspan="' + cols + '" class="text-center py-4">' +
      '<div class="spinner-border spinner-border-sm text-primary"></div></td></tr>';
  }

  function emptyRow(cols, msg) {
    return '<tr><td colspan="' + cols + '" class="text-center text-muted py-5">' +
      '<i class="bi bi-inbox d-block fs-2 mb-2"></i>' + esc(msg) + '</td></tr>';
  }

  // Treats a handful of common extension synonyms as equivalent for the
  // client-side "does the filename match what the bytes say" preview hint.
  // This is informational only — the server is always the source of truth.
  function extEquivalent(a, b) {
    const norm = x => {
      x = String(x || '').toUpperCase();
      if (x === 'JPG') return 'JPEG';
      if (x === 'TIF') return 'TIFF';
      return x;
    };
    return norm(a) === norm(b);
  }

  // ════════════════════════════════════════════════════════
  //  DASHBOARD  (teacher only)
  // ════════════════════════════════════════════════════════
  async function loadDashboard() {
    if (!isTeacher) return;
    ['stat-sections','stat-items','stat-students','stat-avg',
     'stat-high','stat-low','stat-avg2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
    document.getElementById('recentTable').innerHTML = spinnerRow(7);
    const sbTbody = document.getElementById('sectionBreakdownTable');
    if (sbTbody) sbTbody.innerHTML = spinnerRow(5);
    document.getElementById('ambiguousWarning').classList.add('d-none');

    try {
      const d = await call('getDashboardStats');
      if (!d.success) { toast(d.error, 'danger'); return; }

      document.getElementById('stat-sections').textContent = d.totalSections;
      document.getElementById('stat-items').textContent    = d.totalAnswerKeyItems;
      document.getElementById('stat-students').textContent = d.totalStudentsActive;
      document.getElementById('stat-avg').textContent      = d.avgActivityPct + '%';
      document.getElementById('stat-avg2').textContent     = d.avgActivityPct + '%';
      document.getElementById('stat-high').textContent     = d.highActivityPct + '%';
      document.getElementById('stat-low').textContent      = d.lowActivityPct  + '%';

      if (d.ambiguousBaseNames && d.ambiguousBaseNames.length) {
        document.getElementById('ambiguousWarning').classList.remove('d-none');
        document.getElementById('ambiguousWarningText').textContent =
          d.ambiguousBaseNames.length + ' file(s) are duplicated within one or more sections\' Answer Key ' +
          '(two entries share the exact same name AND type in the same section): ' + d.ambiguousBaseNames.join(', ') +
          '. Remove or rename the duplicate and re-upload that section\'s answer key.';
      }

      const tbody = document.getElementById('recentTable');
      if (!d.recentSubmittedFiles || !d.recentSubmittedFiles.length) {
        tbody.innerHTML = emptyRow(7, 'No files submitted yet.');
      } else {
        tbody.innerHTML = d.recentSubmittedFiles.map(s =>
          '<tr>' +
          '<td><code>' + esc(s.studentNumber) + '</code></td>' +
          '<td>' + esc(s.studentName) + '</td>' +
          '<td><span class="badge bg-light text-secondary border">' + esc(s.sectionName) + '</span></td>' +
          '<td>' + esc(s.baseName) + '</td>' +
          '<td><span class="badge bg-secondary">' + esc(s.detectedExt) + '</span></td>' +
          '<td>' + resultBadge(s.result) + '</td>' +
          '<td><small class="text-muted">' + esc(s.timestamp) + '</small></td>' +
          '</tr>'
        ).join('');
      }

      if (sbTbody) {
        if (!d.sectionBreakdown || !d.sectionBreakdown.length) {
          sbTbody.innerHTML = emptyRow(5, 'No sections configured yet.');
        } else {
          sbTbody.innerHTML = d.sectionBreakdown.map(s =>
            '<tr>' +
            '<td>' + esc(s.sectionName) + '</td>' +
            '<td>' + s.itemCount + '</td>' +
            '<td>' + s.sectionMax + '</td>' +
            '<td>' + s.studentsActive + '</td>' +
            '<td>' + scoreBadge(s.avgPct) + '</td>' +
            '</tr>'
          ).join('');
        }
      }
    } catch (e) {
      toast('Dashboard error: ' + e.message, 'danger');
      document.getElementById('recentTable').innerHTML = emptyRow(7, 'Failed to load data.');
      if (sbTbody) sbTbody.innerHTML = emptyRow(5, 'Failed to load data.');
    }
  }

  // ════════════════════════════════════════════════════════
  //  SECTIONS  (teacher only)
  //  Create/rename/delete sections and edit their Name, scored attributes,
  //  and point value. A section's answer key itself is built separately,
  //  via the "Upload Model Answers" card below (Drive-folder scanning was
  //  retired entirely — see the pHash PRD, Phase 4). Saving here always
  //  round-trips every other field already on each section object
  //  (sectionId, enabled, sortOrder) untouched, so it can never blank out
  //  settings configured elsewhere.
  // ════════════════════════════════════════════════════════

  async function loadSections() {
    if (!isTeacher) return;
    const tbody = document.getElementById('sectionsBody');
    tbody.innerHTML = spinnerRow(9);
    try {
      const result = await call('getSections');
      if (result && result.success === false)
        throw new Error(result.error || 'Server returned an error.');
      sectionsData = JSON.parse((result && result.dataJson) || '[]');

      // If the previously-selected section no longer exists (deleted by
      // someone else, or this is first load), fall back to no selection.
      if (currentSectionId && !sectionsData.some(s => s.sectionId === currentSectionId)) {
        currentSectionId = '';
      }

      renderSectionsTable(sectionsData);
      // NEW — Phase 3 (pHash feature): keep the Upload Model Answers card's
      // label/state in sync with whichever section ends up selected after
      // a reload (e.g. right after Save Sections assigns a new SectionId).
      updateAkSectionLabel();
      updateAkUploadButtonState();

      if (currentSectionId) {
        loadSectionAnswerKey(currentSectionId);
      } else {
        document.getElementById('akBody').innerHTML =
          emptyRow(9, 'Select a section above to view its answer key.');
        document.getElementById('akCount').textContent = '0';
      }
    } catch (e) {
      tbody.innerHTML = emptyRow(9, 'Failed to load sections.');
      toast('Error loading sections: ' + (e && e.message ? e.message : String(e)), 'danger');
    }
  }

  function renderSectionsTable(sections) {
    const tbody = document.getElementById('sectionsBody');
    if (!sections.length) {
      tbody.innerHTML = emptyRow(9, 'No sections yet. Click "Add Section" to create one.');
      return;
    }
    tbody.innerHTML = sections.map((s, i) => sectionRowHtml(s, i)).join('');
  }

  // The seven scorable attributes, in the fixed order used everywhere in
  // the UI (row checkboxes, max-points math). field = Sections sheet
  // column / sectionsData property name; label = short column-friendly
  // text; title = full name shown as a tooltip.
  //
  // pHash-feature Phase 5: 'checkPerceptualHash' ADDED, mirroring Code.gs'
  // SECTION_ATTR_FIELDS — it counts toward sectionEnabledAttrCount() /
  // sectionMaxPointsLabel() exactly like the other six, even though its
  // actual per-submission scoring (submitFileBatch(), server-side) is
  // fractional rather than binary and skips PDF submissions entirely.
  const SECTION_ATTRS = [
    { field: 'checkFilenameExact',  label: 'Name',   title: 'Exact filename match (case- and whitespace-sensitive)' },
    { field: 'checkExtension',      label: 'Ext',     title: 'Detected-byte extension match' },
    { field: 'checkWidth',          label: 'W',       title: 'Width match (within the global pixel tolerance)' },
    { field: 'checkHeight',         label: 'H',       title: 'Height match (within the global pixel tolerance)' },
    // Section-Types-plan Phase 2: 'checkSize' ADDED — the 8th toggleable
    // scored attribute, same binary within-tolerance shape as W/H. Flows
    // automatically through sectionEnabledAttrCount()/sectionMaxPointsLabel()
    // /the checkbox rendering below since all three already iterate this
    // array generically — no other change needed in this file for the
    // teacher-side attribute UI.
    { field: 'checkSize',           label: 'Size',    title: 'File size in KB match (within the global KB tolerance)' },
    { field: 'checkAspectRatio',    label: 'AR',      title: 'Aspect ratio match' },
    { field: 'checkOrientation',    label: 'Orient',  title: 'Orientation match (LANDSCAPE / PORTRAIT / NA)' },
    { field: 'checkPerceptualHash', label: 'pHash',   title: 'Perceptual (visual) similarity, scored fractionally within the configured Hamming Distance threshold — skipped for PDF submissions' }
  ];

  /** Count of enabled Check* attributes on a section object. */
  function sectionEnabledAttrCount(s) {
    return SECTION_ATTRS.reduce((n, a) => n + (s[a.field] ? 1 : 0), 0);
  }

  /**
   * True if PointValue is set to a real, non-zero number (fixed-points
   * mode). Per the Sections sheet schema ("PointValue: blank/0 = derived
   * mode"), a literal 0 is treated the same as blank — both mean "let the
   * derived formula decide the max," not "this section is worth zero
   * points." Only a genuinely positive/negative numeric entry counts as
   * an intentional fixed override.
   */
  function sectionHasFixedPoints(s) {
    const v = s.pointValue;
    if (v === null || v === undefined || v === '') return false;
    const num = Number(v);
    return !isNaN(num) && num !== 0;
  }

  /**
   * Client-side estimate of a section's max points, per Principle 5:
   * Fixed mode (PointValue set) → that value, labeled "(fixed)".
   * Derived mode (PointValue blank) → itemCount × enabled-attribute count,
   * labeled "(auto)" — matches the acceptance criteria wording exactly.
   * This is a UI convenience only; the server (Phase 5) is authoritative.
   */
  function sectionMaxPointsLabel(s) {
    if (sectionHasFixedPoints(s)) {
      return esc(Number(s.pointValue)) + ' <span class="text-muted">pts (fixed)</span>';
    }
    const derived = (s.itemCount || 0) * sectionEnabledAttrCount(s);
    return derived + ' <span class="text-muted">pts (auto)</span>';
  }

  function sectionAttrCheckboxHtml(idx, attr, checked) {
    const domId = 'sec-' + idx + '-' + attr.field;
    return '<div class="form-check form-check-inline m-0 me-2 mb-1" title="' + esc(attr.title) + '">' +
      '<input class="form-check-input" type="checkbox" id="' + domId + '" ' +
      (checked ? 'checked ' : '') +
      'onchange="App.updateSectionField(' + idx + ',\'' + attr.field + '\',this.checked)">' +
      '<label class="form-check-label small" for="' + domId + '">' + esc(attr.label) + '</label>' +
      '</div>';
  }

  /**
   * Software Provenance Gate — Phase 5. Renders the "Software Check"
   * column's control pair: an on/off switch plus a free-text program-name
   * input. Disabled entirely on MANIFEST sections — there's no real File
   * object for inspectMetadataProvenance() to scan (see Phase 4's
   * saveSections()/updateSectionField() guards, which this control is the
   * visible surface of).
   */
  function sectionSoftwareGateHtml(idx, s) {
    const checkId = 'sec-' + idx + '-swgate';
    const isManifest = (s.sectionType || 'IMAGE') === 'MANIFEST';
    return '<div class="d-flex flex-column gap-1" style="max-width:190px">' +
      '<div class="form-check form-switch m-0" title="' +
      (isManifest ? 'Not available on MANIFEST sections — no real file to inspect.'
                  : 'Gate only — required to pass, but adds no points.') + '">' +
        '<input class="form-check-input" type="checkbox" id="' + checkId + '" ' +
        (s.requireSoftwareCheck ? 'checked ' : '') + (isManifest ? 'disabled ' : '') +
        'onchange="App.updateSectionField(' + idx + ',\'requireSoftwareCheck\',this.checked)">' +
        '<label class="form-check-label small' + (isManifest ? ' text-muted' : '') + '" for="' + checkId + '">Require software check</label>' +
      '</div>' +
      '<input type="text" class="form-control form-control-sm" placeholder="e.g. Adobe Photoshop" ' +
        (isManifest ? 'disabled ' : '') +
        'value="' + esc(s.requiredSoftwareName || '') + '" ' +
        'oninput="App.updateSectionField(' + idx + ',\'requiredSoftwareName\',this.value)">' +
    '</div>';
  }

  function sectionRowHtml(s, idx) {
    const sid = s.sectionId || '';
    const saved = !!sid;
    const hasFixed = sectionHasFixedPoints(s);
    return '<tr' + (saved && currentSectionId === sid ? ' class="table-active"' : '') + '>' +
      '<td class="text-center align-middle">' +
        '<input type="radio" name="sectionPicker" class="form-check-input" ' +
        (saved && currentSectionId === sid ? 'checked ' : '') +
        (saved ? '' : 'disabled ') +
        'onchange="App.selectSection(\'' + esc(sid) + '\')" title="' +
        (saved ? 'Select this section (view/build its answer key below)' : 'Save first to select this section') + '">' +
      '</td>' +
      '<td><input type="text" class="form-control form-control-sm" ' +
        'value="' + esc(s.name) + '" placeholder="e.g. Part 1 — Thumbnails" ' +
        'oninput="App.updateSectionField(' + idx + ',\'name\',this.value)"></td>' +
      // Section Type selector (Phase 6)
      '<td class="align-middle"><select class="form-select form-select-sm" ' +
        'onchange="App.updateSectionField(' + idx + ',\'sectionType\', this.value)">' +
        '<option value="IMAGE"' + ( (s.sectionType || 'IMAGE') === 'IMAGE' ? ' selected' : '' ) + '>IMAGE</option>' +
        '<option value="MANIFEST"' + ( (s.sectionType || 'IMAGE') === 'MANIFEST' ? ' selected' : '' ) + '>MANIFEST</option>' +
      '</select></td>' +
      '<td class="align-middle"><div class="d-flex flex-wrap" style="max-width:280px">' +
        SECTION_ATTRS.map(a => sectionAttrCheckboxHtml(idx, a, !!s[a.field])).join('') +
      '</div></td>' +
      '<td class="align-middle">' + sectionSoftwareGateHtml(idx, s) + '</td>' +
      '<td class="align-middle">' +
        '<input type="number" class="form-control form-control-sm" style="width:88px" ' +
        'min="0" step="0.5" placeholder="auto" ' +
        'value="' + (hasFixed ? esc(s.pointValue) : '') + '" ' +
        'oninput="App.updateSectionPointValue(' + idx + ', this.value)"></td>' +
      '<td class="align-middle">' +
        '<span class="badge bg-light text-dark border" id="sectionMaxBadge-' + idx + '">' +
        sectionMaxPointsLabel(s) + '</span></td>' +
      '<td class="align-middle"><span class="badge bg-secondary-subtle text-secondary border">' +
        (s.itemCount || 0) + '</span></td>' +
      '<td class="text-end align-middle">' +
        '<button class="btn btn-sm btn-outline-danger" title="Remove section" ' +
        'onclick="App.removeSectionRow(' + idx + ')"><i class="bi bi-trash"></i></button>' +
      '</td>' +
      '</tr>';
  }

  /** Refreshes just the Max-points badge for one row in place — used after
   *  any attribute toggle or point-value edit so typing/clicking never
   *  triggers a full-table re-render (which would drop input focus). */
  function refreshSectionMaxBadge(idx) {
    const badge = document.getElementById('sectionMaxBadge-' + idx);
    if (badge && sectionsData[idx]) badge.innerHTML = sectionMaxPointsLabel(sectionsData[idx]);
  }

  /**
   * Generic field setter for text inputs (name) and the six Check*
   * booleans. Every other field on the section object (sectionId, enabled,
   * sortOrder) is left completely untouched, so saving always round-trips
   * whatever isn't yet exposed in this UI.
   */
  function updateSectionField(idx, field, value) {
    if (!sectionsData[idx]) return;
    // Special-case: changing an existing saved section's type requires
    // confirmation and server-side invalidation (clears Answer Key rows).
    if (field === 'sectionType') {
      const row = sectionsData[idx];
      const oldType = row.sectionType || 'IMAGE';
      const newType = String(value || '').toUpperCase() === 'MANIFEST' ? 'MANIFEST' : 'IMAGE';
      if (row.sectionId && oldType !== newType) {
        showConfirm('Change Section Type',
          'Changing this section\'s type will clear its current Answer Key. You will need to re-upload model answers before this section can be used again. Continue?', async () => {
            try {
              // Software Provenance Gate — Phase 4: switching an existing
              // section TO MANIFEST also clears the gate, so the saved
              // state can never drift out of sync with the (Phase 5)
              // checkbox being disabled — a MANIFEST section has no real
              // File object for the gate to inspect. Written now,
              // alongside the server-side validation (saveSections()),
              // so Phase 5 can ship the UI with the safety net already in
              // place rather than as an afterthought.
              if (newType === 'MANIFEST' && row.requireSoftwareCheck) {
                row.requireSoftwareCheck = false;
                row.requiredSoftwareName = '';
              }
              showLoading(true, 'Changing section type…');
              const res = await call('changeSectionType', row.sectionId, newType);
              showLoading(false);
              if (!res || res.success === false) { toast(res && res.error ? res.error : 'Failed to change section type', 'danger'); return; }
              if (res.warning) toast(res.warning, 'warning');
              // Refresh sections and answer key UI to reflect the change
              await loadSections();
              if (currentSectionId === row.sectionId) {
                currentSectionId = '';
                document.getElementById('akBody').innerHTML = emptyRow(9, 'Select a section above to view its answer key.');
                document.getElementById('akCount').textContent = '0';
              }
            } catch (e) {
              showLoading(false);
              toast('Error: ' + (e && e.message ? e.message : String(e)), 'danger');
            }
        });
        return;
      }
    }
    sectionsData[idx][field] = value;
    refreshSectionMaxBadge(idx);
  }

  /** PointValue needs numeric parsing (blank → null = derived/auto mode;
   *  anything else → Number(...) = fixed mode) rather than the raw string
   *  updateSectionField() would otherwise store. */
  function updateSectionPointValue(idx, rawValue) {
    if (!sectionsData[idx]) return;
    const trimmed = String(rawValue).trim();
    sectionsData[idx].pointValue = trimmed === '' ? null : Number(trimmed);
    refreshSectionMaxBadge(idx);
  }

  function addSectionRow() {
    sectionsData.push({
      sectionId: '', name: '', pointValue: null,
      sectionType: 'IMAGE',
      checkFilenameExact: false, checkExtension: false, checkWidth: false,
      checkHeight: false, checkAspectRatio: false, checkOrientation: false,
      checkPerceptualHash: false,
      // Section-Types-plan Phase 2: checkSize defaults to false, matching
      // every other Check* default here. (sectionType's own default is
      // added client-side in Phase 6 — the server already treats a row
      // with no sectionType as 'IMAGE', see saveSections() in Code.gs.)
      checkSize: false,
      // Software Provenance Gate — Phase 5: defaults to off/blank, same
      // convention as every other new-row default here — a brand-new
      // section never silently starts with the gate enabled.
      requireSoftwareCheck: false, requiredSoftwareName: '',
      enabled: true, sortOrder: sectionsData.length, itemCount: 0
    });
    renderSectionsTable(sectionsData);
    const rows = document.querySelectorAll('#sectionsBody input[type="text"]');
    if (rows.length) rows[rows.length - 1] && rows[rows.length - 1].focus();
  }

  function removeSectionRow(idx) {
    const removed = sectionsData[idx];
    if (!removed) return;
    sectionsData.splice(idx, 1);
    if (removed.sectionId && removed.sectionId === currentSectionId) {
      currentSectionId = '';
      document.getElementById('akBody').innerHTML =
        emptyRow(9, 'Select a section above to view its answer key.');
      document.getElementById('akCount').textContent = '0';
      updateAkSectionLabel();
      // NEW — Phase 3 (pHash feature): any files staged for the
      // now-removed section must not be saveable against a different one.
      akPendingRecords = [];
      renderAkUploadPreview();
      updateAkUploadButtonState();
    }
    renderSectionsTable(sectionsData);
    toast('Section removed from the list — click "Save Sections" to make this permanent.', 'info');
  }

  async function saveSections() {
    try {
      showLoading(true, 'Saving sections…');
      const r = await call('saveSections', sectionsData);
      showLoading(false);
      if (!r.success) {
        toast(r.error, 'danger');
        return;
      }
      if (r.warnings && r.warnings.length) {
        r.warnings.forEach(w => toast(w, 'warning'));
      }
      toast('Sections saved!', 'success');
      await loadSections(); // re-fetch so new sections get their server-assigned IDs
    } catch (e) {
      showLoading(false);
      toast('Save error: ' + (e && e.message ? e.message : String(e)), 'danger');
    }
  }

  function selectSection(sectionId) {
    currentSectionId = sectionId || '';
    renderSectionsTable(sectionsData); // re-render so the checked radio/highlight follows
    updateAkSectionLabel();
    // NEW — Phase 3 (pHash feature): switching sections clears any staged
    // (not-yet-saved) upload files — they were staged against the PREVIOUS
    // section's context and must never be silently saved against a new one.
    akPendingRecords = [];
    renderAkUploadPreview();
    updateAkUploadButtonState();
    if (currentSectionId) loadSectionAnswerKey(currentSectionId);
  }

  function updateAkSectionLabel() {
    const section = sectionsData.find(s => s.sectionId === currentSectionId);
    const text = section ? ('— ' + section.name) : '— no section selected';
    const el = document.getElementById('akSectionLabel');
    if (el) el.textContent = text;
    // NEW — Phase 3 (pHash feature): the Upload Model Answers card shows
    // the same "— Section Name" label so it's always clear which section
    // an upload will replace.
    const uploadEl = document.getElementById('akUploadSectionLabel');
    if (uploadEl) uploadEl.textContent = text;
    // Show/hide the teacher manifest example button based on sectionType
    const btn = document.getElementById('btnAkManifestExample');
    if (btn) {
      if (section && section.sectionType === 'MANIFEST') btn.classList.remove('d-none');
      else btn.classList.add('d-none');
    }
  }

  // ════════════════════════════════════════════════════════
  //  ANSWER KEY  (teacher only) — grouped view, scoped to ONE section
  // ════════════════════════════════════════════════════════
  async function loadAnswerKey() {
    if (!isTeacher) return;
    // Sections are the source of truth for which section is selected, and
    // their item counts can change from other teachers' actions, so always
    // reload the section list first; it will load the current section's
    // answer key itself once the list is in.
    await loadSections();
  }

  async function loadSectionAnswerKey(sectionId) {
    document.getElementById('akBody').innerHTML = spinnerRow(9);
    document.getElementById('akCount').textContent = '…';
    document.getElementById('akAmbiguousWarning').classList.add('d-none');
    try {
      const result = await call('getAnswerKeyGrouped', sectionId);
      if (result && result.success === false)
        throw new Error(result.error || 'Server returned an error.');
      // Only apply this response if the section picker hasn't moved on to
      // a different section while this call was in flight.
      if (sectionId !== currentSectionId) return;
      answerKeyData = JSON.parse((result && result.dataJson) || '[]');
      if (result.ambiguousBaseNames && result.ambiguousBaseNames.length) {
        document.getElementById('akAmbiguousWarning').classList.remove('d-none');
        document.getElementById('akAmbiguousWarningText').textContent =
          'Duplicate file(s) in this section — the exact same name AND type appears more than once, ' +
          'so grading can\'t tell the entries apart: ' +
          result.ambiguousBaseNames.join(', ') + '. Remove or rename the duplicate and re-upload this section\'s answer key.';
      }
      renderAnswerKey(answerKeyData);
    } catch (e) {
      document.getElementById('akBody').innerHTML = emptyRow(9, 'Failed to load answer key.');
      document.getElementById('akCount').textContent = '0';
      toast('Error loading answer key: ' + (e && e.message ? e.message : String(e)), 'danger');
    }
  }

  function renderAnswerKey(data) {
    data = Array.isArray(data) ? data : [];
    document.getElementById('akCount').textContent = data.length;
    const tbody = document.getElementById('akBody');
    if (!data.length) {
      tbody.innerHTML = emptyRow(9, currentSectionId
        ? 'No data in this section yet. Use "Upload Model Answers" above to build its answer key.'
        : 'Select a section above to view its answer key.');
      return;
    }
    tbody.innerHTML = data.map((r, i) =>
      '<tr>' +
      '<td class="text-muted">' + (i + 1) + '</td>' +
      '<td><i class="bi bi-file-earmark-image text-muted me-1"></i>' + esc(r.baseName) +
      (r.ambiguousBaseName ? ' <i class="bi bi-exclamation-triangle-fill text-warning" title="Duplicate entry — same name and extension appear more than once in this section"></i>' : '') +
      '</td>' +
      '<td class="text-muted small">' + esc(r.filename) + '</td>' +
      '<td><span class="badge bg-secondary">' + esc(r.extension) + '</span></td>' +
      '<td>' + esc(r.width) + ' × ' + esc(r.height) + ' <span class="text-muted">px</span></td>' +
      '<td>' + (r.sizeKb != null ? esc(r.sizeKb) + ' <span class="text-muted">KB</span>' : '<span class="text-muted small">—</span>') + '</td>' +
      '<td>' + esc(r.aspectRatio) + '</td>' +
      '<td>' + esc(r.orientation) + '</td>' +
      '<td>' + (r.perceptualHash
        ? '<code class="small">' + esc(r.perceptualHash) + '</code>'
        : '<span class="text-muted small">—</span>') + '</td>' +
      '</tr>'
    ).join('');
  }

  function filterAnswerKey(q) {
    const filtered = q
      ? answerKeyData.filter(r => r.baseName.toLowerCase().includes(q.toLowerCase()))
      : answerKeyData;
    renderAnswerKey(filtered);
  }

  function confirmClearAnswerKey() {
    showConfirm(
      'Clear Answer Key',
      'This removes ALL scanned entries across EVERY section (not just the one currently ' +
      'selected) — each section will need its answer key re-uploaded individually afterward. Continue?',
      async () => {
        try {
          showLoading(true, 'Clearing…');
          const r = await call('clearAnswerKey');
          showLoading(false);
          if (r.success) {
            answerKeyData = [];
            renderAnswerKey([]);
            toast('Answer key cleared for all sections.', 'info');
            loadSections();
          } else {
            toast(r.error, 'danger');
          }
        } catch (e) {
          showLoading(false);
          toast(e.message, 'danger');
        }
      }
    );
  }

  // Show manifest example modal. If `forceTeacher` is true, prefer teacher answerKeyData; otherwise try current section.
  function showManifestExample(forceTeacher) {
    // Prefer teacher's answerKeyData if available and the current section is MANIFEST
    let content = '';
    const section = sectionsData.find(s => s.sectionId === currentSectionId);
    const isManifestSection = section && section.sectionType === 'MANIFEST';
    if (isManifestSection && answerKeyData && answerKeyData.length) {
      content = answerKeyData.map(r => [
        r.baseName,
        r.extension,
        (r.sizeKb != null ? r.sizeKb : ''),
        (r.width  != null ? r.width  : ''),
        (r.height != null ? r.height : ''),
        (r.aspectRatio || ''),
        (r.orientation || '')
      ].join(', ')).join('\r\n');
    } else {
      // Generic example lines
      content = 'photo1, JPG, 12.34, 800, 600, 4:3, LANDSCAPE\r\nphoto2, PNG, 8.50, 600, 800, 3:4, PORTRAIT';
    }
    const ta = document.getElementById('manifestExampleText');
    if (ta) ta.value = content;
    const modalEl = document.getElementById('manifestExampleModal');
    if (modalEl) {
      const modal = new bootstrap.Modal(modalEl);
      modal.show();
    }
  }

  async function copyManifestExample() {
    const ta = document.getElementById('manifestExampleText');
    if (!ta) return;
    const txt = ta.value || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(txt);
      } else {
        ta.select();
        document.execCommand('copy');
        window.getSelection().removeAllRanges();
      }
      toast('Copied manifest text to clipboard.', 'success');
    } catch (e) {
      toast('Copy failed: ' + e.message, 'danger');
    }
  }

  function downloadManifestExample() {
    const ta = document.getElementById('manifestExampleText');
    if (!ta) return;
    const content = ta.value || '';
    const today = new Date().toISOString().split('T')[0];
    const a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
    a.download = 'manifest-example-' + today + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('Manifest downloaded.', 'success');
  }

  async function downloadAnswerKey() {
    if (!answerKeyData.length) {
      toast('This section\'s answer key is empty. Upload its model answers first.', 'warning');
      return;
    }
    const section = sectionsData.find(s => s.sectionId === currentSectionId);
    const today = new Date().toISOString().split('T')[0];
    let content, filename;
    if (section && section.sectionType === 'MANIFEST') {
      // Produce a manifest file in the exact 7-field format the
      // ManifestProcessor expects: base, ext, size_kb, width, height, ar, orientation
      const lines = answerKeyData.map(r => [
        r.baseName,
        r.extension,
        (r.sizeKb != null ? r.sizeKb : ''),
        (r.width  != null ? r.width  : ''),
        (r.height != null ? r.height : ''),
        (r.aspectRatio || ''),
        (r.orientation || '')
      ].join(', '));
      content = lines.join('\r\n');
      filename = 'manifest-' + (section ? section.name.replace(/[^\w\-]+/g, '_') : currentSectionId) + '-' + today + '.txt';
    } else {
      const lines = [
        '# Sectioned Image Metadata Grader — Answer Key',
        '# Section: ' + (section ? section.name : currentSectionId),
        '# Generated: ' + today,
        // Section-Types-plan Phase 2: size_kb ADDED to the exported format —
        // consistent with adding a real, persisted answer-key field (see
        // the Size (KB) column added to the on-screen table above).
        '# Format: base_name, filename, extension, width, height, size_kb, aspect_ratio, orientation',
        '#'
      ];
      answerKeyData.forEach(r => {
        lines.push([r.baseName, r.filename, r.extension, r.width, r.height,
          (r.sizeKb != null ? r.sizeKb : ''), r.aspectRatio, r.orientation].join(', '));
      });
      content = lines.join('\r\n');
      filename = 'answer-key-' + (section ? section.name.replace(/[^\w\-]+/g, '_') : currentSectionId) + '-' + today + '.txt';
    }

    const uri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
    const a   = document.createElement('a');
    a.href    = uri;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast((section && section.sectionType === 'MANIFEST' ? 'Manifest' : 'Answer key') + ' downloaded (' + answerKeyData.length + ' item' + (answerKeyData.length !== 1 ? 's' : '') + ').', 'success');
  }

  // ════════════════════════════════════════════════════════
  //  UPLOAD MODEL ANSWERS  (teacher only) — NEW Phase 3 (pHash feature)
  //  Replaces Drive-folder scanning as the way a section's AnswerKey is
  //  built. Files are parsed client-side through the EXACT SAME
  //  ImageProcessor pipeline the student Upload page uses — see the
  //  Guiding Principle in PRD_pHash_and_ClientSide_AnswerKey.md §0 — then
  //  handed to saveAnswerKeyFromUpload(), which full-replaces the
  //  currently-selected section's AnswerKey rows.
  // ════════════════════════════════════════════════════════

  /** Enables/disables the "Replace Section's Answer Key" button: needs both
   *  a selected section AND at least one successfully-processed staged
   *  file. Called after every file-select and every section change. */
  function updateAkUploadButtonState() {
    const btn = document.getElementById('btnAkUpload');
    if (!btn) return;
    btn.disabled = !currentSectionId || akPendingRecords.filter(r => r.valid).length === 0;
  }

  function akPreflightRowHtml(rec) {
    const dims = (rec.width && rec.height) ? (rec.width + ' × ' + rec.height + ' px')
      : (rec.dimensionNote ? '<span class="text-muted fst-italic">' + esc(rec.dimensionNote) + '</span>' : '—');
    const hash = rec.perceptualHash
      ? '<code class="small">' + esc(rec.perceptualHash) + '</code>'
      : '<span class="text-muted fst-italic">n/a</span>';
    if (rec.error) {
      return '<tr class="table-danger">' +
        '<td class="small">' + esc(rec.fileName) + '</td>' +
        '<td colspan="3" class="small"><i class="bi bi-x-circle me-1"></i>' + esc(rec.error) + '</td>' +
        '</tr>';
    }
    return '<tr>' +
      '<td class="small">' + esc(rec.fileName) + '</td>' +
      '<td><span class="badge bg-secondary">' + esc(rec.detectedExt) + '</span></td>' +
      '<td class="small">' + dims + '</td>' +
      '<td>' + hash + '</td>' +
      '</tr>';
  }

  function renderAkUploadPreview() {
    const wrap  = document.getElementById('akUploadPreview');
    const body  = document.getElementById('akUploadPreviewBody');
    const count = document.getElementById('akUploadCount');
    if (!wrap || !body || !count) return;

    count.textContent = akPendingRecords.length + ' file' + (akPendingRecords.length !== 1 ? 's' : '');
    if (!akPendingRecords.length) {
      wrap.classList.add('d-none');
      body.innerHTML = '';
      return;
    }
    wrap.classList.remove('d-none');
    body.innerHTML = akPendingRecords.map(akPreflightRowHtml).join('');
  }

  async function handleAkFileSelect(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!currentSectionId) {
      toast('Select a section above first (pick its radio button).', 'warning');
      return;
    }

    document.getElementById('akUploadPreview').classList.remove('d-none');
    document.getElementById('akUploadPreviewBody').innerHTML = spinnerRow(4);
    document.getElementById('akUploadCount').textContent = 'processing ' + files.length + '…';

    // Same shared pipeline the student Upload page uses — format
    // detection, dimensions, and computeAHash() all happen inside
    // ImageProcessor.processFiles(); this module never re-implements any
    // of that (see the Guiding Principle in the pHash PRD §0).
    const newRecords = await ImageProcessor.processFiles(files);
    akPendingRecords = akPendingRecords.concat(newRecords);

    renderAkUploadPreview();
    document.getElementById('akFileInput').value = '';
    updateAkUploadButtonState();
  }

  async function submitAnswerKeyUpload() {
    if (!currentSectionId) { toast('Select a section above first.', 'warning'); return; }

    const validRecords = akPendingRecords.filter(r => r.valid);
    if (!validRecords.length) { toast('No valid files staged to save.', 'warning'); return; }

    // Software Provenance Gate — Phase 3 fix: ImageProcessor.processFile()
    // now retains a `.file` reference (added for the submit-time software
    // scan — see App.attachSoftwareCheck_()), but File objects cannot
    // survive JSON.stringify() (they serialize to `{}`, silently dropping
    // every byte) — this is the fetch-based equivalent of the old
    // google.script.run restriction, same fix, different transport.
    // The student-submission path already sanitizes via
    // attachSoftwareCheck_(); this is the other call site
    // (ImageProcessor.processFile() output) that needs the same
    // stripping before any call() to the server.
    const payloadRecords = validRecords.map(r => {
      const plain = Object.assign({}, r);
      delete plain.file;
      return plain;
    });

    const section = sectionsData.find(s => s.sectionId === currentSectionId);
    const sectionName = section ? section.name : currentSectionId;

    showConfirm(
      'Replace Answer Key',
      'This replaces ALL existing answer-key entries for "' + sectionName + '" with the ' +
      validRecords.length + ' file(s) you just staged. This cannot be undone. Continue?',
      async () => {
        const btn = document.getElementById('btnAkUpload');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Saving…';
        try {
          const r = await call('saveAnswerKeyFromUpload', currentSectionId, payloadRecords);
          if (r.success) {
            toast('Answer key saved — ' + r.count + ' item(s) for "' + sectionName + '".', 'success');
            akPendingRecords = [];
            renderAkUploadPreview();
            await loadSections(); // refreshes item counts + re-loads this section's answer key table
          } else {
            toast(r.error, 'danger');
          }
        } catch (e) {
          toast('Save error: ' + (e && e.message ? e.message : String(e)), 'danger');
        } finally {
          btn.innerHTML = '<i class="bi bi-save-fill me-2"></i>Replace Section\'s Answer Key';
          updateAkUploadButtonState();
        }
      }
    );
  }

  // ════════════════════════════════════════════════════════
  //  SECTION SELECTOR  (public — shown on Upload page)  — NEW Phase 6
  //  Replaces the old flat "Conversion Requirements" card/engine (removed
  //  in this rewrite — see IMPLEMENTATION_PLAN §0). The whole Upload page
  //  — self-service submit, Check My Progress, and the teacher's Batch
  //  Grade tool — is scoped to whichever section is currently selected
  //  here. Sourced from the public, unauthenticated-safe getSectionsPublic()
  //  — never exposes folder IDs or answer-key contents to a non-teacher.
  // ════════════════════════════════════════════════════════

  async function loadUploadSections() {
    const wrap = document.getElementById('uploadSectionSelector');
    if (!wrap) return;
    try {
      const result = await call('getSectionsPublic');
      if (result && result.success === false) throw new Error(result.error || 'Server returned an error.');
      sectionsPublicData = JSON.parse((result && result.dataJson) || '[]');

      if (!sectionsPublicData.length) {
        wrap.innerHTML = '<div class="text-muted small fst-italic">No sections are available yet — check with your teacher.</div>';
        selectedSectionId = '';
        renderSectionChecks();
        const btn = document.getElementById('btnSubmit');
        if (btn) btn.disabled = true;
        return;
      }

      // Keep the current selection if it's still valid; otherwise default
      // to the first (lowest SortOrder) section.
      if (!selectedSectionId || !sectionsPublicData.some(s => s.sectionId === selectedSectionId)) {
        selectedSectionId = sectionsPublicData[0].sectionId;
      }

      renderUploadSectionSelector();
      renderSectionChecks();
      // Ensure the upload UI reflects the currently-selected section
      // immediately (some callers set selectedSectionId directly). Use
      // the selection application path with a forced-apply so the
      // blocks (image vs manifest) are shown correctly on page load.
      try { selectUploadSection(selectedSectionId, true); } catch (e) { /* ignore */ }

      const btn = document.getElementById('btnSubmit');
      if (btn) btn.disabled = pendingRecords.filter(r => r.valid).length === 0 || !selectedSectionId;
      updateBatchSubmitState();

      // If we already have a cached activity rollup (e.g. the student's
      // progress was already loaded), keep the section-specific views in
      // sync with whatever section ended up selected above.
      if (lastActivityProgress) {
        renderActivityProgressStrip(lastActivityProgress);
        const sectionProgress = lastActivityProgress.sections.find(s => s.sectionId === selectedSectionId);
        updateResultSectionView(sectionProgress);
      }
    } catch (e) {
      wrap.innerHTML = '<div class="text-danger small">Could not load sections.</div>';
    }
  }

  function renderUploadSectionSelector() {
    const wrap = document.getElementById('uploadSectionSelector');
    if (!wrap) return;
    wrap.innerHTML = sectionsPublicData.map(s =>
      '<button type="button" class="btn btn-sm ' +
      (s.sectionId === selectedSectionId ? 'btn-primary' : 'btn-outline-secondary') + '" ' +
      'onclick="App.selectUploadSection(\'' + esc(s.sectionId) + '\')">' +
      esc(s.name) + (s.sectionType === 'MANIFEST' ? ' <span class="badge bg-secondary ms-2">MANIFEST</span>' : '') +
      '</button>'
    ).join('');
  }

  /**
   * Switches which section the Upload page is scoped to WITHOUT a page
   * reload and without a new server round trip, if a progress rollup is
   * already cached (Phase 6 acceptance criteria: submit against Section A,
   * switch to Section B, submit there too, see both sections' progress
   * plus one combined activity total, all in place).
   */
  function selectUploadSection(sectionId, forceApply) {
    forceApply = !!forceApply;
    if (!sectionId) return;
    if (sectionId === selectedSectionId && !forceApply) return;
    selectedSectionId = sectionId;
    renderUploadSectionSelector();
    renderSectionChecks();
    updateBatchSubmitState();

    const btn = document.getElementById('btnSubmit');
    if (btn) btn.disabled = pendingRecords.filter(r => r.valid).length === 0 || !selectedSectionId;

    // Show/hide upload blocks based on section type (IMAGE vs MANIFEST)
    // sectionsPublicData is sourced from getSectionsPublic() and now
    // includes `sectionType` so students can branch upload UI correctly.
    const section = sectionsPublicData.find(s => s.sectionId === selectedSectionId);
    const imageBlock = document.getElementById('uploadImageBlock');
    const manifestBlock = document.getElementById('uploadManifestBlock');
    if (section && section.sectionType === 'MANIFEST') {
      if (imageBlock) imageBlock.classList.add('d-none');
      if (manifestBlock) manifestBlock.classList.remove('d-none');
      // Auto-open the manifest example for students to guide correct format
      // when they switch to a MANIFEST section.
      if (!isTeacher) {
        try { App.showManifestExample(false); } catch (e) { /* ignore */ }
      }
    } else {
      if (imageBlock) imageBlock.classList.remove('d-none');
      if (manifestBlock) manifestBlock.classList.add('d-none');
    }

    // Update any existing batch-grade blocks to match this section type
    try { applyBatchBlocksSectionType(); } catch (e) { /* ignore */ }

    if (lastActivityProgress) {
      renderActivityProgressStrip(lastActivityProgress);
      const sectionProgress = lastActivityProgress.sections.find(s => s.sectionId === selectedSectionId);
      updateResultSectionView(sectionProgress);
    }
  }

  // The seven scorable attributes, in plain-language form for students — do
  // NOT expose raw answer-key contents here, only which fields are
  // checked (IMPLEMENTATION_PLAN Phase 6 step 2).
  //
  // pHash-feature Phase 6: 'checkPerceptualHash' ADDED — phrased to make
  // clear up front that it's graded on a sliding scale, not pass/fail,
  // since that's the one attribute where "checked" doesn't mean binary.
  const SECTION_CHECK_DESCRIPTIONS = [
    { field: 'checkFilenameExact',  icon: 'bi-fonts',             label: 'Exact filename match (case- and whitespace-sensitive)' },
    { field: 'checkExtension',      icon: 'bi-file-earmark-code', label: 'File type, verified from the real file content — not the filename' },
    { field: 'checkWidth',          icon: 'bi-arrows-expand',     label: 'Width (px)' },
    { field: 'checkHeight',         icon: 'bi-arrows-collapse',   label: 'Height (px)' },
    // Section-Types-plan Phase 2: 'checkSize' ADDED, mirroring the pattern
    // of every existing entry — driven by getSectionsPublic()'s new
    // checkSize field (see Code.gs).
    { field: 'checkSize',           icon: 'bi-hdd',                label: 'File size (KB), within the global KB tolerance' },
    { field: 'checkAspectRatio',    icon: 'bi-aspect-ratio',      label: 'Aspect ratio' },
    { field: 'checkOrientation',    icon: 'bi-phone-landscape',   label: 'Orientation (landscape / portrait)' },
    { field: 'checkPerceptualHash', icon: 'bi-percent',           label: 'Visual similarity to the model answer — scored on a sliding scale, not pass/fail (skipped for PDF files)' }
  ];

  function renderSectionChecks() {
    const wrap  = document.getElementById('sectionChecksList');
    const label = document.getElementById('sectionChecksLabel');
    if (!wrap) return;

    const section = sectionsPublicData.find(s => s.sectionId === selectedSectionId);
    if (!section) {
      wrap.innerHTML = '<div class="text-muted small fst-italic">Select a section above to see what it checks.</div>';
      if (label) label.textContent = '';
      return;
    }
    if (label) label.textContent = '— ' + section.name;

    // Software Provenance Gate — Phase 6: a separate, unscored gate, told
    // apart from the scored checklist below it. Students should learn a
    // program is required (and which one) BEFORE they submit — otherwise
    // they'd only find out via a rejection after Phase 5 shipped the
    // teacher-side toggle. Appended after the checklist in both branches
    // below (populated and nothing-configured-to-score) since a gate can
    // be enabled independently of whether anything else is scored.
    const gateHtml = section.requireSoftwareCheck
      ? '<div class="alert alert-warning small py-2 px-3 mt-3 mb-0">' +
        '<i class="bi bi-shield-lock-fill me-1"></i>' +
        '<strong>Required, not scored:</strong> this file must show it was produced with ' +
        '<strong>' + esc(section.requiredSoftwareName) + '</strong>. This is checked automatically ' +
        'when you submit — it adds no points itself, but a file that fails this check is rejected ' +
        'outright, regardless of how well its other attributes match.' +
        '</div>'
      : '';

    const active = SECTION_CHECK_DESCRIPTIONS.filter(a => !!section[a.field]);
    if (!active.length) {
      wrap.innerHTML = '<div class="text-muted small fst-italic">This section has nothing configured to score — files you upload here are logged, but no points are possible.</div>' + gateHtml;
      return;
    }
    wrap.innerHTML = '<ul class="list-unstyled small mb-0 guide-list">' +
      active.map(a => '<li><i class="bi ' + a.icon + ' text-primary"></i>' + esc(a.label) + '</li>').join('') +
      '</ul>' + gateHtml;
  }

  // ════════════════════════════════════════════════════════
  //  UPLOAD SUBMISSION  (everyone) — real image/PDF files
  // ════════════════════════════════════════════════════════
  /**
   * Best-effort client-side preview of what will happen to a staged file —
   * NOT authoritative (the server always has the final word at Submit).
   * MODIFIED — Phase 4: no longer speaks in terms of "required target
   * formats" (that whole concept was removed in this rewrite — see
   * IMPLEMENTATION_PLAN §0 / Principle 6). All this can honestly say from
   * the client alone is whether the filename's claimed extension agrees
   * with what the file's bytes actually are — the anti-cheat mechanism is
   * still fully in effect (Principle 4), it just isn't framed as "this
   * won't count as one of the required conversions" anymore, since there's
   * no such list. Section-aware messaging ("does this match Section X's
   * answer key") arrives in Phase 6, once uploads are section-scoped.
   */
  function verdictPreview(rec) {
    if (rec.sourceType === 'MANIFEST') {
      if (rec.error) return '<span class="text-danger small"><i class="bi bi-x-circle me-1"></i>' + esc(rec.error) + '</span>';
      return '<span class="text-success small"><i class="bi bi-check-circle me-1"></i>manifest entry parsed</span>';
    }
    if (rec.error) {
      return '<span class="text-danger small"><i class="bi bi-x-circle me-1"></i>' + esc(rec.error) + '</span>';
    }
    if (!extEquivalent(rec.declaredExt, rec.detectedExt)) {
      return '<span class="text-danger small"><i class="bi bi-exclamation-triangle me-1"></i>' +
        'filename says .' + esc(rec.declaredExt || '?') + ' but this file\'s actual content is ' +
        esc(rec.detectedExt) + ' — grading always uses the real, detected format, never the filename</span>';
    }
    return '<span class="text-success small"><i class="bi bi-check-circle me-1"></i>looks like a genuine ' +
      esc(rec.detectedExt) + ' file — name and actual content agree</span>';
  }

  function preflightRowHtml(rec) {
    const dims = (rec.width && rec.height) ? (rec.width + ' × ' + rec.height + ' px')
      : (rec.dimensionNote ? '<span class="text-muted fst-italic">' + esc(rec.dimensionNote) + '</span>' : '—');
    return '<tr>' +
      '<td class="small">' + esc(rec.fileName) + '</td>' +
      '<td class="small">' + esc(rec.baseName) + '</td>' +
      '<td><span class="badge ' + (rec.valid ? 'bg-secondary' : 'bg-danger') + '">' + esc(rec.detectedExt) + '</span></td>' +
      '<td class="small">' + dims + '</td>' +
      '<td class="small">' + esc(rec.sizeKb) + ' KB</td>' +
      '<td>' + verdictPreview(rec) + '</td>' +
      '</tr>';
  }

  async function handleFileSelect(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    document.getElementById('preflightPreview').classList.remove('d-none');
    document.getElementById('preflightBody').innerHTML = spinnerRow(6);
    document.getElementById('preflightCount').textContent = 'processing ' + files.length + '…';

    const newRecords = await ImageProcessor.processFiles(files);
    pendingRecords = pendingRecords.concat(newRecords);

    renderPreflight();
    document.getElementById('fileInput').value = '';
    document.getElementById('btnSubmit').disabled = pendingRecords.filter(r => r.valid).length === 0 || !selectedSectionId;
  }

  async function handleManifestFileSelect(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    // Only allow one manifest file at a time for now — parse its text.
    const file = files[0];
    try {
      const text = await file.text();
      const parsed = ManifestProcessor.parseManifest(text);
      // Map manifest records into the shared pendingRecords shape.
      const mapped = parsed.map(p => {
        return {
          fileName: (p.baseName && p.declaredExt) ? (p.baseName + '.' + p.declaredExt) : p.baseName,
          baseName: p.baseName || '',
          declaredExt: p.declaredExt || '',
          detectedExt: p.declaredExt || 'UNKNOWN',
          width: p.width,
          height: p.height,
          sizeKb: p.sizeKb,
          aspectRatio: p.aspectRatio || '',
          orientation: p.orientation || '',
          dimensionNote: '',
          perceptualHash: null,
          valid: !!p.valid,
          error: p.error || null,
          sourceType: 'MANIFEST'
        };
      });
      pendingRecords = pendingRecords.concat(mapped);
      document.getElementById('preflightPreview').classList.remove('d-none');
      renderPreflight();
      document.getElementById('manifestFileInput').value = '';
      document.getElementById('btnSubmit').disabled = pendingRecords.filter(r => r.valid).length === 0 || !selectedSectionId;
    } catch (e) {
      toast('Failed to read manifest file: ' + e.message, 'danger');
    }
  }

  function renderPreflight() {
    const body = document.getElementById('preflightBody');
    document.getElementById('preflightCount').textContent =
      pendingRecords.length + ' file' + (pendingRecords.length !== 1 ? 's' : '');
    body.innerHTML = pendingRecords.length
      ? pendingRecords.map(preflightRowHtml).join('')
      : '<tr><td colspan="6" class="text-center text-muted py-3">No files staged yet.</td></tr>';
  }

  /**
   * Software Provenance Gate — Phase 3. Submit-time re-scan + payload
   * sanitizer. Runs immediately before submitFileBatch() is called,
   * against whichever section is CURRENTLY selected, so switching
   * sections after staging files never submits a stale scan result.
   *
   * File objects never survive JSON.stringify() (see submitAnswerKeyUpload()'s
   * comment above) — they're stripped from every payload (delete plain.file)
   * before serialization; only the
   * plain {softwareCheckPassed, softwareCheckDetail} result travels to
   * the server.
   *
   * @param {Array<Object>} records  ImageProcessor records (each may carry
   *   a `.file` reference — see ImageProcessor.processFile()).
   * @param {Object} section  A sectionsPublicData entry (or undefined).
   * @returns {Promise<Array<Object>>} plain, server-safe records
   */
  async function attachSoftwareCheck_(records, section) {
    const requireCheck   = !!(section && section.requireSoftwareCheck);
    const targetSoftware = section ? section.requiredSoftwareName : '';
    const out = [];
    for (const rec of records) {
      const plain = Object.assign({}, rec);
      delete plain.file;
      if (requireCheck) {
        const inspection = await ImageProcessor.inspectMetadataProvenance(rec.file, targetSoftware);
        plain.softwareCheckPassed = inspection.passed;
        plain.softwareCheckDetail = inspection.detail;
      }
      out.push(plain);
    }
    return out;
  }

  async function submitAnswers() {
    if (!selectedSectionId) { toast('Select a section above first.', 'warning'); return; }

    // PORTED — index.html now renders both the teacher's free-text input
    // and the student's read-only field at once (role visibility is a
    // client-side class toggle now, not server-side omission — see
    // applyRoleUI()), so they can no longer share one DOM id. A teacher's
    // studentNumberInputTeacher value is only ever a testing convenience;
    // a student's own number is never read from a form field at all — it
    // comes from currentStudentNumber, resolved server-side in
    // bootstrapAuth() via getCurrentUserContext(), exactly matching
    // Principle 1 in PROJECT_BRIEF §1.
    const numInput = isTeacher ? document.getElementById('studentNumberInputTeacher') : null;
    const studentNumber = isTeacher ? (numInput ? numInput.value.trim() : '') : currentStudentNumber;
    if (!studentNumber) { toast('Enter your student number first.', 'warning'); return; }

    const validRecords = pendingRecords.filter(r => r.valid);
    if (!validRecords.length) { toast('No valid files to submit.', 'warning'); return; }

    const btn = document.getElementById('btnSubmit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Submitting…';
    try {
      // Software Provenance Gate — Phase 3: re-scan against whichever
      // section is currently selected and strip File objects before this
      // crosses the fetch/JSON boundary to the Edge Function. A no-op pass-through (aside
      // from stripping .file) when the section doesn't require the gate.
      const section = sectionsPublicData.find(s => s.sectionId === selectedSectionId);
      const payloadRecords = await attachSoftwareCheck_(validRecords, section);

      // sectionId is now a required first argument — every submission is
      // scored against exactly one section's answer key (Phase 5/6).
      const result = await call('submitFileBatch', selectedSectionId, studentNumber, payloadRecords);
      renderSubmitResult(result);
      if (result.success) {
        pendingRecords = [];
        renderPreflight();
        document.getElementById('preflightPreview').classList.add('d-none');
      }
    } catch (e) {
      toast('Submission failed: ' + e.message, 'danger');
    } finally {
      btn.disabled = pendingRecords.filter(r => r.valid).length === 0 || !selectedSectionId;
      btn.innerHTML = '<i class="bi bi-send-fill me-2"></i>Submit Files for Grading';
    }
  }

  async function checkMyResult(silent) {
    const btn = document.getElementById('btnCheckResult');
    if (btn && !silent) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Checking…';
    }
    try {
      // No student number is passed for a non-teacher — the server resolves
      // "my" identity from the signed-in session (Students sheet, matched by
      // email) rather than trusting anything the client could have altered.
      const result = await call('getMySubmissionStatusGrouped', isTeacher ? currentStudentNumber : undefined);

      // On the silent auto-check at page load, a brand-new student with no
      // activity yet just stays on the empty state — no need to surface
      // "no submissions found" as an error before they've uploaded anything.
      if (silent && !result.success) return;

      renderSubmitResult(result);
      if (result.success && !silent) {
        const card = document.getElementById('resultCard');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (e) {
      if (!silent) toast('Lookup failed: ' + e.message, 'danger');
    } finally {
      if (btn && !silent) {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-search me-1"></i>Check My Progress';
      }
    }
  }

  /**
   * Renders ONE section's item checklist — replaces the old flat
   * buildGroupChecklistHtml (which spoke in terms of "required target
   * formats", a concept this rewrite removed — see IMPLEMENTATION_PLAN
   * §0). `items` is buildSectionProgress_()'s per-answer-key-entry array:
   * { baseName, filename, extension, result, attributeScores, rawScore, rawMax }.
   */
  // Maps SubmittedFiles.AttributeScoresJson keys (set in Code.gs'
  // submitFileBatch()) to short display labels for the per-item breakdown.
  const ATTRIBUTE_LABELS_ = {
    filename:       'Name',
    extension:      'Ext',
    width:          'Width',
    height:         'Height',
    // Section-Types-plan Phase 2: 'size' is a plain binary attribute
    // (within-tolerance or not), so it renders through the normal
    // check/cross chip path in buildAttributeBreakdownHtml() — no special
    // badge needed, unlike perceptualHash.
    size:           'Size',
    aspectRatio:    'Aspect Ratio',
    orientation:    'Orientation',
    // pHash-feature Phase 6: label only used as a fallback/tooltip context —
    // the perceptualHash badge itself is rendered specially (see
    // pHashBadgeHtml below), never as a plain check/cross like the rest.
    perceptualHash: 'pHash',
    // Software Provenance Gate — Phase 7: label only used as a fallback/
    // tooltip context — the softwareCheck chip/badge itself is rendered
    // specially (shield icon instead of check/cross) everywhere this map
    // is consulted, same pattern as perceptualHash above.
    softwareCheck:  'Software Check'
  };

  /**
   * NEW — pHash-feature Phase 6. Formats a possibly-fractional score for
   * plain-text display (e.g. "2.75 / 3"): rounds to at most 2 decimal
   * places and trims trailing zeros, so a floating-point sum like
   * 2.5714285714285716 reads as "2.57" instead of dumping its full
   * precision in the UI. Purely cosmetic — never changes what's stored or
   * what's used for actual grading math.
   */
  function fmtScore_(n) {
    const num = Number(n) || 0;
    return Math.round(num * 100) / 100;
  }

  /**
   * Renders one chip per SCORED attribute (i.e. only attributes the section
   * actually has checked), green/check if it matched, red/cross if it
   * didn't — so both the student's own checklist and the teacher's expanded
   * Results row can show exactly which fields were right or wrong, not just
   * the aggregate rawScore/rawMax count.
   *
   * pHash-feature Phase 6: 'perceptualHash' is the one FRACTIONAL attribute
   * in this app (everything else is strictly 0 or 1) — collapsing a
   * mid-range visual-similarity score down to a binary check/cross would
   * misreport "somewhat similar" as either "fully right" or "fully wrong".
   * It's special-cased below to its own percentage badge (pHashBadgeHtml);
   * every other key's rendering is completely unchanged.
   */
  function buildAttributeBreakdownHtml(attributeScores) {
    const scores = attributeScores || {};
    // 'perceptualHashDistance' is stored alongside 'perceptualHash' purely
    // as raw data for later analysis (see submitFileBatch() in Code.gs) —
    // it's the scoring INPUT, not an independently scored attribute, so it
    // never gets its own chip here; pHashBadgeHtml folds it into the
    // perceptualHash badge instead (see below).
    const keys = Object.keys(scores).filter(k => k !== 'perceptualHashDistance');
    if (!keys.length) return '';
    return '<div class="d-flex flex-wrap gap-1 mt-2">' +
      keys.map(k => {
        if (k === 'perceptualHash') return pHashBadgeHtml(scores[k], scores.perceptualHashDistance);
        const ok      = !!scores[k];
        const label   = ATTRIBUTE_LABELS_[k] || k;
        // Software Provenance Gate — Phase 7: a shield icon instead of
        // plain check/cross, so a gate-caused rejection reads visually
        // distinct from an ordinary attribute miss at a glance — same
        // green/red badge coloring as everything else, just a different
        // icon and an explanatory tooltip since this is a pass/fail GATE,
        // not a scored attribute (see IMPLEMENTATION_PLAN §1d/§2).
        const isGate  = (k === 'softwareCheck');
        const icon    = isGate ? (ok ? 'bi-shield-check' : 'bi-shield-x') : (ok ? 'bi-check-lg' : 'bi-x-lg');
        return '<span class="badge ' + (ok ? 'bg-success-subtle text-success border border-success-subtle'
                                            : 'bg-danger-subtle text-danger border border-danger-subtle') + '"' +
          (isGate ? ' title="Gate check — required, but does not add or remove points"' : '') + '>' +
          '<i class="bi ' + icon + ' me-1"></i>' + esc(label) +
          '</span>';
      }).join('') +
      '</div>';
  }

  /**
   * NEW — pHash-feature Phase 6 (FR-6). Renders the fractional
   * `perceptualHash` score (0–1, as stored by submitFileBatch()) as its
   * own percentage badge with a three-tier color scale — distinct in both
   * color logic and iconography from the binary check/cross badges every
   * other attribute uses, so a PARTIAL result driven by a mid-range pHash
   * score is unmistakably not the same thing as a flat attribute miss.
   *   • ≥75% → green  (close visual match)
   *   • ≥40% → amber  (partial visual match)
   *   • <40% → red    (little/no visual match)
   *
   * `distance`, when present, is the raw Hamming Distance the score was
   * derived from (0–64) — shown both inline and in the tooltip so a
   * teacher can see the underlying number, not just the collapsed score,
   * without having to open the Submissions sheet's AttributeScoresJson
   * column directly.
   */
  function pHashBadgeHtml(score, distance) {
    const s    = Math.max(0, Math.min(1, Number(score) || 0));
    const pct  = Math.round(s * 100);
    const tier = s >= 0.75 ? 'success' : s >= 0.4 ? 'warning' : 'danger';
    const textCls = tier === 'warning' ? 'text-dark' : ('text-' + tier);
    const hasDistance = distance !== null && distance !== undefined && !isNaN(distance);
    const distSuffix = hasDistance ? ' <span class="opacity-75">(dist ' + esc(distance) + ')</span>' : '';
    const titleAttr = 'title="Perceptual hash (visual) similarity score' +
      (hasDistance ? ' — Hamming Distance ' + esc(distance) : '') + '"';
    return '<span class="badge bg-' + tier + '-subtle ' + textCls + ' border border-' + tier + '-subtle" ' + titleAttr + '>' +
      '<i class="bi bi-percent me-1"></i>pHash ' + pct + '%' + distSuffix +
      '</span>';
  }

  /**
   * NEW — mirrors the mockup's (student-portal-mockup-v2.html) per-section
   * results table: one row per answer-key item, a mini file thumb + base
   * name, a compact chip per scored attribute (chip-sm correct/rejected/
   * pending — same classes the mockup uses for per-target-format chips,
   * repurposed here for per-attribute results), a status badge, and an
   * eye-button that opens itemDetailModal with the full per-attribute
   * breakdown — exactly the mockup's row → #frameModal pattern.
   */
  function attributeChipClass_(key, scores, result) {
    if (result === 'NOT_SUBMITTED') return 'pending';
    if (key === 'perceptualHash') {
      const s = Math.max(0, Math.min(1, Number(scores[key]) || 0));
      return s >= 0.75 ? 'correct' : s >= 0.4 ? 'pending' : 'rejected';
    }
    return scores[key] ? 'correct' : 'rejected';
  }

  function buildAttributeChipsHtml(it) {
    const scores = it.attributeScores || {};
    const keys = Object.keys(scores).filter(k => k !== 'perceptualHashDistance');
    if (!keys.length) {
      return '<span class="chip-sm pending" title="Not submitted"><i class="bi bi-dash"></i></span>';
    }
    return '<div class="d-flex flex-wrap gap-1">' + keys.map(k => {
      const label = ATTRIBUTE_LABELS_[k] || k;
      const cls   = attributeChipClass_(k, scores, it.result);
      // Software Provenance Gate — Phase 7 (cosmetic, §7c): shield icon
      // instead of check/cross/dash for the gate marker, matching the
      // shield treatment used in buildAttributeBreakdownHtml() (§7b) and
      // openItemDetailModal() (§7d) — purely visual, attributeChipClass_()
      // above already classifies softwareCheck correctly via its binary
      // (0/1) fallback.
      const isGate = (k === 'softwareCheck');
      const icon  = isGate
        ? (cls === 'correct' ? 'bi-shield-check' : cls === 'rejected' ? 'bi-shield-x' : 'bi-shield')
        : (cls === 'correct' ? 'bi-check-lg' : cls === 'rejected' ? 'bi-x-lg' : 'bi-dash');
      return '<span class="chip-sm ' + cls + '" title="' + esc(label) + '"><i class="bi ' + icon + '"></i></span>';
    }).join('') + '</div>';
  }

  function buildSectionChecklistHtml(sectionId, items) {
    currentChecklistItems[sectionId] = items || [];
    if (!items || !items.length) {
      return '<div class="text-muted small fst-italic p-3">No items in this section\'s answer key yet.</div>';
    }
    const rows = items.map((it, i) => {
      const pct = it.rawMax > 0 ? (fmtScore_(it.rawScore) / it.rawMax) * 100 : null;
      return '<tr>' +
        '<td class="text-muted">' + (i + 1) + '</td>' +
        '<td><div class="d-flex align-items-center gap-2">' +
        '<div class="frame-mini-thumb" style="background:linear-gradient(155deg,#64748b,#334155)"><i class="bi bi-file-earmark-image"></i></div>' +
        '<span class="fw-semibold small">' + esc(it.baseName) + '</span></div></td>' +
        '<td>' + (it.extension ? '<span class="badge bg-secondary">' + esc(it.extension) + '</span>' : '<span class="text-muted small">—</span>') + '</td>' +
        '<td>' + buildAttributeChipsHtml(it) + '</td>' +
        '<td>' + (pct !== null ? scoreBadge(pct) : resultBadge(it.result)) + '</td>' +
        '<td class="text-end"><button class="btn btn-sm btn-outline-secondary" ' +
        'onclick="App.openItemDetailModal(\'' + esc(sectionId) + '\', ' + i + ')"><i class="bi bi-eye"></i></button></td>' +
        '</tr>';
    }).join('');
    return '<div class="table-responsive">' +
      '<table class="table table-hover mb-0">' +
      '<thead><tr><th style="width:34px">#</th><th>File</th><th style="width:90px">Ext</th>' +
      '<th style="min-width:180px">Attributes</th><th style="width:100px">Status</th><th style="width:56px"></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  /** Opens itemDetailModal for row `idx` of section `sectionId`'s currently-
   *  rendered checklist — same one-item-at-a-time modal pattern as the
   *  mockup's openFrameModal(), but sourced from real per-attribute scoring
   *  data instead of the mockup's dummy per-target-format status object. */
  function openItemDetailModal(sectionId, idx) {
    const it = (currentChecklistItems[sectionId] || [])[idx];
    if (!it) return;
    document.getElementById('itemDetailModalTitle').textContent = it.baseName;
    document.getElementById('itemDetailModalSub').textContent =
      (it.extension ? it.extension + ' · ' : '') +
      (it.rawMax ? fmtScore_(it.rawScore) + ' / ' + it.rawMax + ' points' : 'no points possible');

    const scores = it.attributeScores || {};
    const keys = Object.keys(scores).filter(k => k !== 'perceptualHashDistance');
    let rows;
    if (it.result === 'NOT_SUBMITTED' || !keys.length) {
      rows = '<div class="text-muted small fst-italic">' +
        (it.result === 'NOT_SUBMITTED' ? 'Not uploaded yet.' : 'No scored attributes for this item.') +
        '</div>';
    } else {
      rows = keys.map(k => {
        const label = ATTRIBUTE_LABELS_[k] || k;
        if (k === 'perceptualHash') {
          const s    = Math.max(0, Math.min(1, Number(scores[k]) || 0));
          const dist = scores.perceptualHashDistance;
          const icon = s >= 0.75 ? 'bi-check-circle-fill text-success' : s >= 0.4 ? 'bi-dash-circle-fill text-warning' : 'bi-x-circle-fill text-danger';
          return '<div class="detail-target-row">' +
            '<span class="fw-semibold small"><i class="bi ' + icon + ' me-2"></i>' + esc(label) + '</span>' +
            '<span class="note">' + Math.round(s * 100) + '% visual similarity' +
            (dist !== null && dist !== undefined ? ' (Hamming distance ' + esc(dist) + ')' : '') + '</span>' +
            '</div>';
        }
        // Software Provenance Gate — Phase 7: shield icon + a plain-
        // language line, alongside the existing perceptualHash special
        // case — same shield treatment as §7b/§7c so a gate result is
        // never confused with an ordinary attribute miss in the detail
        // modal either.
        if (k === 'softwareCheck') {
          const ok = !!scores[k];
          const icon = ok ? 'bi-shield-check text-success' : 'bi-shield-x text-danger';
          return '<div class="detail-target-row">' +
            '<span class="fw-semibold small"><i class="bi ' + icon + ' me-2"></i>' + esc(label) + '</span>' +
            '<span class="note">' + (ok ? 'Required software signature found.' : 'Required software signature not found — file rejected.') + '</span>' +
            '</div>';
        }
        const ok   = !!scores[k];
        const icon = ok ? 'bi-check-circle-fill text-success' : 'bi-x-circle-fill text-danger';
        return '<div class="detail-target-row">' +
          '<span class="fw-semibold small"><i class="bi ' + icon + ' me-2"></i>' + esc(label) + '</span>' +
          '<span class="note">' + (ok ? 'Matches the answer key.' : 'Does not match the answer key.') + '</span>' +
          '</div>';
      }).join('');
    }
    document.getElementById('itemDetailModalBody').innerHTML = '<div class="group-checklist-card">' + rows + '</div>';
    new bootstrap.Modal(document.getElementById('itemDetailModal')).show();
  }

  /**
   * NEW — Phase 6. Fills the persistent Activity Progress strip: EVERY
   * enabled section's score/max as a mini progress bar, plus the combined
   * activity-level total in the card's badge — visible regardless of
   * which single section the student currently has selected below.
   */
  function renderActivityProgressStrip(activity) {
    const card  = document.getElementById('activityProgressCard');
    const body  = document.getElementById('activityProgressBody');
    const total = document.getElementById('activityTotalBadge');
    if (!card || !body || !total) return;

    if (!activity || !activity.sections || !activity.sections.length) {
      card.classList.add('d-none');
      return;
    }
    card.classList.remove('d-none');
    const pct = parseFloat(activity.percentage) || 0;
    total.textContent = activity.activityScore + ' / ' + activity.activityMax + ' (' + pct.toFixed(1) + '%)';

    body.innerHTML = activity.sections.map(s => {
      const spct = parseFloat(s.percentage) || 0;
      const bcls = spct >= 90 ? 'success' : spct >= 75 ? 'primary' : spct >= 50 ? 'warning' : 'danger';
      const isActive = s.sectionId === selectedSectionId;
      return '<div class="mb-3">' +
        '<div class="d-flex justify-content-between align-items-center mb-1">' +
        '<span class="small fw-semibold' + (isActive ? ' text-primary' : '') + '">' +
        (isActive ? '<i class="bi bi-caret-right-fill me-1"></i>' : '') + esc(s.sectionName) + '</span>' +
        '<span class="small text-muted">' + s.sectionScore + ' / ' + s.sectionMax + '</span>' +
        '</div>' +
        '<div class="progress" style="height:8px">' +
        '<div class="progress-bar bg-' + bcls + '" style="width:' + Math.min(spct, 100) + '%"></div>' +
        '</div></div>';
    }).join('');
  }

  /**
   * NEW — Phase 6. Renders just the "currently selected section" portion
   * of the result card (score + item checklist) into #resultSectionView,
   * so App.selectUploadSection() can swap sections in place without
   * re-fetching from the server or disturbing the rest of the card (e.g.
   * the per-file verdicts table from the last submit).
   */
  function updateResultSectionView(sectionProgress) {
    const el = document.getElementById('resultSectionView');
    if (!el) return;
    if (!sectionProgress) {
      el.innerHTML = '<div class="text-muted small fst-italic">Select a section above to see its score.</div>';
      return;
    }
    const pct  = parseFloat(sectionProgress.percentage) || 0;
    const bcls = pct >= 90 ? 'success' : pct >= 75 ? 'primary' : pct >= 50 ? 'warning' : 'danger';
    el.innerHTML =
      '<div class="text-center">' +
      '<div class="small text-muted mb-1">' + esc(sectionProgress.sectionName) + '</div>' +
      '<div class="display-6 fw-black text-' + bcls + '">' + sectionProgress.sectionScore + ' / ' + sectionProgress.sectionMax + '</div>' +
      '<div class="text-muted small mb-2">this section\'s score</div>' +
      '<div class="mt-2 mb-3">' + scoreBadge(pct) + '</div>' +
      '<div class="progress" style="height:12px">' +
      '<div class="progress-bar bg-' + bcls + '" style="width:' + Math.min(pct, 100) + '%"></div>' +
      '</div></div>';
  }

  /**
   * NEW — mirrors student-portal-mockup-v2.html's stacked, full-width
   * "Section 1 — Studio Portraits" / "Section 2 — Landscape Exports" cards:
   * one card per enabled section, ALL rendered at once into
   * #studentSectionResults (below the two-column upload/summary layout —
   * see index.html), each with a header badge ("X / Y correct") and the
   * item-checklist table from buildSectionChecklistHtml(). Unlike the
   * narrow sidebar score summary above, this lives at full page width, so
   * it has room for every scored attribute's chip without wrapping into a
   * cramped multi-line mess.
   */
  function renderStudentSectionCards(activity) {
    const wrap = document.getElementById('studentSectionResults');
    if (!wrap) return;
    if (!activity || !activity.sections || !activity.sections.length) {
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = activity.sections.map(sec => {
      const correctCount = (sec.items || []).filter(it => it.result === 'CORRECT').length;
      // req-chip mirrors the mockup's "JPEG → PNG · BMP · GIF · PDF" summary
      // — here that's "what this section scores" instead of target formats,
      // since that whole concept was retired (see JavaScript.html header
      // notes). Sourced from sectionsPublicData (the public check-flags
      // list also used by renderSectionChecks()), keyed by sectionId.
      const publicSection = sectionsPublicData.find(s => s.sectionId === sec.sectionId);
      const checkedLabels = publicSection
        ? SECTION_CHECK_DESCRIPTIONS.filter(a => !!publicSection[a.field])
            .map(a => a.label.split(/[,(]/)[0].split(' ').slice(0, 2).join(' ').trim())
        : [];
      const reqChip = checkedLabels.length
        ? '<span class="req-chip">' + esc(checkedLabels.join(' · ')) + '</span>'
        : '';
      return '<div class="card section-card mt-4">' +
        '<div class="card-header">' +
        '<i class="bi bi-collection-fill me-2 text-primary"></i>' + esc(sec.sectionName) +
        reqChip +
        '<span class="ms-auto sub">' + correctCount + ' / ' + (sec.items || []).length + ' correct</span>' +
        '</div>' +
        '<div class="card-body p-0">' + buildSectionChecklistHtml(sec.sectionId, sec.items) + '</div>' +
        '</div>';
    }).join('');
  }

  /**
   * MODIFIED — Phase 6. `result` is either submitFileBatch()'s response
   * (has `results[]`, `sectionId`, `sectionProgress`, `activityProgress`)
   * or getMySubmissionStatusGrouped()'s response (the activity rollup
   * itself: `activityScore`, `activityMax`, `sections[]`). Either way, the
   * persistent Activity Progress strip is refreshed with the FULL
   * multi-section rollup, and the section-specific checklist below always
   * reflects whichever section is currently selected — snapping to the
   * section that was just submitted to, if this came from a submit.
   */
  function renderSubmitResult(result) {
    const card   = document.getElementById('resultCard');
    const header = document.getElementById('resultCardHeader');
    const body   = document.getElementById('resultBody');
    card.classList.remove('d-none');

    if (!result.success) {
      header.innerHTML = '<i class="bi bi-x-circle-fill me-2 text-danger"></i>Not Found / Error';
      body.innerHTML =
        '<div class="alert alert-danger mb-0">' +
        '<i class="bi bi-exclamation-triangle me-2"></i>' + esc(result.error) + '</div>';
      return;
    }

    const isSubmit = Array.isArray(result.results);
    const activity  = isSubmit ? result.activityProgress : result;
    lastActivityProgress = activity;
    renderActivityProgressStrip(activity);

    header.innerHTML = '<i class="bi bi-clipboard-check-fill me-2 text-success"></i>' +
      (isSubmit ? 'Files Graded' : 'Your Progress');

    let fileVerdicts = '';
    if (isSubmit && result.results.length) {
      fileVerdicts = '<div class="table-responsive mb-3 border rounded-3">' +
        '<table class="table table-sm mb-0"><thead class="table-light"><tr>' +
        '<th>File</th><th>Detected</th><th>Result</th><th>Score</th><th>Reason</th>' +
        '</tr></thead><tbody>' +
        result.results.map(r =>
          '<tr>' +
          '<td class="small">' + esc(r.fileName || r.baseName) + '</td>' +
          '<td><span class="badge bg-secondary">' + esc(r.detectedExt) + '</span></td>' +
          '<td>' + resultBadge(r.result) + '</td>' +
          '<td class="small text-muted">' +
            (r.rawMax ? (fmtScore_(r.rawScore) + ' / ' + r.rawMax) : '—') +
            buildAttributeBreakdownHtml(r.attributeScores) +
          '</td>' +
          '<td class="small text-muted">' + esc(r.reason || '—') + '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table></div>';
    }

    // A fresh submit snaps the section selector to whichever section was
    // actually submitted to, so the checklist below matches what the
    // student just did rather than whatever was selected before.
    if (isSubmit && result.sectionId && result.sectionId !== selectedSectionId) {
      selectedSectionId = result.sectionId;
      renderUploadSectionSelector();
      renderSectionChecks();
    }

    body.innerHTML =
      '<div class="text-center mb-3">' +
      '<div class="fw-bold fs-5 mb-1">' + esc(result.studentName) + '</div>' +
      '<div class="text-muted small">Student # ' + esc(String(result.studentNumber)) + '</div>' +
      '</div>' +
      fileVerdicts +
      '<div class="d-flex justify-content-between align-items-center mb-2">' +
      '<h6 class="mb-0 fw-semibold small"><i class="bi bi-list-check me-1"></i>Section Summary</h6>' +
      '<button class="btn btn-sm btn-outline-secondary" onclick="App.openMyResultModal()">View Details</button>' +
      '</div>' +
      '<div id="resultSectionView"></div>';

    const sectionProgress = (activity.sections || []).find(s => s.sectionId === selectedSectionId);
    updateResultSectionView(sectionProgress);
    if (!isTeacher) renderStudentSectionCards(activity);

    if (isSubmit) {
      const correctCount = result.results.filter(r => r.result === 'CORRECT').length;
      toast(correctCount + ' of ' + result.results.length + ' file(s) scored CORRECT.',
        correctCount === result.results.length ? 'success' : 'warning');
    }
  }

  // ════════════════════════════════════════════════════════
  //  RESULTS  (teacher only) — grouped, "X / Y versions correct"
  // ════════════════════════════════════════════════════════
  async function loadResults() {
    if (!isTeacher) return;
    document.getElementById('resultsBody').innerHTML = spinnerRow(6);
    document.getElementById('resultsCount').textContent = '…';
    try {
      const result = await call('getResultsGrouped');
      if (result && result.success === false)
        throw new Error(result.error || 'Server returned an error.');
      resultsData = JSON.parse((result && result.dataJson) || '[]');
      renderResults(resultsData);
    } catch (e) {
      document.getElementById('resultsBody').innerHTML = emptyRow(6, 'Failed to load results.');
      document.getElementById('resultsCount').textContent = '0';
      toast('Error loading results: ' + (e && e.message ? e.message : String(e)), 'danger');
    }
  }

  function renderResults(data) {
    data = Array.isArray(data) ? data : [];
    document.getElementById('resultsCount').textContent = data.length;
    const tbody = document.getElementById('resultsBody');
    if (!data.length) {
      tbody.innerHTML = emptyRow(6, 'No student activity yet.');
      return;
    }

    tbody.innerHTML = data.map((s, i) => {
      return '<tr>' +
        '<td><code>' + esc(String(s.studentNumber)) + '</code></td>' +
        '<td>' + esc(s.studentName) + '</td>' +
        '<td><strong>' + s.activityScore + '</strong>/<span class="text-muted">' + s.activityMax + '</span></td>' +
        '<td>' + scoreBadge(s.percentage) + '</td>' +
        '<td><small class="text-muted">' + esc(s.lastSubmitted) + '</small></td>' +
        '<td><button class="btn btn-sm btn-outline-secondary" title="View section breakdown" ' +
        'onclick="App.openResultsModal(' + i + ')">' +
        '<i class="bi bi-eye"></i></button></td>' +
        '</tr>';
    }).join('');
  }

  /**
   * MODIFIED — Phase 7. Expandable per-student detail row: one block per
   * enabled section with its sectionScore/sectionMax and the same per-item
   * checklist renderer the student's own "Check My Result" view uses
   * (buildSectionChecklistHtml) — reused rather than duplicated, so the
   * teacher's expanded view can never drift from what the student sees.
   * `s.sections` comes straight from buildActivityProgress_() via
   * getResultsGrouped(), which is the single source of truth for both.
   */
  function buildResultsDetailHtml(s) {
    if (!s || !Array.isArray(s.sections) || !s.sections.length) {
      return '<div class="text-muted small fst-italic">No section activity yet.</div>';
    }
    return s.sections.map(sec => buildSectionCardHtml(sec)).join('');
  }

  function buildSectionCardHtml(sec) {
    if (!sec) return '';
    const pct = parseFloat(sec.percentage) || 0;
    const header = '<div class="d-flex align-items-center justify-content-between mb-2">' +
      '<div><span class="fw-semibold small">' + esc(sec.sectionName) + '</span></div>' +
      '<div class="text-muted small">' + sec.sectionScore + ' / ' + sec.sectionMax + '</div>' +
      '</div>';
    const itemsHtml = (sec.items || []).map(it => {
      const correctCount = it.rawMax ? (fmtScore_(it.rawScore) + ' / ' + it.rawMax) : '';
      return '<div class="group-checklist-card mb-2">' +
        '<div class="d-flex align-items-center justify-content-between gap-2 mb-2">' +
          '<div class="d-flex align-items-center gap-2">' +
            '<div class="frame-mini-thumb" style="background:linear-gradient(155deg,#64748b,#334155)"><i class="bi bi-file-earmark-image"></i></div>' +
            '<div><div class="fw-semibold small">' + esc(it.baseName) + '</div>' +
              (it.extension ? '<div class="small text-muted">' + esc(it.extension) + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div class="text-end">' +
            (correctCount ? '<div class="text-muted small mb-1">' + correctCount + '</div>' : '') +
            resultBadge(it.result) +
          '</div>' +
        '</div>' +
        '<div>' + buildAttributeBreakdownHtml(it.attributeScores) + '</div>' +
        '</div>';
    }).join('');

    return '<div class="card mb-3"><div class="card-body">' + header + itemsHtml + '</div></div>';
  }

  function toggleDetail(id, btn) {
    const row = document.getElementById(id);
    row.classList.toggle('d-none');
    const icon = btn.querySelector('i');
    icon.className = row.classList.contains('d-none') ? 'bi bi-chevron-down' : 'bi bi-chevron-up';
  }

  // Opens the Results Detail modal for a teacher (student index in resultsData)
  function openResultsModal(idx) {
    const md = document.getElementById('resultDetailModal');
    const title = document.getElementById('resultDetailModalTitle');
    const body  = document.getElementById('resultDetailModalBody');
    if (!md || !body) return;
    const s = resultsData && resultsData[idx];
    if (!s) { body.innerHTML = '<div class="text-muted small">No data.</div>'; }
    else {
      title.textContent = s.studentName + ' — ' + s.studentNumber;
      body.innerHTML = buildResultsDetailHtml(s);
    }
    new bootstrap.Modal(md).show();
  }

  // Opens the Results Detail modal for the currently-signed student
  async function openMyResultModal() {
    try {
      const r = await call('getMySubmissionStatusGrouped');
      if (!r || !r.success) { toast(r && r.error ? r.error : 'Failed to load details', 'danger'); return; }
      const md = document.getElementById('resultDetailModal');
      const title = document.getElementById('resultDetailModalTitle');
      const body  = document.getElementById('resultDetailModalBody');
      title.textContent = r.studentName || 'My Details';
      // buildResultsDetailHtml expects the same shape as getResultsGrouped's per-student object —
      // getMySubmissionStatusGrouped returns the activity object; adapt shape minimally.
      const pseudo = { studentNumber: r.studentNumber, studentName: r.studentName, sections: r.sections || [] };
      body.innerHTML = buildResultsDetailHtml(pseudo);
      new bootstrap.Modal(md).show();
    } catch (e) {
      toast('Failed to load details: ' + e.message, 'danger');
    }
  }

  function filterResults(q) {
    const lq = q.toLowerCase();
    const filtered = q
      ? resultsData.filter(s =>
          String(s.studentNumber).includes(q) ||
          (s.studentName || '').toLowerCase().includes(lq))
      : resultsData;
    renderResults(filtered);
  }

  /**
   * MODIFIED — Phase 7. CSV export now includes a Score/Max column pair per
   * section, not just the final activity total (acceptance criteria: "CSV
   * export includes per-section breakdown, not just the final total.").
   * Section columns follow the same order for every student —
   * buildActivityProgress_() always iterates enabled sections sorted by
   * SortOrder, so every student's `sections` array is in identical order —
   * so the first student's list is a safe, correct canonical column order.
   */
  function exportResults() {
    if (!resultsData.length) { toast('No data to export.', 'warning'); return; }

    const sectionNames = (resultsData[0].sections || []).map(sec => sec.sectionName);

    const header = ['Student Number', 'Student Name']
      .concat(sectionNames.map(n => n + ' Score'))
      .concat(sectionNames.map(n => n + ' Max'))
      .concat(['Activity Score', 'Activity Max', 'Percentage (%)', 'Last Submitted']);

    const rows = resultsData.map(s => {
      const bySection = {};
      (s.sections || []).forEach(sec => { bySection[sec.sectionName] = sec; });
      const scoreCells = sectionNames.map(n => bySection[n] ? bySection[n].sectionScore : '');
      const maxCells   = sectionNames.map(n => bySection[n] ? bySection[n].sectionMax   : '');
      return [s.studentNumber, s.studentName]
        .concat(scoreCells)
        .concat(maxCells)
        .concat([s.activityScore, s.activityMax, s.percentage, s.lastSubmitted]);
    });

    const csv = [header, ...rows]
      .map(r => r.map(v => '"' + String(v).replace(/"/g,'""') + '"').join(','))
      .join('\r\n');
    const uri = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    const a   = document.createElement('a');
    a.href    = uri;
    a.download = 'quiz-results-' + new Date().toISOString().split('T')[0] + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('CSV downloaded.', 'success');
  }

  function confirmClearSubmissions() {
    showConfirm(
      'Clear All Submissions',
      'This will permanently delete every student\'s submitted-file log and slot locks. This action cannot be undone. Are you sure?',
      async () => {
        try {
          showLoading(true, 'Clearing submissions…');
          const r = await call('clearSubmissions');
          showLoading(false);
          if (r.success) {
            resultsData = [];
            renderResults([]);
            toast('All submissions cleared.', 'info');
          } else {
            toast(r.error, 'danger');
          }
        } catch (e) {
          showLoading(false);
          toast(e.message, 'danger');
        }
      }
    );
  }

  // ════════════════════════════════════════════════════════
  //  SETTINGS  (teacher only)
  // ════════════════════════════════════════════════════════
  async function loadSettings() {
    if (!isTeacher) return;
    try {
      showLoading(true, 'Loading settings…');
      const [settings, aliasResult, usersResult] = await Promise.all([
        call('getSettings'),
        call('getImageTypeAliases'),
        call('getUsers')
      ]);
      showLoading(false);

      document.getElementById('settingAppTitle').value = (settings && settings.appTitle) || 'Sectioned Image Metadata Grader';
      document.getElementById('settingDimensionTolerance').value =
        (settings && settings.dimensionTolerancePx != null) ? settings.dimensionTolerancePx : '0';

      // pHash-feature Phase 7 — same Settings sheet, same page, same Save
      // button as everything above: read live every time this page loads,
      // never cached (Guiding Principle #6).
      document.getElementById('settingPHashThreshold').value =
        (settings && settings.pHashThreshold != null) ? settings.pHashThreshold : '8';
      const pHashMode = String((settings && settings.pHashScoringMode) || 'LINEAR').toUpperCase();
      document.getElementById('settingPHashScoringMode').value = (pHashMode === 'TIER') ? 'TIER' : 'LINEAR';
      let pHashBreakpoints = [];
      try {
        pHashBreakpoints = JSON.parse((settings && settings.pHashTierBreakpoints) || '[]');
      } catch (e) {
        pHashBreakpoints = [];
      }
      renderPHashTierTable(Array.isArray(pHashBreakpoints) ? pHashBreakpoints : []);
      updatePHashModeVisibility();

      const aliases = JSON.parse((aliasResult && aliasResult.dataJson) || '[]');
      renderAliasesTable(aliases);

      const users = JSON.parse((usersResult && usersResult.dataJson) || '[]');
      renderUsersTable(users);
    } catch (e) {
      showLoading(false);
      toast('Error loading settings: ' + (e && e.message ? e.message : String(e)), 'danger');
    }
  }

  async function saveSettings() {
    const thresholdRaw = document.getElementById('settingPHashThreshold').value;
    const obj = {
      appTitle:             document.getElementById('settingAppTitle').value.trim() || 'Sectioned Image Metadata Grader',
      dimensionTolerancePx: document.getElementById('settingDimensionTolerance').value || '0',
      // pHash-feature Phase 7 — read live by Code.gs' scorePHash_() on
      // every submission, so a change here takes effect immediately for
      // the next upload, with no redeploy (PRD Phase 7 acceptance check).
      pHashThreshold:       thresholdRaw !== '' ? thresholdRaw : '8',
      pHashScoringMode:     document.getElementById('settingPHashScoringMode').value || 'LINEAR',
      pHashTierBreakpoints: collectPHashTierBreakpointsJson_()
    };
    try {
      showLoading(true, 'Saving…');
      const r = await call('saveSettings', obj);
      showLoading(false);
      if (r.success) toast('Settings saved successfully!', 'success');
      else toast(r.error, 'danger');
    } catch (e) {
      showLoading(false);
      toast('Save error: ' + e.message, 'danger');
    }
  }

  // ── Perceptual Hash Settings (threshold / mode / tier breakpoints) ──
  // pHash-feature Phase 7. No separate save button — these ride along
  // with the rest of the Settings page's single "Save Settings" action
  // above, matching how Dimension Tolerance already works, since they're
  // all just rows on the same Settings sheet.

  /** Shows/hides the Tier Breakpoints editor based on the selected mode —
   *  Tier's own breakpoints are meaningless (and hidden) while Linear mode
   *  is selected, and vice versa. */
  function updatePHashModeVisibility() {
    const mode = document.getElementById('settingPHashScoringMode').value;
    const wrap = document.getElementById('pHashTierEditorWrap');
    if (wrap) wrap.classList.toggle('d-none', mode !== 'TIER');
  }

  function pHashTierRowHtml(maxDistance, score, key) {
    return '<tr id="phtier-' + key + '">' +
      '<td><input type="number" class="form-control form-control-sm phtier-distance" ' +
      'min="0" max="64" step="1" placeholder="e.g. 2" ' +
      'value="' + esc(maxDistance == null ? '' : maxDistance) + '"></td>' +
      '<td><input type="number" class="form-control form-control-sm phtier-score" ' +
      'min="0" max="1" step="0.05" placeholder="e.g. 1.0" ' +
      'value="' + esc(score == null ? '' : score) + '"></td>' +
      '<td><button class="btn btn-sm btn-outline-danger" onclick="this.closest(\'tr\').remove()">' +
      '<i class="bi bi-trash"></i></button></td>' +
      '</tr>';
  }

  function renderPHashTierTable(breakpoints) {
    const tbody = document.getElementById('pHashTierBody');
    if (!tbody) return;
    tbody.innerHTML = (breakpoints || [])
      .map((b, i) => pHashTierRowHtml(b.maxDistance, b.score, i))
      .join('');
  }

  function addPHashTierRow() {
    const tbody = document.getElementById('pHashTierBody');
    if (!tbody) return;
    tbody.insertAdjacentHTML('beforeend', pHashTierRowHtml(null, null, 'new-' + Date.now()));
    const rows = tbody.querySelectorAll('tr');
    const last = rows[rows.length - 1];
    last.querySelector('.phtier-distance').focus();
  }

  /**
   * Reads the Tier Breakpoints editor's current rows into a JSON string,
   * for saveSettings() to write to Settings.pHashTierBreakpoints. Rows
   * missing either field, or with a non-numeric entry, are silently
   * dropped rather than blocking the whole Settings save. Scores are
   * clamped to [0, 1] — matches the [0,1] contribution every other
   * attribute's binary score already implies. Sorted ascending by
   * Max Distance purely for a tidy save; scorePHashTier_() (Code.gs)
   * sorts again itself regardless, so save-time order was never
   * load-bearing for correctness.
   */
  function collectPHashTierBreakpointsJson_() {
    const rows = document.querySelectorAll('#pHashTierBody tr');
    const list = [];
    rows.forEach(row => {
      const d = row.querySelector('.phtier-distance');
      const s = row.querySelector('.phtier-score');
      const maxDistance = d && d.value !== '' ? Number(d.value) : NaN;
      const score       = s && s.value !== '' ? Number(s.value) : NaN;
      if (!isNaN(maxDistance) && !isNaN(score)) {
        list.push({ maxDistance: maxDistance, score: Math.max(0, Math.min(1, score)) });
      }
    });
    list.sort((a, b) => a.maxDistance - b.maxDistance);
    return JSON.stringify(list);
  }

  // ── Aliases Table ─────────────────────────────────────────
  function renderAliasesTable(aliases) {
    document.getElementById('aliasesBody').innerHTML =
      aliases.map((a, i) => aliasRowHtml(a.alias, a.canonical, i)).join('');
  }

  function aliasRowHtml(alias, canonical, key) {
    return '<tr id="alias-' + key + '">' +
      '<td><input type="text" class="form-control form-control-sm alias-input" ' +
      'value="' + esc(alias) + '" placeholder="JPG" style="text-transform:uppercase"></td>' +
      '<td><input type="text" class="form-control form-control-sm alias-canonical" ' +
      'value="' + esc(canonical) + '" placeholder="JPEG" style="text-transform:uppercase"></td>' +
      '<td><button class="btn btn-sm btn-outline-danger" onclick="this.closest(\'tr\').remove()">' +
      '<i class="bi bi-trash"></i></button></td>' +
      '</tr>';
  }

  function addAliasRow() {
    const tbody = document.getElementById('aliasesBody');
    tbody.insertAdjacentHTML('beforeend', aliasRowHtml('', '', 'new-' + Date.now()));
    const rows  = tbody.querySelectorAll('tr');
    const last  = rows[rows.length - 1];
    last.querySelector('.alias-input').focus();
  }

  async function saveAliases() {
    const rows = document.querySelectorAll('#aliasesBody tr');
    const aliases = [];
    rows.forEach(row => {
      const alias     = (row.querySelector('.alias-input')?.value || '').trim().toUpperCase();
      const canonical = (row.querySelector('.alias-canonical')?.value || '').trim().toUpperCase();
      if (alias && canonical) aliases.push({ alias, canonical });
    });

    try {
      showLoading(true, 'Saving aliases…');
      const r = await call('saveImageTypeAliases', aliases);
      showLoading(false);
      if (r.success) toast('Image type aliases saved!', 'success');
      else toast(r.error, 'danger');
    } catch (e) {
      showLoading(false);
      toast(e.message, 'danger');
    }
  }

  // ── Teacher Accounts Table ──────────────────────────────────
  function renderUsersTable(users) {
    document.getElementById('usersBody').innerHTML =
      users.map((u, i) => userRowHtml(u.email, u.fullName, i)).join('');
  }

  function userRowHtml(email, fullName, key) {
    return '<tr id="user-' + key + '">' +
      '<td><input type="email" class="form-control form-control-sm user-email" ' +
      'value="' + esc(email) + '" placeholder="name@school.edu"></td>' +
      '<td><input type="text" class="form-control form-control-sm user-fullname" ' +
      'value="' + esc(fullName) + '" placeholder="Full Name"></td>' +
      '<td><button class="btn btn-sm btn-outline-danger" onclick="this.closest(\'tr\').remove()">' +
      '<i class="bi bi-trash"></i></button></td>' +
      '</tr>';
  }

  function addUserRow() {
    const tbody = document.getElementById('usersBody');
    tbody.insertAdjacentHTML('beforeend', userRowHtml('', '', 'new-' + Date.now()));
    const rows  = tbody.querySelectorAll('tr');
    const last  = rows[rows.length - 1];
    last.querySelector('.user-email').focus();
  }

  async function saveUsers() {
    const rows = document.querySelectorAll('#usersBody tr');
    const users = [];
    rows.forEach(row => {
      const email    = (row.querySelector('.user-email')?.value || '').trim().toLowerCase();
      const fullName = (row.querySelector('.user-fullname')?.value || '').trim();
      if (email) users.push({ email, fullName });
    });

    if (!users.length) {
      toast('Add at least one teacher email or you may lose access to this page.', 'warning');
    }

    try {
      showLoading(true, 'Saving teacher accounts…');
      const r = await call('saveUsers', users);
      showLoading(false);
      if (r.success) {
        toast('Teacher accounts saved!', 'success');
        loadSettings();
      } else {
        toast(r.error, 'danger');
      }
    } catch (e) {
      showLoading(false);
      toast(e.message, 'danger');
    }
  }

  // ════════════════════════════════════════════════════════
  //  BATCH GRADE  (teacher only) — one image set per student
  // ════════════════════════════════════════════════════════
  function addBatchStudentBlock() {
    const wrap = document.getElementById('batchStudentBlocks');
    if (!wrap) return;

    const id = 'batch-' + (++batchBlockSeq);
    batchBlocks[id] = { studentNumber: '', records: [] };

    const html =
      '<div class="border rounded-3 p-3 mb-3" id="' + id + '">' +
        '<div class="d-flex align-items-center gap-2 mb-2">' +
          '<input type="text" class="form-control form-control-sm" style="max-width:220px" ' +
            'placeholder="Student number" oninput="App.updateBatchStudentNumber(\'' + id + '\', this.value)">' +
          '<span class="small text-muted flex-grow-1" id="' + id + '-summary">no files selected</span>' +
          '<button class="btn btn-sm btn-outline-danger" onclick="App.removeBatchStudentBlock(\'' + id + '\')">' +
            '<i class="bi bi-x-lg"></i></button>' +
        '</div>' +
        // Image drop zone
        '<div class="drop-zone py-3" id="' + id + '-dz" onclick="document.getElementById(\'' + id + '-input\').click()" ' +
          'ondragover="event.preventDefault();this.classList.add(\'dragover\')" ' +
          'ondragleave="this.classList.remove(\'dragover\')" ' +
          'ondrop="event.preventDefault();this.classList.remove(\'dragover\');App.handleBatchBlockFileSelect(\'' + id + '\', event.dataTransfer.files)">' +
          '<i class="bi bi-images drop-zone-icon" style="font-size:1.8rem;margin-bottom:6px"></i>' +
          '<div class="small text-muted">Drop this student\'s files here, or click to browse</div>' +
        '</div>' +
        '<input type="file" id="' + id + '-input" class="d-none" accept="image/*,.tif,.tiff,.pdf" multiple ' +
          'onchange="App.handleBatchBlockFileSelect(\'' + id + '\', this.files)">' +
        // Manifest drop zone (hidden by default)
        '<div class="drop-zone py-3 d-none" id="' + id + '-manifest-dz" onclick="document.getElementById(\'' + id + '-manifest-input\').click()">' +
          '<i class="bi bi-file-earmark-text drop-zone-icon" style="font-size:1.8rem;margin-bottom:6px"></i>' +
          '<div class="small text-muted">Drop or select a .txt manifest for this student</div>' +
        '</div>' +
        '<input type="file" id="' + id + '-manifest-input" class="d-none" accept=".txt" ' +
          'onchange="App.handleBatchBlockManifestSelect(\'' + id + '\', this.files)">' +
      '</div>';
    wrap.insertAdjacentHTML('beforeend', html);
    // Ensure the newly-added block shows the correct drop zone for the
    // currently selected section (IMAGE vs MANIFEST).
    try { applyBatchBlocksSectionType(); } catch (e) { /* ignore */ }
  }

  function removeBatchStudentBlock(id) {
    delete batchBlocks[id];
    const el = document.getElementById(id);
    if (el) el.remove();
    updateBatchSubmitState();
  }

  function updateBatchStudentNumber(id, value) {
    if (batchBlocks[id]) batchBlocks[id].studentNumber = value.trim();
    updateBatchSubmitState();
  }

  async function handleBatchBlockFileSelect(id, fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || !batchBlocks[id]) return;

    const summary = document.getElementById(id + '-summary');
    if (summary) summary.textContent = 'processing ' + files.length + ' file(s)…';

    const newRecords = await ImageProcessor.processFiles(files);
    batchBlocks[id].records = batchBlocks[id].records.concat(newRecords);

    if (summary) {
      const validCount = batchBlocks[id].records.filter(r => r.valid).length;
      summary.textContent = batchBlocks[id].records.length + ' file(s) staged (' + validCount + ' valid)';
    }
    updateBatchSubmitState();
  }

  async function handleBatchBlockManifestSelect(id, fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || !batchBlocks[id]) return;
    const file = files[0];
    const summary = document.getElementById(id + '-summary');
    if (summary) summary.textContent = 'processing manifest…';
    try {
      const text = await file.text();
      const parsed = ManifestProcessor.parseManifest(text);
      const mapped = parsed.map(p => ({
        fileName: (p.baseName && p.declaredExt) ? (p.baseName + '.' + p.declaredExt) : p.baseName,
        baseName: p.baseName || '',
        declaredExt: p.declaredExt || '',
        detectedExt: p.declaredExt || 'UNKNOWN',
        width: p.width,
        height: p.height,
        sizeKb: p.sizeKb,
        aspectRatio: p.aspectRatio || '',
        orientation: p.orientation || '',
        dimensionNote: '',
        perceptualHash: null,
        valid: !!p.valid,
        error: p.error || null,
        sourceType: 'MANIFEST'
      }));
      batchBlocks[id].records = batchBlocks[id].records.concat(mapped);
      if (summary) {
        const validCount = batchBlocks[id].records.filter(r => r.valid).length;
        summary.textContent = batchBlocks[id].records.length + ' entry(s) staged (' + validCount + ' valid)';
      }
      updateBatchSubmitState();
    } catch (e) {
      if (summary) summary.textContent = 'manifest read failed';
      toast('Failed to read manifest file: ' + e.message, 'danger');
    }
  }

  function updateBatchSubmitState() {
    const btn = document.getElementById('btnBatchSubmit');
    if (!btn) return;
    // NEW — Phase 6: batch grading is scoped to the same currently-selected
    // section as the self-service flow above (submitFileBatch now always
    // requires a sectionId) — can't submit until a section is chosen.
    const ready = !!selectedSectionId && Object.values(batchBlocks).some(b =>
      b.studentNumber && b.records.some(r => r.valid));
    btn.disabled = !ready;
  }

  // Apply the current selected section's type to all existing batch blocks
  // so each block shows the correct drop zone (image vs manifest).
  function applyBatchBlocksSectionType() {
    const section = sectionsPublicData.find(s => s.sectionId === selectedSectionId);
    const isManifest = section && section.sectionType === 'MANIFEST';
    Object.keys(batchBlocks).forEach(id => {
      const dz = document.getElementById(id + '-dz');
      const input = document.getElementById(id + '-input');
      const mdz = document.getElementById(id + '-manifest-dz');
      const minput = document.getElementById(id + '-manifest-input');
      if (isManifest) {
        if (dz) dz.classList.add('d-none');
        if (input) input.classList.add('d-none');
        if (mdz) mdz.classList.remove('d-none');
        if (minput) minput.classList.remove('d-none');
      } else {
        if (dz) dz.classList.remove('d-none');
        if (input) input.classList.remove('d-none');
        if (mdz) mdz.classList.add('d-none');
        if (minput) minput.classList.add('d-none');
      }
    });
  }

  async function submitBatch() {
    if (!selectedSectionId) { toast('Select a section above first.', 'warning'); return; }
    const entries = Object.entries(batchBlocks).filter(([, b]) =>
      b.studentNumber && b.records.some(r => r.valid));
    if (!entries.length) return;

    const btn = document.getElementById('btnBatchSubmit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Grading…';

    const progressWrap = document.getElementById('batchProgress');
    const progressBar  = document.getElementById('batchProgressBar');
    const progressLbl  = document.getElementById('batchProgressCount');
    progressWrap.classList.remove('d-none');

    const results = [];
    const total   = entries.length;

    // Sequential on purpose: submitFileBatch() reads-then-writes slot locks
    // per student. Firing these in parallel could race two students' first
    // reads against each other's writes.
    for (let i = 0; i < total; i++) {
      const [, block] = entries[i];
      progressLbl.textContent = (i + 1) + ' / ' + total + '  —  student #' + block.studentNumber;
      progressBar.style.width = Math.round((i / total) * 100) + '%';

      try {
        const validRecords = block.records.filter(r => r.valid);
        // Software Provenance Gate — Phase 3: same wrap as self-service
        // submit, per student block, so Batch Grade produces identical
        // gate behavior.
        const section = sectionsPublicData.find(s => s.sectionId === selectedSectionId);
        const payloadRecords = await attachSoftwareCheck_(validRecords, section);
        const result = await call('submitFileBatch', selectedSectionId, block.studentNumber, payloadRecords);
        results.push({ studentNumber: block.studentNumber, result });
      } catch (e) {
        results.push({ studentNumber: block.studentNumber, result: { success: false, error: (e && e.message) || String(e) } });
      }

      progressBar.style.width = Math.round(((i + 1) / total) * 100) + '%';
    }

    progressLbl.textContent = 'Done — ' + total + ' / ' + total;
    renderBatchResults(results);

    // Reset to a single empty block so re-clicking can't re-submit the same files.
    Object.keys(batchBlocks).forEach(id => {
      delete batchBlocks[id];
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    addBatchStudentBlock();

    btn.disabled  = true;
    btn.innerHTML = '<i class="bi bi-send-fill me-2"></i>Grade All Students';

    resultsData = [];
  }

  function renderBatchResults(results) {
    const wrap = document.getElementById('batchResults');
    wrap.classList.remove('d-none');

    const rows = results.map(({ studentNumber, result }) => {
      if (!result.success) {
        return '<tr class="table-danger">' +
          '<td><code>' + esc(studentNumber) + '</code></td>' +
          '<td colspan="3" class="small"><i class="bi bi-x-circle me-1"></i>' + esc(result.error || 'Failed') + '</td>' +
          '</tr>';
      }
      // NEW — Phase 6: the per-request progress object is now the SECTION
      // that was just graded (sectionProgress), not a flat/global total —
      // see submitFileBatch()'s response shape (Phase 5).
      const progress = result.sectionProgress;
      const correctFiles = (result.results || []).filter(r => r.result === 'CORRECT').length;
      return '<tr>' +
        '<td><code>' + esc(studentNumber) + '</code> — ' + esc(result.studentName) + '</td>' +
        '<td>' + correctFiles + ' / ' + (result.results || []).length + ' files correct</td>' +
        '<td><strong>' + progress.sectionScore + '</strong>/<span class="text-muted">' + progress.sectionMax + '</span></td>' +
        '<td>' + scoreBadge(progress.percentage) + '</td>' +
        '</tr>';
    }).join('');

    const okCount = results.filter(r => r.result.success).length;

    wrap.innerHTML =
      '<h6 class="fw-semibold mb-2"><i class="bi bi-list-check me-1"></i>Batch Results ' +
      '<span class="badge bg-primary rounded-pill ms-1">' + okCount + '/' + results.length + ' graded</span></h6>' +
      '<div class="table-responsive border rounded-3">' +
      '<table class="table table-sm mb-0"><thead class="table-light"><tr>' +
      '<th>Student</th><th>This Batch</th><th>Section Score</th><th>Completion</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';

    toast(okCount + ' of ' + results.length + ' student(s) graded successfully.',
      okCount === results.length ? 'success' : 'warning');
  }

  // ── Public API ────────────────────────────────────────────
  return {
    init,
    showPage,
    loadDashboard,
    // Sections
    addSectionRow,
    removeSectionRow,
    updateSectionField,
    updateSectionPointValue,
    saveSections,
    selectSection,
    // Answer Key
    loadAnswerKey,
    filterAnswerKey,
    confirmClearAnswerKey,
    downloadAnswerKey,
    showManifestExample,
    copyManifestExample,
    downloadManifestExample,
    // Answer Key — Upload Model Answers (Phase 3, pHash feature)
    handleAkFileSelect,
    submitAnswerKeyUpload,
    // Upload — section selector (Phase 6)
    loadUploadSections,
    selectUploadSection,
    // Upload
    handleFileSelect,
    handleManifestFileSelect,
    submitAnswers,
    checkMyResult,
    openMyResultModal,
    openItemDetailModal,
    // Batch Grade
    addBatchStudentBlock,
    removeBatchStudentBlock,
    updateBatchStudentNumber,
    handleBatchBlockFileSelect,
    handleBatchBlockManifestSelect,
    applyBatchBlocksSectionType,
    submitBatch,
    openResultsModal,
    // Results
    loadResults,
    filterResults,
    exportResults,
    confirmClearSubmissions,
    toggleDetail,
    // Settings
    loadSettings,
    saveSettings,
    updatePHashModeVisibility,
    addPHashTierRow,
    addAliasRow,
    saveAliases,
    addUserRow,
    saveUsers
  };
})();

// Bootstrap on DOM ready
document.addEventListener('DOMContentLoaded', App.init);
