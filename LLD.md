# Low-Level Design (LLD)
# AI Receipt Scanner System

---

## 1. Overview

This document describes the low-level design of the AI Receipt Scanner system built using:

- Frontend: Ionic
- Backend: NestJS
- OCR Engine: Tesseract OCR
- AI Model: Llama 3.1
- Database: MongoDB

The system extracts structured data from receipt images and stores validated financial records.

---

# 2. API DESIGN (REST)

## 2.1 POST /api/receipts/upload

Upload receipt image for processing.

### Request

Content-Type: multipart/form-data

```json id="api1"
{
  "file": "<image/png or image/jpg>"
}
Response
{
  "transactionId": "txn_12345",
  "status": "pending",
  "message": "Receipt uploaded successfully"
}
2.2 GET /api/receipts/status/:transactionId

Get processing status.

Response (Processing)
{
  "transactionId": "txn_12345",
  "status": "processing"
}
Response (Completed)
{
  "transactionId": "txn_12345",
  "status": "completed",
  "data": {
    "vendor_name": "RED STORE",
    "receipt_no": "98799",
    "total_amount": 830.86
  }
}
Response (Failed)
{
  "transactionId": "txn_12345",
  "status": "failed",
  "error": "OCR extraction failed"
}
3. DATABASE DESIGN (MongoDB)
3.1 Receipt Collection Schema
{
  "_id": "ObjectId",
  "transactionId": "txn_12345",
  "status": "completed",
  "createdAt": "2025-01-01T10:00:00Z",

  "vendor_name": "RED STORE",
  "receipt_no": "98799",
  "date": "2025-01-01",
  "total_amount": 830.86,
  "currency": "INR",

  "items": [
    {
      "name": "SKINN NOTE Z",
      "price": 59.79,
      "quantity": 1
    }
  ],

  "raw_ocr_text": "optional full OCR output"
}
3.2 Indexing Strategy
Index on transactionId (fast lookup)
Index on receipt_no (duplicate detection)
Index on vendor_name + date
4. MODULE / CLASS DESIGN (NestJS)
4.1 Backend Modules

UploadModule

Handles file upload
Validates image format
Stores temporary file

OCRModule

Processes image using Tesseract OCR
Returns raw extracted text

AIProcessingModule

Sends OCR text to Llama 3.1
Extracts structured JSON data

ReceiptModule

Stores final structured data
Handles retrieval APIs

DuplicateDetectionModule
Checks for existing receipts
Prevents duplicates

4.2 Class Responsibilities
ReceiptController
Handles API requests
Routes to services
ReceiptService
Business logic
Coordinates OCR + AI pipeline
OcrService
Image → text conversion
AiService
Text → structured JSON
DuplicateService
Detects duplicate receipts
5. IMAGE PREPROCESSING PIPELINE

Before OCR, all images are enhanced for better accuracy.

5.1 Steps
Step 1: Resize
Standardize image size (e.g., 1024px width)
Step 2: Grayscale Conversion
Remove color noise
Improve OCR clarity
Step 3: Noise Removal
Apply Gaussian blur or median filtering
Step 4: Contrast Enhancement
Improve text visibility
Step 5: Deskewing
Fix tilted/scanned angles
Step 6: Thresholding
Convert to binary image (black/white)
5.2 Pipeline Flow
Input Image
   ↓
Resize
   ↓
Grayscale
   ↓
Noise Removal
   ↓
Contrast Enhancement
   ↓
Deskewing
   ↓
Thresholding
   ↓
Tesseract OCR
   ↓
Raw Text Output
6. LLM PROMPT ENGINEERING (Llama 3.1)
6.1 Objective

Convert raw OCR text into structured receipt JSON.

6.2 System Prompt
You are an AI system that extracts structured receipt data.

Extract the following fields:
- vendor_name
- receipt_number
- date
- total_amount
- currency
- items (name, price, quantity if available)

Return ONLY valid JSON.
Do not include explanations.
6.3 User Prompt Template
Extract structured receipt data from the following OCR text:

{OCR_TEXT}
6.4 Example Output
{
  "vendor_name": "RED STORE",
  "receipt_no": "98799",
  "date": "2025-01-01",
  "total_amount": 830.86,
  "currency": "INR",
  "items": [
    {
      "name": "SKINN NOTE Z",
      "price": 59.79,
      "quantity": 1
    }
  ]
}
6.5 Prompt Improvements Strategy
Use strict JSON-only output
Add schema validation rules
Few-shot examples (optional)
Temperature = 0.2 for consistency
7. SYSTEM WORKFLOW SUMMARY
User Uploads Receipt
        ↓
Frontend (Ionic)
        ↓
Backend (NestJS API)
        ↓
Image Preprocessing
        ↓
Tesseract OCR
        ↓
Raw Text
        ↓
Llama 3.1 Structuring
        ↓
Duplicate Check
        ↓
MongoDB Storage
        ↓
Response to User
8. SUMMARY

This LLD defines:

API structure
Database schema
Backend module responsibilities
OCR preprocessing pipeline
LLM prompt engineering strategy

The system is designed for:

scalability
modularity
accuracy
low-cost OCR processing