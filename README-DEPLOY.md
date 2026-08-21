# Deploying the Onboarding Buddy live demo

This turns your portfolio page's chat widget from static screenshots into
a real, working endpoint — without ever exposing your API keys publicly.

## What's in this folder

```
proxy/
├── api/
│   └── ask.js          <- the serverless function (the "proxy")
├── package.json
└── README-DEPLOY.md    <- this file
```

You'll also drop your `onboarding-buddy-case-file.html` into this same
folder (rename it to `index.html`) so Vercel serves the page and the
API function together, from the same domain — no CORS headaches.

## 1. Prerequisites

- A free [Vercel](https://vercel.com) account
- Node.js installed locally (to run the Vercel CLI)
- Your Gemini API key
- Your AstraDB details, from the AstraDB dashboard for your database:
  - **API Endpoint** (Database → Overview → "API Endpoint")
  - **Application Token** (Database → Settings → Application Tokens → generate one)
  - **Namespace** — usually `default_keyspace` unless you renamed it
  - **Collection name** — e.g. `hr_documents`

## 2. Verify one thing before deploying

Open your AstraDB collection in the **Data Explorer** tab and check the
actual field name holding your chunk text. Based on what you showed me
earlier it's `text`, but confirm it — `ask.js` defaults to `text` via the
`CONTENT_FIELD` env var, so you only need to change this if yours differs.

## 3. Set up the project folder

```bash
mkdir onboarding-buddy-live
cd onboarding-buddy-live
# copy in: api/ask.js, package.json from this folder
# copy in: your onboarding-buddy-case-file.html, renamed to index.html
```

## 4. Install the Vercel CLI and log in

```bash
npm install -g vercel
vercel login
```

## 5. Set your environment variables

From inside the project folder:

```bash
vercel env add GOOGLE_API_KEY
vercel env add ASTRA_DB_API_ENDPOINT
vercel env add ASTRA_DB_APPLICATION_TOKEN
vercel env add ASTRA_DB_NAMESPACE
vercel env add ASTRA_DB_COLLECTION
```

For each, paste the value when prompted and select all three environments
(Production, Preview, Development) unless you have a reason not to.

Optional, only if your setup differs from the defaults:
```bash
vercel env add CONTENT_FIELD            # default: text
vercel env add GEMINI_EMBED_MODEL       # default: gemini-embedding-001
vercel env add GEMINI_CONDENSE_MODEL    # default: gemini-2.5-flash
vercel env add GEMINI_ANSWER_MODEL      # default: gemini-2.5-flash-lite
```

> Set `GEMINI_CONDENSE_MODEL` / `GEMINI_ANSWER_MODEL` to match whatever
> model names you actually have API access to — your Langflow flow used
> `gemini-3.5-flash` and `gemini-3-flash-lite`; use those exact strings
> if that's what's available on your API key.

**Never** put these values directly in `ask.js` or in the HTML — only in
Vercel's environment variable store.

## 6. Deploy

```bash
vercel --prod
```

Vercel will give you a live URL like `https://onboarding-buddy-live.vercel.app`.
The page and the `/api/ask` function are now both served from there.

## 7. Test before sharing the link

```bash
curl -X POST https://your-deployment.vercel.app/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "Berapa lama jam kerja standar di perusahaan ini?"}'
```

You should get back JSON with an `answer` field. If you get a 500 error
mentioning the database, AstraDB is likely hibernated — wait a minute and
retry once, since the first request wakes it up.

## Known limitations, on purpose

- **Rate limiting is best-effort.** It's a simple in-memory counter per
  serverless instance, not a hard global limit. Fine for a portfolio link
  shared with a handful of recruiters; not meant to survive going viral.
- **Cold starts.** The first request after a period of no traffic will be
  slower — the function has to spin up, and AstraDB may need to wake up too.
  The widget shows a "this may take a moment" message for exactly this reason.
- **No conversation persistence across page reloads.** History lives in
  the browser tab only, matching how you tested it in Langflow's Playground.
