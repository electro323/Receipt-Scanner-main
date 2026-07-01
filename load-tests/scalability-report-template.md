# Scalability Test Report

## Test Environment

- Date:
- Machine/server:
- CPU:
- RAM:
- Docker Desktop version:
- Backend URL:
- Frontend URL:
- MongoDB:
- Ollama model:
- Receipt sample used:

## Test 1: API Read Load

Command:

```bash
k6 run load-tests/api-read-50-users.js
```

Target:

- 50 virtual users
- 1 minute duration
- `GET /receipts`
- `GET /analytics/monthly`

Results:

- Total requests:
- Failed request rate:
- Average response time:
- p95 response time:
- Max response time:
- CPU/RAM observed with `docker stats`:

Pass criteria:

- Failed request rate under 1%
- p95 response time under 1 second for read APIs
- No backend, frontend, or MongoDB container crash

## Test 2: Concurrent Upload Load

Command:

```bash
k6 run -e RECEIPT_FILE=./load-tests/samples/YOUR_RECEIPT.jpg load-tests/upload-50-users.js
```

Target:

- 50 virtual users
- 50 upload iterations
- Background OCR/AI processing should continue after upload response

Results:

- Upload requests:
- Accepted upload rate:
- Average upload response time:
- p95 upload response time:
- Completed transactions:
- Failed transactions:
- Queued/processing transactions:
- CPU/RAM observed with `docker stats`:

Pass criteria:

- Upload API accepts at least 95% of requests
- p95 upload API response time stays below 5 seconds
- API does not crash under 50 concurrent uploads
- MongoDB stores transaction records
- UI/history shows processing/completed/failed status per transaction
- OCR/AI jobs may finish later depending on laptop/server capacity

## Notes

OCR and local Llama processing are CPU/RAM-heavy. For production, the app should run uploads through a bounded background queue so 50 users can submit receipts without forcing 50 OCR/Llama jobs to run at the same instant.
