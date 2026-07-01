# AI Receipt Scanner

Full-stack web application for scanning receipt images and PDFs, extracting OCR text with Tesseract, structuring the result with local Llama 3.1, and storing transaction JSON in MongoDB.

## Tech Stack

- Frontend: Ionic React
- Backend: NestJS
- Database: MongoDB
- OCR: Tesseract.js with image preprocessing
- AI structuring: Local Llama 3.1 through Ollama
- Storage: Local filesystem under backend/uploads

## Features

- Upload JPG, PNG, HEIC, and PDF receipts.
- OCR support for English, Kannada, Malayalam, and Hindi.
- Tesseract OCR with preprocessing variants for contrast, sharpening, thresholding, BMTC pink-mark cleanup, and OpenCV-based receipt cleanup.
- Structured JSON extraction for purchase receipts, refund receipts, bus tickets, and train tickets.
- Transaction ID based lookup API.
- Editable extracted fields in the Ionic UI.
- JSON, CSV, PDF, and Excel-compatible export after processing.
- Duplicate receipt protection using normalized vendor/issuer plus receipt, ticket number, or PNR.
- Responsive Ionic UI for desktop and mobile.
- Background processing for multiple uploads with per-transaction status.
- Accuracy metrics endpoint for field-level accuracy, precision, and recall tracking.
- Per-user upload guardrails: 20 uploads per hour and 100 uploads per day.
- Monthly spending analytics by category from completed receipts.
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

### Monthly Spending Analytics

The frontend sends a stable browser user ID in the `X-User-Id` header. The backend uses it to keep receipt history, upload limits, and analytics scoped to the same user/device.

```http
GET /analytics/monthly
GET /analytics/monthly?month=2026-06
X-User-Id: user-browser-id
```

Uploads are limited to 20 receipts per hour and 100 receipts per day for each user ID. If the limit is reached, the API returns HTTP 429 with a clear message.

## Scalability Testing

Scalability tests are available in `load-tests/` using k6.

Read/API test for 50 simultaneous users:

```bash
k6 run load-tests/api-read-50-users.js
```

Concurrent upload test for 50 users:

```bash
k6 run -e RECEIPT_FILE=./load-tests/samples/receipt.jpg load-tests/upload-50-users.js
```

Watch backend, frontend, and MongoDB CPU/RAM during the test:

```bash
docker stats
```

See `load-tests/README.md` for Dockerized k6 commands, custom user counts, PDF/PNG MIME examples, status polling, and the scalability report template.

### Verified Scalability Results

The project was tested locally with Docker, MongoDB, NestJS backend, Ionic frontend, and k6.

#### API Read Load

Command:

```bash
k6 run load-tests/api-read-50-users.js
```

Result:

```text
Virtual users: 50
Total HTTP requests: 6000
Failed requests: 0
Failure rate: 0%
Average response time: 6.94 ms
p95 response time: 17.83 ms
Result: PASS
```

This test covered receipt history and monthly analytics read traffic:

```text
GET /receipts
GET /analytics/monthly
```

#### Concurrent Upload Load

Command:

```bash
k6 run -e RECEIPT_FILE=./samples/Receipt.png -e MIME_TYPE=image/png -e FILE_NAME=Receipt.png load-tests/upload-50-users.js
```

Result:

```text
Virtual users: 50
Upload requests: 50
Accepted uploads: 49
Failed uploads: 1
Upload acceptance rate: 98%
HTTP failure rate: 2%
Average upload response time: 2.4 seconds
p95 upload response time: about 3.1 seconds
Result: PASS
```

The upload API stores the transaction first and then continues OCR/AI extraction in a bounded background queue. This prevents 50 simultaneous uploads from forcing 50 OCR/Llama jobs to run at the exact same instant.

## Test Cases

The following test cases should be used for project evaluation and regression testing.

| ID | Test case | Input | Expected result |
| --- | --- | --- | --- |
| TC-01 | Normal grocery receipt upload | Clear JPG/PNG grocery receipt | Transaction ID is created, status is shown, JSON contains vendor, transaction, items, totals, payment, and raw text. |
| TC-02 | Receipt item extraction | Receipt with multiple product rows and prices | Each item row is extracted only when it has product name and amount. Receipt number must not be used as item price. |
| TC-03 | Medical/pharmacy receipt | Bill containing words like pharmacy, medical, paracetamol, antibiotic | Document is treated as normal purchase receipt and items/categories are extracted as medical/general items. |
| TC-04 | Fuel bill | Bill containing IndianOil, Bharat Petroleum, petrol, diesel, density, pump, litre | JSON uses fuel structure with vendor, transaction, fuel product, quantity, rate per unit, payment, totals, and raw text. |
| TC-05 | BMTC bus ticket | Ticket containing depot, TO, fare, cash/UPI | Document is ticket, transport type is bus, pickup is text above TO, destination is text below TO, total uses the amount near cash/UPI. |
| TC-06 | Train ticket | Ticket containing PNR, train, boarding, departure, to | Document is ticket, transport type is train, PNR is 10 digits, pickup comes from Boarding At, destination comes from To, class is detected from train class codes. |
| TC-07 | Refund receipt | Receipt containing refund/return/cancel indicators | JSON uses refund structure, includes original receipt number when available, refund items, refund method, and refund amount. |
| TC-08 | Duplicate exact file upload | Upload same bill file twice for same user | System warns duplicate was found and lets user replace or cancel. |
| TC-09 | Duplicate receipt identity | Upload same receipt content with same vendor plus receipt number | Older transaction is replaced or warning is recorded according to duplicate flow. |
| TC-10 | Multi-upload background processing | Upload several bills quickly | UI/history shows every transaction independently with processing/completed/failed status. |
| TC-11 | Transaction lookup API | Call `GET /receipt/:transactionId/output` | API returns status, extracted JSON, error/warning if any, and raw text. |
| TC-12 | Editable fields | Correct extracted fields in UI and save | Updated JSON is saved in MongoDB and can be retrieved by transaction ID. |
| TC-13 | JSON export | Download JSON after completed scan | Downloaded JSON is valid, readable, and contains extracted fields. |
| TC-14 | CSV/Excel/PDF export | Download CSV, Excel, and PDF after completed scan | Export files download successfully and preserve readable raw/extracted text. |
| TC-15 | HEIC upload and preview | Upload HEIC phone image | HEIC preview is converted/displayed and processing starts. |
| TC-16 | PDF upload | Single or multi-page PDF receipt | Text is extracted from PDF or OCR fallback is used, transaction status updates correctly. |
| TC-17 | Poor quality image | Blurry or unreadable bill photo | Clear error message asks user to upload a sharper bill image. |
| TC-18 | Non-bill image | Person, landscape, blank image, plain color image | System rejects it with a clear message saying it does not look like a bill/ticket. |
| TC-19 | Upload rate limit | More than 20 uploads per hour for one user | API returns HTTP 429 with upload limit message. |
| TC-20 | Daily rate limit | More than 100 uploads per day for one user | API returns HTTP 429 with daily upload limit message. |
| TC-21 | Monthly analytics | Completed receipts with item categories | `GET /analytics/monthly` returns monthly spending by category. |
| TC-22 | 50-user read scalability | Run `k6 run load-tests/api-read-50-users.js` | 50 users complete read traffic with 0% failures and p95 under 1 second. |
| TC-23 | 50-user upload scalability | Run k6 upload test with sample receipt | At least 95% uploads accepted, p95 upload response under 5 seconds, containers stay running. |
| TC-24 | Mobile camera upload | Open app on mobile-width viewport/device | Camera upload option appears only on mobile and opens rear camera/camera picker. |

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
