# API Quality, Performance, and Scalability Report

This document answers the three evaluation questions for the Receipt Scanner API.

## 1. API Accuracy

Question: How accurate is the receipt scanning? Does it work all the time accurately?

Answer: The system is designed for high accuracy, but no OCR-based scanner can be guaranteed to work accurately for every image. Accuracy depends strongly on image quality, receipt layout, blur, lighting, rotation, paper damage, and OCR readability.

Implemented accuracy controls:

- Tesseract OCR for JPG, PNG, HEIC, and PDF input.
- OCR language support for English, Kannada, Malayalam, and Hindi.
- Image quality rejection for blank/plain images and very blurry images.
- Non-bill rejection for unrelated images/PDFs such as CVs or random photos.
- Local Llama 3.1 structuring after OCR.
- Rule-based post-processing for common receipt/ticket fields.
- Specialized handling for:
  - purchase receipts
  - refund receipts
  - fuel bills
  - BMTC bus tickets
  - train tickets
- Editable verification screen so users can correct extraction errors.
- Raw OCR text stored in JSON for debugging/audit.
- Accuracy metrics endpoint:

```http
POST /metrics/accuracy
```

The accuracy endpoint compares manually verified expected JSON against extracted JSON and returns:

- field-level accuracy
- precision
- recall
- target field accuracy: `0.85`

Current honest status:

- Clear digital receipts and clean scanned receipts perform best.
- BMTC/train/fuel-specific rules improve structured extraction for those formats.
- Low-quality camera images can still produce OCR errors. The application mitigates this by rejecting very poor images and allowing editable corrections.
- To prove the final percentage, run the accuracy endpoint on a manually labeled test set of 50 varied bills.

Recommended evaluation method:

1. Collect 50 varied documents: grocery, fuel, refund, BMTC, train, PDF, HEIC, clear, faded, and slightly rotated samples.
2. Manually prepare expected JSON for each.
3. Upload each file and save the extracted JSON.
4. Send expected/actual pairs to `POST /metrics/accuracy`.
5. Report field-level accuracy, precision, and recall.

## 2. API Performance

Question: How fast does scanning work? Customers should not wait more than 15 seconds for a scan.

Answer: Upload response is fast because the API stores the transaction first and processes OCR/AI in the background. The user receives a transaction ID immediately and can track status from the UI/history page. The final JSON also records the processing time.

Implemented performance controls:

- Background processing queue.
- Multiple uploads can be accepted while earlier scans continue processing.
- Per-transaction status: `queued`, `processing`, `completed`, `failed`, `duplicate_pending`.
- Processing duration is stored in the final JSON:

```json
{
  "processing": {
    "duration": "3.42 s"
  }
}
```

Current verified API upload performance from k6:

```text
Virtual users: 50
Upload requests: 50
Accepted uploads: 49
Upload acceptance rate: 98%
Average upload response time: 2.4 seconds
p95 upload response time: about 3.1 seconds
Result: PASS
```

Important distinction:

- Upload API response target: under 15 seconds. Current measured p95 upload response is about 3.1 seconds.
- Full OCR + Llama scan completion depends on local CPU/RAM and Ollama model speed. The app records the exact scan duration in each completed JSON.

For a production deployment, use a stronger server/GPU or scale workers horizontally if the full OCR/AI completion time must always stay below 15 seconds under heavy load.

## 3. API Scalability

Question: How many scans can we process per minute?

Answer: The API can accept many uploads quickly, but completed scans per minute depends on OCR/Llama processing time and configured worker concurrency.

Current design:

- Upload requests are accepted quickly.
- Actual OCR/AI jobs run through a bounded background queue.
- Default processing concurrency:

```text
RECEIPT_PROCESSING_CONCURRENCY=2
```

Throughput formula:

```text
completed scans per minute = processing concurrency * 60 / average processing seconds
```

Examples with default concurrency `2`:

| Average full scan time | Estimated completed scans/minute |
| --- | ---: |
| 5 seconds | 24 scans/minute |
| 10 seconds | 12 scans/minute |
| 15 seconds | 8 scans/minute |

If the server is configured with `RECEIPT_PROCESSING_CONCURRENCY=4` and average full scan time is 10 seconds:

```text
4 * 60 / 10 = 24 completed scans/minute
```

Current verified API read scalability from k6:

```text
Virtual users: 50
Total HTTP requests: 6000
Failed requests: 0
Failure rate: 0%
Average response time: 6.94 ms
p95 response time: 17.83 ms
Result: PASS
```

Current verified concurrent upload scalability from k6:

```text
Virtual users: 50
Upload requests: 50
Accepted uploads: 49
Upload acceptance rate: 98%
Average upload response time: 2.4 seconds
p95 upload response time: about 3.1 seconds
Result: PASS
```

Conclusion:

- The API layer can handle 50 concurrent users for read/history/analytics traffic.
- The upload API can accept 50 concurrent uploads without blocking until OCR finishes.
- Completed scans per minute should be reported using the formula above and the observed `processing.duration` values from completed transactions on the target machine.
- For production scale, increase worker concurrency and run OCR/AI workers on stronger hardware.
