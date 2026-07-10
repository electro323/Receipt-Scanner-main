# Python API Tests

These tests verify the Receipt Scanner backend API from outside the NestJS codebase. They are intended for evaluator/interviewer API testing.

## Prerequisites

Start the application first:

```bash
docker compose up --build
```

The backend must be available at:

```text
http://localhost:3000
```

## Install Test Dependencies

```bash
cd api-tests
pip install -r requirements.txt
```

## Run Tests

From the repository root:

```bash
pytest -v api-tests
```

Or from inside `api-tests`:

```bash
pytest -v
```

## Optional Environment Variables

```bash
BASE_URL=http://localhost:3000
RECEIPT_FILE=../load-tests/samples/Receipt.png
```

## What Is Tested

- `GET /receipts` returns JSON history.
- `GET /analytics/monthly` returns JSON analytics.
- `GET /receipts/:transactionId/output` handles unknown transaction IDs.
- `POST /metrics/accuracy` returns field-level accuracy, precision, and recall.
- `POST /upload` accepts a receipt file and returns a transaction ID/status.

The upload test only verifies API acceptance. Full OCR/AI completion time depends on local Tesseract/Ollama performance.
