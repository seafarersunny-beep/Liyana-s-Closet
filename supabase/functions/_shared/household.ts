import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'

export const cors = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

// A client that acts as the signed-in parent, so every read goes through RLS.
export async function asMember(req: Request): Promise<{ db: SupabaseClient; userId: string; householdId: string; name: string }> {
  const auth = req.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) throw new HttpError(401, 'Sign in first')
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  })
  const { data: userData, error } = await db.auth.getUser(auth.slice(7))
  if (error || !userData.user) throw new HttpError(401, 'Your session has expired; sign in again')
  const { data: m } = await db.from('household_members').select('household_id, display_name').eq('user_id', userData.user.id).maybeSingle()
  if (!m) throw new HttpError(403, 'Join or create a household first')
  return { db, userId: userData.user.id, householdId: m.household_id, name: m.display_name }
}

export function serviceClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
    try {
      return await fn(req)
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      console.error(e)
      return json({ error: 'Something went wrong on the server' }, 500)
    }
  }
}
