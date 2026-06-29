# Receipt Scanner Backend

NestJS API for receipt upload, OCR, Llama 3.1 structuring, MongoDB persistence, duplicate detection, and JSON/CSV export.

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

The backend is configured for English, Kannada, Malayalam, and Hindi using:

```text
eng+kan+mal+hin
```

Keep these Tesseract traineddata files available in either the backend root or backend/tessdata:

- eng.traineddata
- kan.traineddata
- mal.traineddata
- hin.traineddata

## API

- POST /upload or /receipts
- GET /receipt/:transactionId or /receipts/:transactionId
- PUT /receipt/:transactionId or /receipts/:transactionId
- GET /receipt/:transactionId/export/json
- GET /receipt/:transactionId/export/csv

## Duplicate Rule

Duplicates are detected by normalized vendor name plus receipt number. When a duplicate is found, the older MongoDB record and stored file are deleted and the replacement transaction stores a duplicate warning.
