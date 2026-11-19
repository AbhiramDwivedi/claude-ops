from fastapi import FastAPI, HTTPException

from app.models import JournalEntry

app = FastAPI()
entries: list[JournalEntry] = []


@app.post("/entries", status_code=201)
async def post_entry(entry: JournalEntry) -> JournalEntry:
    if entry.amount <= 0:
        raise HTTPException(422, "amount must be positive")
    entries.append(entry)
    return entry
