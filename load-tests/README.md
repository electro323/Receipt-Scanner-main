# Scalability Testing

This folder contains k6 tests to verify that the Receipt Scanner can handle 50 or more simultaneous users.

## Prerequisites

Start the application first:

```bash
docker compose up --build
```

Open these URLs to confirm the app is running:

```text
Frontend: http://localhost:8100
Backend:  http://localhost:3000/receipts
```

Install k6 from:

```text
https://grafana.com/docs/k6/latest/set-up/install-k6/
```

Or run k6 with Docker:

```bash
docker run --rm -i -v ${PWD}/load-tests:/scripts grafana/k6 run -e BASE_URL=http://host.docker.internal:3000 /scripts/api-read-50-users.js
```

## Test 1: 50 Users Reading API Data

This checks whether normal history/analytics traffic works with 50 simultaneous users.

```bash
k6 run load-tests/api-read-50-users.js
```

Custom run:

```bash
k6 run -e BASE_URL=http://localhost:3000 -e VUS=75 -e DURATION=2m load-tests/api-read-50-users.js
```

Good result:

- `http_req_failed` is below 1%
- p95 response time is below 1000 ms
- Docker containers stay running

## Test 2: 50 Users Uploading Receipts

Use a real receipt image or PDF. This is the most important test because upload creates MongoDB transactions and starts background OCR/AI processing.

```bash
k6 run -e RECEIPT_FILE=./load-tests/samples/receipt.jpg load-tests/upload-50-users.js
```

If the file is PNG or PDF, set the MIME type:

```bash
k6 run -e RECEIPT_FILE=./load-tests/samples/receipt.png -e MIME_TYPE=image/png -e FILE_NAME=receipt.png load-tests/upload-50-users.js
```

```bash
k6 run -e RECEIPT_FILE=./load-tests/samples/receipt.pdf -e MIME_TYPE=application/pdf -e FILE_NAME=receipt.pdf load-tests/upload-50-users.js
```

Custom run:

```bash
k6 run -e RECEIPT_FILE=./load-tests/samples/receipt.jpg -e VUS=75 -e ITERATIONS=75 -e MAX_DURATION=5m load-tests/upload-50-users.js
```

Optional status polling:

```bash
k6 run -e RECEIPT_FILE=./load-tests/samples/receipt.jpg -e POLL_STATUS=true load-tests/upload-50-users.js
```

Good result:

- `upload_accepted` is above 95%
- upload p95 response time is below 5000 ms
- `receipt-backend`, `receipt-mongodb`, and `receipt-frontend` do not crash
- history page shows transactions as processing/completed/failed

## Watch CPU/RAM During Tests

Run this in another terminal:

```bash
docker stats
```

For the assignment/evaluator, save:

- k6 terminal output
- Docker stats screenshot
- completed `scalability-report-template.md`

## Important Interpretation

The upload API should respond fast because processing runs in the background. OCR and local Llama can take longer on a laptop, especially with 50 uploads. That is acceptable if transactions are saved, visible in history, and continue processing without crashing.
