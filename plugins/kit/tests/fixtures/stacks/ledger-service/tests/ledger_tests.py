from decimal import Decimal

from fastapi.testclient import TestClient

from app.main import app


def test_post_entry_rejects_zero_amount():
    body = {"id": "1", "debit_account": "a", "credit_account": "b", "amount": "0", "currency": "USD"}
    assert TestClient(app).post("/entries", json=body).status_code == 422
    assert Decimal("0") <= 0
