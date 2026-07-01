# Receipt Scanner Backend

NestJS API for receipt upload, Tesseract OCR, Llama 3.1 structuring, MongoDB persistence, duplicate detection, rate limiting, analytics, and JSON/CSV export.

## Setup

```bash
npm install
npm run start:dev
```

## Environment

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/receipt-scanner
OLLAMA_URL=http://localhost:11434/api/generate
OLLAMA_MODEL=llama3.1
FRONTEND_ORIGIN=http://localhost:8100
```

## OCR Languages

The backend uses Tesseract with preprocessing variants for contrast, sharpening, thresholding, BMTC pink-mark cleanup, and OpenCV-based receipt cleanup. Tesseract is configured for English, Kannada, Malayalam, and Hindi using:

```text
eng+kan+mal+hin
```

Keep these Tesseract traineddata files available in either the backend root or backend/tessdata:

- eng.traineddata
- kan.traineddata
- mal.traineddata
- hin.traineddata

## Classification Rules

- If OCR contains `depot`, `depat`, `dept`, or a depot number, the backend treats it as a BMTC bus ticket.
- BMTC pickup and destination are extracted from the center layout around standalone `TO`: nearest readable English place above `TO` is pickup, nearest readable English place below `TO` is destination, skipping Kannada/noisy lines.
- BMTC total/payment amount is taken only from the two-digit rupee amount beside `(CASH)` or `(UPI)`.
- If OCR contains `store`, the backend treats it as a grocery/purchase receipt unless there is a stronger BMTC, fuel, or refund signal.

## API

- POST /upload or /receipts
- GET /receipt/:transactionId or /receipts/:transactionId
- PUT /receipt/:transactionId or /receipts/:transactionId
- GET /receipt/:transactionId/export/json
- GET /receipt/:transactionId/export/csv
- GET /receipt/:transactionId/export/excel
- GET /receipt/:transactionId/export/pdf
- GET /analytics/monthly
- POST /metrics/accuracy

Uploads use the `X-User-Id` header for per-user guardrails. Each user can upload 20 receipts per hour and 100 receipts per day. The monthly analytics endpoint uses the same user ID and summarizes completed receipt totals by category.

## Duplicate Rule

Duplicates are detected by normalized vendor name plus receipt number. When a duplicate is found, the older MongoDB record and stored file are deleted and the replacement transaction stores a duplicate warning.
