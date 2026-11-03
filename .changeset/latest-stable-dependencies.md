---
"supaschema": patch
---

Update runtime dependencies to their latest stable releases. With `pgsql-deparser` 18.4, `normalize: "deparse"` renders a sequence increment change as `SET INCREMENT 5` instead of `SET INCREMENT BY 5`; both forms parse to the same PostgreSQL tree.
