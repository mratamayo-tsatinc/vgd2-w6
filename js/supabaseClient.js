/* ============================================================
   IMAGE QUIZ GRADER — js/supabaseClient.js
   ============================================================

   Creates the single Supabase client the whole app shares (used by
   js/app.js). Loaded as a plain classic <script> — not an ES module —
   on purpose: every other script in this app (perceptualHash.js,
   imageProcessor.js, manifestProcessor.js, app.js) is a classic script
   too, so this file shares a global with them the same simple way,
   with no bundler and no import/export wiring to keep in sync.

   The UMD build of @supabase/supabase-js (loaded via a <script> tag in
   index.html, just above this file) attaches itself to `window.supabase`
   — a library namespace object exposing `.createClient`. We create THIS
   app's one client instance from that and expose it as `window.sbClient`
   — a deliberately different name, so the app's single configured client
   is never confused with the library namespace object itself.

   Both values below (Project URL and the anon/publishable key) are
   PUBLIC, non-secret values — safe to commit to a public repo and ship
   in this file exactly as-is (see PROJECT_BRIEF §3 / §11.10). They only
   identify *which* Supabase project a request is for; what a request is
   actually allowed to read or write is enforced entirely by RLS
   (deny-by-default on every sensitive table — see PROJECT_BRIEF §11.4)
   and by each Edge Function independently re-checking the caller's role
   on every call. The service_role/secret key must NEVER appear here or
   anywhere else in this static bundle — it only ever lives in Edge
   Function runtime environment variables (auto-injected by Supabase).
   ============================================================ */

(function () {
  'use strict';

  // ── Fill these in from your own project's Settings → API page ──────
  // (PROJECT_BRIEF §11.2). Replace both placeholders before deploying.
  var SUPABASE_URL      = 'https://guufuvumwzytvqxtuhzb.supabase.co' ;
  var SUPABASE_ANON_KEY = 'sb_publishable_LLWKj3g3XR1RMAt5BlyWtw_vG_IDsbz' ;

  if (typeof supabase === 'undefined' || !supabase.createClient) {
    console.error(
      'Supabase JS library did not load — check the CDN <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"> ' +
      'tag in index.html loads before js/supabaseClient.js.'
    );
    return;
  }

  if (SUPABASE_URL.indexOf('YOUR-PROJECT-REF') !== -1 || SUPABASE_ANON_KEY.indexOf('YOUR-ANON-PUBLIC-KEY') !== -1) {
    console.warn(
      'js/supabaseClient.js still has placeholder Supabase credentials — ' +
      'sign-in and every Edge Function call will fail until you fill in ' +
      'SUPABASE_URL and SUPABASE_ANON_KEY from your project\'s Settings → API page.'
    );
  }

  // The single shared client instance — auth, and (if ever needed later)
  // direct RLS-governed reads, all go through this one object.
  window.sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // The single Edge Function that holds all of this app's server logic
  // (PROJECT_BRIEF §11.6's router skeleton — one function, routed
  // internally by `action`). js/app.js's call() POSTs { action, payload }
  // here with the current session's access token as a bearer header.
  window.SUPABASE_FUNCTIONS_URL = SUPABASE_URL + '/functions/v1/api';
})();
