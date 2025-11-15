import { createClient } from '@supabase/supabase-js'

// Use environment variables for Supabase configuration.
// Set these in your PowerShell session or in a .env file and in your hosting provider (Vercel) settings:
// - SUPABASE_URL
// - SUPABASE_SERVICE_KEY (use service_role on server side)

const supabaseUrl = process.env.SUPABASE_URL || ''
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || ''

let supabase

// create a reusable stub used when Supabase is not configured or client creation fails
const stubResponse = async () => ({ data: null, error: new Error('Supabase not configured (SUPABASE_URL/SUPABASE_SERVICE_KEY missing or invalid)') })
const stubChain = {
  select: stubResponse,
  insert: stubResponse,
  update: stubResponse,
  delete: stubResponse,
  upsert: stubResponse,
  maybeSingle: stubResponse,
  single: stubResponse,
  eq: function() { return this },
  order: function() { return this },
  range: stubResponse,
  then: () => Promise.resolve(stubResponse()),
}

const supabaseStub = {
  from: () => ({
    select: function() { return stubChain },
    insert: stubResponse,
    update: stubResponse,
    delete: stubResponse,
    upsert: stubResponse,
    maybeSingle: stubResponse,
    single: stubResponse,
    eq: function() { return this },
  }),
  storage: () => ({
    from: () => ({
      upload: stubResponse,
      download: stubResponse,
      remove: stubResponse,
      list: stubResponse,
    }),
  }),
  rpc: stubResponse,
  auth: {
    signIn: stubResponse,
    signUp: stubResponse,
    signOut: stubResponse,
    user: () => null,
  },
}

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase URL or key not set in environment. Set SUPABASE_URL and SUPABASE_SERVICE_KEY before starting the server.')
  supabase = supabaseStub
} else {
  // Try to create a real client; if the URL/key are malformed the constructor can throw — catch and fall back to stub.
  try {
    supabase = createClient(supabaseUrl, supabaseKey)

    // Warning if using a publishable key (subject to RLS)
    if (supabaseKey && supabaseKey.startsWith('sb_publishable_')) {
      console.warn('USING PUBLISHABLE SUPABASE KEY: this key is client/publishable and will be subject to RLS. Replace with the service_role key in SUPABASE_SERVICE_KEY for admin/server operations (DO NOT expose the service_role key publicly).')
    }
  } catch (e) {
    console.error('Failed to create Supabase client:', e && e.message ? e.message : e)
    supabase = supabaseStub
  }
}

export { supabase }