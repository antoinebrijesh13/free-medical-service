# Database Notes

## Tokens table columns

The `tokens` table now stores:

- `sex` — free-text label from the check-in form (`Female`, `Male`, `Other`, `Prefer not to say`).
- `phone` — phone number provided at check-in.

## Upgrading an existing database

Deploying the server automatically attempts to add missing columns. If you need to migrate manually (for example before restarting the service), run:

```sql
ALTER TABLE tokens
  ADD COLUMN IF NOT EXISTS sex TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT;
```

Existing rows will have `NULL` for the new fields until they are updated. Newly created check-ins always populate both columns.
