# Liyana’s Closet

A private baby registry, inventory, and spending journal for one family (Sunny and Smita), built as an installable mobile-first web app (PWA).

- **Frontend:** Vite + React + TypeScript, installable PWA with a service worker (`src/`)
- **Backend:** Supabase: Postgres with row-level security, Auth, Storage, Realtime, Edge Functions (`supabase/`)
- **AI:** Claude (Anthropic API), called only from the `ask-ai` Edge Function; the key never reaches the browser
- **Product photos:** SerpAPI Google Shopping, called only from the `product-lookup` Edge Function
- **Background alerts:** Web Push (VAPID) from the `push-dispatch` Edge Function

## How the data rules are enforced

All rules live in the database (`supabase/migrations/`), so both phones get the same behavior:

| Rule | Where |
|---|---|
| Each parent has their own login; only household members can read or write household rows | RLS policies + `is_household_member()` |
| Partner invites are single-use, expire after 7 days, stored only as SHA-256 hashes | `create_invite()`, `accept_invite()` |
| Purchases add stock and spending; usage subtracts stock only; corrections never create spending; gifts add stock without spending | `record_purchase()`, `log_usage()`, `correct_stock()`, `record_gift()` |
| Stock can never go negative and can only change through those functions | `_apply_stock()` row lock + `tg_guard_stock` trigger |
| Duplicate taps are ignored | `client_request_id` unique per household |
| Two phones logging usage at once both count; stale edits are refused instead of overwriting | relative updates under row lock; `version` checks |
| Undated purchases count in all-time only; weeks start Monday in America/New_York | `spending_summary()` |
| Unknown stock never raises an out-of-stock alert; alerts clear after restocking above the threshold | `stock_level()`, `tg_alert_state` |
| Days-remaining estimates need 3+ usage entries over 3+ days and show their basis | `usage_estimates()` |
| Archiving keeps purchase history; purchases are voided, never deleted | no delete policies |
| Photos live in a private bucket, one folder per household | storage policies |

## Running locally

Requires Node 20+ and Docker.

```bash
npm install
npm run db:start                         # local Supabase (prints URL and keys)
cp .env.example .env.local               # fill VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from the output
npm run dev                              # http://127.0.0.1:5173
```

Edge functions locally: `npx supabase functions serve --env-file supabase/functions/.env` (copy `supabase/functions/.env.example`).

### Tests

```bash
# import reconciliation against your real spreadsheet (file is not committed)
BOOK1_PATH=/path/to/Book1.xlsx npm run test:import

# full backend suite against the local stack
SUPABASE_TEST_ANON_KEY=... SUPABASE_TEST_SERVICE_KEY=... BOOK1_PATH=/path/to/Book1.xlsx npm test
```

The backend suite covers purchase/usage arithmetic (buy 120 for $35, use 8 → 112 left, $35 spent), undated spending, Monday/New York week boundaries, household privacy (another family and anonymous users see nothing), invite reuse, duplicate submissions, simultaneous usage from both phones, stale edits, photo storage isolation, low/out-of-stock alerts and their de-duplication, usage estimates, and archiving.

## Deploying

### 1. Supabase (database, logins, storage, functions)

1. Create a project at [supabase.com](https://supabase.com) (free plan is enough). Pick a US East region.
2. Link and push the schema:
   ```bash
   npx supabase login
   npx supabase link --project-ref YOUR-PROJECT-REF
   npx supabase db push
   ```
3. Deploy the functions:
   ```bash
   npx supabase functions deploy ask-ai product-lookup push-dispatch
   ```
4. Set server secrets (only the ones you want to turn on):
   ```bash
   npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...          # Ask AI
   npx supabase secrets set SERPAPI_KEY=...                       # product photo search
   npx web-push generate-vapid-keys                               # prints a key pair for push
   npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
   npx supabase secrets set APP_ORIGIN=https://your-app-address
   ```
5. In the Supabase dashboard → Authentication → URL Configuration, set **Site URL** to your app address and add it to **Redirect URLs**. Keep email confirmation on.

### 2. Host the app

Any static host works (Netlify, Vercel, Cloudflare Pages). Connect the GitHub repo and use:

- Build command: `npm run build`
- Output directory: `dist`
- Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and optionally `VITE_VAPID_PUBLIC_KEY`

The app uses hash routes (`/#/registry`), so no rewrite rules are needed. HTTPS is required for install and push; all of these hosts provide it.

### 3. First run

1. One parent opens the app, creates an account, taps **Start our family**, then **Import spreadsheet** and picks `Book1.xlsx`. Review the preview, then import.
2. Settings → Family → **Create invite link** → share it with the other parent, who creates their own account from that link.

## Costs

- Supabase free plan: $0. Free projects pause after a week with no activity; upgrade ($25/month) if that matters.
- Hosting: free tiers are enough.
- Anthropic API (Ask AI): pay per use. With `claude-opus-5-5` at $4 per million input tokens and $20 per million output tokens, a question with ~60 items of context is roughly 10–15k input tokens, about **$0.05–0.07 per question**. Set a spend limit in the Anthropic Console.
- SerpAPI: has a small free monthly allowance; paid plans beyond that. Check current pricing.
- Web Push: free.
