---
"supaschema": minor
---

Add `supaschema rebaseline` and the typed `rebaselineMigrations` API for dry-run-first whole-history replacement. The workflow inventories discarded migration-only operations, optionally retains exact reviewed operational migrations, verifies a new declarative baseline before writing, restores the previous files on replacement failure, refreshes generated contracts, and stages migration deletions with the closure without mutating target databases.
