# Product Day dashboard

A password-protected SX Operations dashboard, hosted on GitHub Pages.

## Local preview

Open `index.html` in a browser, or run a local static-file server from this directory.

## Data

The browser reads its latest snapshot from Supabase after a password-only sign-in. GitHub Pages contains no protected metric payload or worker credentials.

## Local worker

The local worker polls Supabase once a minute. When the authenticated dashboard requests an update, it refreshes the source metrics page, runs the Confluence SVG refresh, and writes a new protected snapshot.

1. Run `supabase/schema.sql` in the Supabase SQL Editor.
2. Copy `worker/product-day-worker.env.example` to `worker/product-day-worker.env` and add the Supabase secret key locally.
3. Run `node worker/product-day-worker.js --seed` once to create the initial snapshot; normal worker runs process queued requests.
4. Copy `worker/com.productday.refresh-worker.plist` into `~/Library/LaunchAgents/` and load it with `launchctl` to poll automatically.
