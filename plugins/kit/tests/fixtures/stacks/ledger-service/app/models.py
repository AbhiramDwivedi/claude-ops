from decimal import Decimal

from pydantic import BaseModel


class JournalEntry(BaseModel):
    """One posted transaction: debit one account, credit another, same amount."""

    id: str
    debit_account: str
    credit_account: str
    amount: Decimal
    currency: str
