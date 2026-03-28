# Database Workflow

This backend now uses separated SQL migrations and seeders.

## Run migrations

```bash
npm run migrate
```

Runs all `.sql` files in `db/migrations` that have not been executed before.
The runner also creates `DB_NAME` automatically if it does not exist.

## Run seeders

```bash
npm run seed
```

Runs all `.sql` files in `db/seeders` that have not been executed before.

## Tracking tables

- `schema_migrations`
- `schema_seeders`

Each file runs once and is recorded in its tracking table.

## Default dev login (seeded)

- Email: `admin@solares.local`
- Password: `admin1234`

## Excel template import

Import all quote templates from a costing workbook:

```bash
npm run import:costing -- "D:\path\to\costing.xlsx"
```

Notes:
- The importer skips the `Wire Sizing` sheet.
- It detects both common pricing layouts used in your SOLARES workbook.

## Excel quote export template

Quotation exports use:

`backend/templates/quotation-template.xlsx`

You can replace that file with your latest approved quotation format.
