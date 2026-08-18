# Sectioned Image Metadata Grader — Supabase Migration

Migration of the Google Apps Script + Sheets "Sectioned Image Metadata
Grader" to GitHub Pages (static front end) + Supabase (Postgres + Auth +
Edge Functions). Full spec: see `PROJECT_BRIEF_migration_to_supabase.md`
in the project files.

## Status: Phase 0 (Environment setup) — scaffold ready

This repo currently contains only the Phase 0 scaffold: folder structure,
config templates, and a placeholder page. No schema, no Edge Functions,
no ported front-end logic yet — that's Phases 1–3.

**➡ Start here: [`PHASE0_CHECKLIST.md`](./PHASE0_CHECKLIST.md)**

That checklist walks through the manual account-setup steps (creating the
Supabase project, configuring Google OAuth, wiring up GitHub Pages) that
only you can do, since they require your own logins. Once those boxes are
checked, the repo is ready for Phase 1 (schema + data migration, §4 and
§11.4 of the brief).

## Repo layout

```
index.html                   placeholder — real UI ported in Phase 3
css/                          styles.css goes here (Phase 3, §8.1)
js/
  supabaseClient.js           Supabase client — fill in URL/anon key (Phase 0)
  app.js                      ported from JavaScript.html's App IIFE (Phase 3)
  imageProcessor.js           ported verbatim, unchanged (Phase 3)
  perceptualHash.js           ported verbatim, unchanged (Phase 3)
  manifestProcessor.js        ported verbatim, unchanged (Phase 3)
supabase/
  config.toml                 CLI config template (only needed for CLI workflow)
  migrations/                 SQL schema (Phase 1, §4 of the brief)
  functions/api/              Edge Function router (Phase 2, §7 and §11.6)
.env.example                  copy to .env.local for CLI/local testing only
```

## Next steps

1. Work through `PHASE0_CHECKLIST.md`.
2. Once checked off, apply the schema from brief §4 (SQL Editor, dashboard
   path — see brief §11.4).
3. Scaffold the Edge Function router from brief §11.6 into
   `supabase/functions/api/index.ts` and start porting `Code.gs` actions
   per the table in brief §7.
