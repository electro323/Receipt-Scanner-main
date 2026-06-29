# AI Receipt Scanner

Full-stack web application for scanning receipt images and PDFs, extracting OCR text with Tesseract, structuring the result with local Llama 3.1, and storing transaction JSON in MongoDB.

## Tech Stack

- Frontend: Ionic React
- Backend: NestJS
- Database: MongoDB
- OCR: Tesseract.js
- AI structuring: Local Llama 3.1 through Ollama
- Storage: Local filesystem under backend/uploads

## Features

- Upload JPG, PNG, HEIC, and PDF receipts.
- OCR support for English, Kannada, Malayalam, and Hindi.
- Structured JSON extraction for purchase receipts, refund receipts, bus tickets, and train tickets.
- Transaction ID based lookup API.
- Editable extracted fields in the Ionic UI.
- JSON, CSV, PDF, and Excel-compatible export after processing.
- Duplicate receipt protection using normalized vendor/issuer plus receipt, ticket number, or PNR.
- Responsive Ionic UI for desktop and mobile.
- Background processing for multiple uploads with per-transaction status.
- Accuracy metrics endpoint for field-level accuracy, precision, and recall tracking.
- If a duplicate bill is uploaded, the older transaction is deleted and the API returns a warning.

## Prerequisites

- Node.js 20+
- MongoDB running locally
- Ollama running locally with Llama 3.1 installed

```bash
ollama pull llama3.1
ollama serve
```

## Backend Setup

```bash
cd backend
npm install
npm run start:dev
```

Default backend URL:

```text
http://localhost:3000
```

Optional environment variables:

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/receipt-scanner
OLLAMA_URL=http://localhost:11434/api/generate
OLLAMA_MODEL=llama3.1
FRONTEND_ORIGIN=http://localhost:8100
```

## Frontend Setup

Open a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Default frontend URL:

```text
http://localhost:8100
```

## API

### Upload Receipt

```http
POST /upload
POST /receipts
Content-Type: multipart/form-data

receipt=<file>
```

OCR language is detected automatically across English, Kannada, Malayalam, and Hindi.

### Retrieve Receipt JSON By Transaction ID

```http
GET /receipt/:transactionId
GET /receipts/:transactionId
```

### Update Corrected JSON

```http
PUT /receipt/:transactionId
PUT /receipts/:transactionId
```

### Export

```http
GET /receipt/:transactionId/export/json
GET /receipt/:transactionId/export/csv
GET /receipt/:transactionId/export/pdf
GET /receipt/:transactionId/export/excel
```

### Accuracy Metrics

Use this endpoint with expected/correct JSON and actual/extracted JSON for a test set of receipts. It returns field-level accuracy plus precision/recall per field. The project target is 85% or higher field-level accuracy across at least 50 varied receipts.

```http
POST /metrics/accuracy
Content-Type: application/json

{
  "expected": [{ "...": "correct manually verified JSON" }],
  "actual": [{ "...": "system extracted JSON" }]
}
```

## Duplicate Rule

A receipt/ticket is considered duplicate when the identifying values match after normalization:

```text
purchase/refund: vendor.name + transaction.receipt_number
bus ticket: issuer.name + travel.ticket_number
train ticket: issuer.name + travel.PNR
```

Example:

```text
Whole Foods Market + ABC123456 -> wholefoodsmarket::abc123456
```

When a duplicate is found, the old MongoDB transaction and stored local file are deleted, then the new transaction is saved with a warning.
