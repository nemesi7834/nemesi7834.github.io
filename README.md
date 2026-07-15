# Product Day dashboard

A public, static snapshot of SX Operations product metrics.

## Local preview

Open `index.html` in a browser, or run a local static-file server from this directory.

## Data

The initial dashboard reads `data/metrics.json`, a checked-in snapshot of the SX Operations Metrics page. It contains no credentials, source-system links, or raw database access.

The next phase will move snapshots into Supabase and add a Codex-driven refresh process.

