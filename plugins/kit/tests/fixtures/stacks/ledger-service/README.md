# ledger-service

Double-entry ledger for a payments fintech. Services post transactions as journal entries that debit one account and credit another; balances are derived, never edited. Entries are append-only and auditable, and onboarding runs KYC and AML screening before an account can hold funds.

Run `uv run uvicorn app.main:app`. Test with `uv run pytest`.
