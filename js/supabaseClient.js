// js/supabaseClient.js
//
// Creates and exports a single Supabase client using the project's public
// URL and anon key (both safe to commit — see PHASE0_CHECKLIST.md §A).
//
// No build step required: Supabase ships an ESM build usable straight from
// a CDN, so this works as a plain <script type="module"> on GitHub Pages.
//
// >>> FILL THESE IN after completing Phase 0, section A of the checklist <<<

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co' // TODO: replace
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY'             // TODO: replace

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
