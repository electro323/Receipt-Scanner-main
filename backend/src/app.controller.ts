import {
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as Tesseract from 'tesseract.js';
import { existsSync, promises as fs } from 'fs';
import { extname, join } from 'path';
import { createHash } from 'crypto';

import { ReceiptService } from './receipts/receipt.service';
import { processReceiptWithAI } from './ai.service';
import { enrichReceiptData, extractTravelStopsFromOCR } from './postprocess.service';
import { analyzeImageQuality, preprocessImage } from './image-preprocess.service';
import {
  ensureHeicJpegPreview,
  prepareFileForOCR,
  extractPdfText,
} from './file-convert.service';

@Controller()
export class AppController {
  private readonly processingQueue: Array<{ file: any; transactionId: string }> = [];
  private activeProcessingJobs = 0;
  private readonly maxProcessingJobs = Math.max(
    1,
    Number(process.env.RECEIPT_PROCESSING_CONCURRENCY || 2),
  );

  constructor(private readonly receiptService: ReceiptService) {}

  @Post(['upload', 'receipts'])
  @UseInterceptors(
    FileInterceptor('receipt', {
      dest: './uploads',
    }),
  )
  async uploadReceipt(
    @UploadedFile() file: any,
    @Req() request: Request,
  ) {
    if (!file) {
      return {
        success: false,
        message: 'Please upload a receipt file.',
      };
    }

    const userId = this.getRequestUserId(request);
    const rateLimit = await this.checkUploadRateLimit(userId);

    if (!rateLimit.allowed) {
      await fs.unlink(file.path).catch(() => undefined);
      throw new HttpException(rateLimit.message, HttpStatus.TOO_MANY_REQUESTS);
    }

    const transactionId = 'TXN-' + Date.now();
    const fileHash = await this.calculateFileHash(file.path);
    const duplicate = await this.findExistingDuplicateByHash(fileHash, userId);

    if (duplicate) {
      await this.receiptService.createReceipt(
        transactionId,
        file.path,
        file.originalname,
        file.mimetype,
        fileHash,
        userId,
        'duplicate_pending',
        duplicate.transactionId,
      );

      return {
        success: true,
        transactionId,
        status: 'duplicate_pending',
        duplicateOfTransactionId: duplicate.transactionId,
        message: 'This exact bill was already uploaded as transaction ' + duplicate.transactionId + '. Replace the old bill or cancel this upload.',
      };
    }

    await this.receiptService.createReceipt(
      transactionId,
      file.path,
      file.originalname,
      file.mimetype,
      fileHash,
      userId,
    );

    this.enqueueReceiptProcessing(file, transactionId);

    return {
      success: true,
      transactionId,
      status: 'processing',
      message: 'Receipt uploaded. Processing will continue in the background.',
    };
  }

  @Post(['receipt/:transactionId/duplicate/replace', 'receipts/:transactionId/duplicate/replace'])
  async replaceDuplicateUpload(
    @Param('transactionId') transactionId: string,
  ) {
    const receipt = await this.receiptService.confirmDuplicateReplacement(transactionId);

    if (!receipt) {
      return {
        success: false,
        message: 'Duplicate transaction was not found.',
      };
    }

    this.enqueueReceiptProcessing(
      {
        path: receipt.filePath,
        originalname: receipt.originalName,
        mimetype: receipt.mimeType,
      },
      receipt.transactionId,
    );

    return {
      success: true,
      transactionId: receipt.transactionId,
      status: 'processing',
      message: receipt.duplicateWarning || 'Old bill replaced. Processing started.',
    };
  }

  @Post(['receipt/:transactionId/duplicate/cancel', 'receipts/:transactionId/duplicate/cancel'])
  async cancelDuplicateUpload(
    @Param('transactionId') transactionId: string,
  ) {
    return this.receiptService.cancelDuplicateUpload(transactionId);
  }

  @Post('preview/heic')
  @UseInterceptors(
    FileInterceptor('receipt', {
      dest: './uploads',
    }),
  )
  async previewHeicUpload(
    @UploadedFile() file: any,
    @Res() response: Response,
  ) {
    if (!file) {
      response.status(400).send('Please upload a HEIC file.');
      return;
    }

    try {
      const previewPath = await ensureHeicJpegPreview(file.path);
      const absolutePath = join(process.cwd(), previewPath);

      response.setHeader('Content-Type', 'image/jpeg');
      response.on('finish', () => {
        void fs.unlink(file.path).catch(() => undefined);
        void fs.unlink(previewPath).catch(() => undefined);
      });
      response.sendFile(absolutePath);
    } catch (error) {
      console.error('HEIC upload preview failed:', error);
      void fs.unlink(file.path).catch(() => undefined);
      response.status(400).send('Unable to preview HEIC file.');
    }
  }

  private async processReceiptInBackground(
    file: any,
    transactionId: string,
  ) {
    try {
      let rawText = '';
      let averageConfidence = 0;
      let extractedTravelStops = { pickup_point: '', destination: '' };

      if (file.originalname.toLowerCase().endsWith('.pdf')) {
        try {
          const pdfText = await extractPdfText(file.path);

          if (pdfText && pdfText.trim().length > 20) {
            rawText = pdfText.trim();
            extractedTravelStops = extractTravelStopsFromOCR(pdfText);
            averageConfidence = 100;
          }
        } catch (error) {
          console.error('PDF text extraction failed; falling back to OCR:', error);
        }
      }

      if (!rawText) {
        const imagePaths = await prepareFileForOCR(file);
        const qualityResults = await Promise.all(
          imagePaths.map((imagePath) => analyzeImageQuality(imagePath)),
        );

        if (qualityResults.length > 0 && qualityResults.every((quality) => quality.isPlainOrBlank)) {
          await this.receiptService.markFailed(
            transactionId,
            'This image looks blank or plain. Please upload a clear photo or PDF of a bill.',
          );
          return;
        }

        if (qualityResults.length > 0 && qualityResults.every((quality) => quality.isVeryBlurry || quality.isPlainOrBlank)) {
          await this.receiptService.markFailed(
            transactionId,
            'This image is too blurry to read. Please upload a sharper bill image.',
          );
          return;
        }

        let combinedText = '';
        let totalConfidence = 0;
        const langPath = this.getTesseractLangPath();

        for (let index = 0; index < imagePaths.length; index++) {
          const imagePath = imagePaths[index];
          const quality = qualityResults[index];
          const mode = this.pickPreprocessMode(quality);
          const processedImagePaths = await preprocessImage(imagePath, mode);
          const result = await this.recognizeBestVariantFast(
            processedImagePaths,
            langPath,
            mode,
          );
          console.log('OCR image variant selected:', result.imagePath);
          console.log('OCR language selected:', result.language);
          console.log('OCR preprocessing mode:', mode);
          combinedText += result.text + '\n';
          totalConfidence += result.confidence || 0;
        }

        extractedTravelStops = extractTravelStopsFromOCR(combinedText);
        rawText = this.normalizeOcrText(combinedText.trim());
        if (this.hasBmtcOcrSignals(rawText)) {
          rawText = this.stripNonEnglishOnlyLines(rawText);
        }
        averageConfidence = imagePaths.length > 0 ? totalConfidence / imagePaths.length : 0;
      }

      if (averageConfidence < 15 || rawText.length < 20) {
        await this.receiptService.markFailed(
          transactionId,
          'Receipt could not be read. Please upload a clearer image.',
        );
        return;
      }

      const receiptContentCheck = this.validateReceiptLikeText(rawText, averageConfidence);

      if (!receiptContentCheck.ok) {
        await this.receiptService.markFailed(
          transactionId,
          receiptContentCheck.message,
        );
        return;
      }

      await this.receiptService.saveOCR(transactionId, rawText);
      console.log('OCR saved for transaction:', transactionId);
      console.log(rawText);

      let finalData: any;

      try {
        const aiResponse = await processReceiptWithAI(rawText);
        const structuredData = JSON.parse(aiResponse);
        finalData = enrichReceiptData(structuredData, rawText);
      } catch (aiError) {
        console.error('AI structuring failed. Saving OCR fallback JSON:', aiError);
        finalData = enrichReceiptData({}, rawText);
      }
      finalData = this.applyExtractedTravelStops(finalData, extractedTravelStops);

      await this.receiptService.saveAIResult(transactionId, finalData);
      console.log('Final receipt JSON saved for transaction:', transactionId);
      console.log(JSON.stringify(finalData, null, 2));
    } catch (error) {
      console.error('BACKGROUND PROCESSING ERROR:', error);

      await this.receiptService.markFailed(
        transactionId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  @Post('process-ai')
  async processAI(@Body() body: any) {
    const aiResponse = await processReceiptWithAI(body.rawText || '');
    const structuredData = JSON.parse(aiResponse);
    const finalData = this.applyExtractedTravelStops(
      enrichReceiptData(structuredData, body.rawText || ''),
      extractTravelStopsFromOCR(body.rawText || ''),
    );

    if (body.transactionId) {
      await this.receiptService.saveAIResult(body.transactionId, finalData);
    }

    return finalData;
  }

  private applyExtractedTravelStops(data: any, stops: { pickup_point: string; destination: string }) {
    if (data?.document?.type !== 'ticket') return data;

    data.travel ??= {};
    if (stops.pickup_point) data.travel.pickup_point = stops.pickup_point;
    if (stops.destination) data.travel.destination = stops.destination;

    if (data.travel.pickup_point && data.travel.destination) {
      data.travel.route = data.travel.pickup_point + ' to ' + data.travel.destination;
    }

    return data;
  }

  @Put(['receipt/:transactionId', 'receipts/:transactionId'])
  async updateReceipt(
    @Param('transactionId') transactionId: string,
    @Body() receiptData: any,
  ) {
    return this.receiptService.updateReceiptData(transactionId, receiptData);
  }

  @Get(['receipt/:transactionId', 'receipts/:transactionId'])
  async getReceipt(
    @Param('transactionId') transactionId: string,
  ) {
    return this.receiptService.findByTransactionId(transactionId);
  }

  @Get(['receipt/:transactionId/output', 'receipts/:transactionId/output'])
  async getReceiptOutput(
    @Param('transactionId') transactionId: string,
  ) {
    const receipt = await this.receiptService.findByTransactionId(transactionId);

    return {
      transactionId: receipt?.transactionId || transactionId,
      status: receipt?.status || 'not_found',
      warning: receipt?.duplicateWarning || '',
      error: receipt?.error || '',
      data: receipt?.receiptData || {},
      raw_text: receipt?.rawText || receipt?.receiptData?.raw_text || '',
    };
  }

  @Get('receipts')
  async getReceipts(
    @Req() request: Request,
  ) {
    return this.receiptService.findAll(this.getRequestUserId(request));
  }

  private enqueueReceiptProcessing(file: any, transactionId: string) {
    this.processingQueue.push({ file, transactionId });
    this.drainReceiptProcessingQueue();
  }

  private drainReceiptProcessingQueue() {
    while (
      this.activeProcessingJobs < this.maxProcessingJobs
      && this.processingQueue.length > 0
    ) {
      const job = this.processingQueue.shift();
      if (!job) return;

      this.activeProcessingJobs++;
      setImmediate(() => {
        void this.processReceiptInBackground(job.file, job.transactionId)
          .finally(() => {
            this.activeProcessingJobs--;
            this.drainReceiptProcessingQueue();
          });
      });
    }
  }

  @Get('analytics/monthly')
  async getMonthlyAnalytics(
    @Req() request: Request,
    @Query('month') month = '',
  ) {
    return this.receiptService.getMonthlyCategoryAnalytics(
      this.getRequestUserId(request),
      month,
    );
  }

  @Get(['receipt/:transactionId/preview', 'receipts/:transactionId/preview'])
  async previewReceiptFile(
    @Param('transactionId') transactionId: string,
    @Res() response: Response,
  ) {
    const receipt = await this.receiptService.findByTransactionId(transactionId);

    if (!receipt?.filePath) {
      response.status(404).send('Receipt file not found');
      return;
    }

    const originalName = receipt.originalName || receipt.filePath;
    const originalExt = extname(originalName).toLowerCase();
    let previewPath = receipt.filePath;
    let contentType = this.getPreviewContentType(originalName, receipt.mimeType);

    if (originalExt === '.heic' || originalExt === '.heif' || (!originalExt && existsSync(receipt.filePath + '.jpg'))) {
      try {
        previewPath = await ensureHeicJpegPreview(receipt.filePath);
        contentType = 'image/jpeg';
      } catch (error) {
        console.error('HEIC preview conversion failed:', error);
      }
    }

    const absolutePath = join(process.cwd(), previewPath);

    if (!existsSync(absolutePath)) {
      response.status(404).send('Receipt file not found');
      return;
    }

    if (contentType === 'application/octet-stream') {
      contentType = await this.detectPreviewContentType(absolutePath);
    }

    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', 'inline; filename="' + originalName.replace(/"/g, '') + '"');
    response.sendFile(absolutePath);
  }

  @Get(['receipt/:transactionId/export/json', 'receipts/:transactionId/export/json'])
  async exportJson(
    @Param('transactionId') transactionId: string,
    @Res() response: Response,
  ) {
    const receipt = await this.receiptService.findByTransactionId(transactionId);
    const json = JSON.stringify(receipt?.receiptData || {}, null, 2);

    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      'attachment; filename=' + transactionId + '.json',
    );
    response.send(json);
  }

  @Get(['receipt/:transactionId/export/csv', 'receipts/:transactionId/export/csv'])
  async exportCsv(
    @Param('transactionId') transactionId: string,
    @Res() response: Response,
  ) {
    const receipt = await this.receiptService.findByTransactionId(transactionId);
    const data = receipt?.receiptData || {};
    const csv = this.buildReceiptCsv(data);

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      'attachment; filename=' + transactionId + '.csv',
    );
    response.send('\uFEFF' + csv);
  }

  @Get(['receipt/:transactionId/export/excel', 'receipts/:transactionId/export/excel'])
  async exportExcel(
    @Param('transactionId') transactionId: string,
    @Res() response: Response,
  ) {
    const receipt = await this.receiptService.findByTransactionId(transactionId);
    const data = receipt?.receiptData || {};

    response.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename=' + transactionId + '.xls');
    response.send('\uFEFF' + this.buildReceiptExcel(data));
  }

  @Get(['receipt/:transactionId/export/pdf', 'receipts/:transactionId/export/pdf'])
  async exportPdf(
    @Param('transactionId') transactionId: string,
    @Res() response: Response,
  ) {
    const receipt = await this.receiptService.findByTransactionId(transactionId);
    const data = receipt?.receiptData || {};
    const pdf = this.buildReceiptPdf(transactionId, data);

    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', 'attachment; filename=' + transactionId + '.pdf');
    response.send(pdf);
  }

  @Post('metrics/accuracy')
  calculateAccuracyMetrics(@Body() body: any) {
    const expectedItems = Array.isArray(body?.expected) ? body.expected : [body?.expected || {}];
    const actualItems = Array.isArray(body?.actual) ? body.actual : [body?.actual || {}];
    let expectedFieldCount = 0;
    let extractedFieldCount = 0;
    let correctFieldCount = 0;
    const perField: Record<string, { expected: number; extracted: number; correct: number; precision: number; recall: number }> = {};

    expectedItems.forEach((expected: any, index: number) => {
      const actual = actualItems[index] || {};
      const expectedFlat = this.flattenObject(expected);
      const actualFlat = this.flattenObject(actual);
      const fields = new Set([...Object.keys(expectedFlat), ...Object.keys(actualFlat)]);

      for (const field of fields) {
        const expectedValue = expectedFlat[field];
        const actualValue = actualFlat[field];
        const hasExpected = expectedValue !== undefined && expectedValue !== '';
        const hasActual = actualValue !== undefined && actualValue !== '';
        const isCorrect = hasExpected && hasActual && this.normalizeMetricValue(expectedValue) === this.normalizeMetricValue(actualValue);

        perField[field] ??= { expected: 0, extracted: 0, correct: 0, precision: 0, recall: 0 };
        if (hasExpected) {
          expectedFieldCount++;
          perField[field].expected++;
        }
        if (hasActual) {
          extractedFieldCount++;
          perField[field].extracted++;
        }
        if (isCorrect) {
          correctFieldCount++;
          perField[field].correct++;
        }
      }
    });

    for (const stats of Object.values(perField)) {
      stats.precision = stats.extracted ? Number((stats.correct / stats.extracted).toFixed(4)) : 0;
      stats.recall = stats.expected ? Number((stats.correct / stats.expected).toFixed(4)) : 0;
    }

    return {
      target_field_accuracy: 0.85,
      field_accuracy: expectedFieldCount ? Number((correctFieldCount / expectedFieldCount).toFixed(4)) : 0,
      precision: extractedFieldCount ? Number((correctFieldCount / extractedFieldCount).toFixed(4)) : 0,
      recall: expectedFieldCount ? Number((correctFieldCount / expectedFieldCount).toFixed(4)) : 0,
      expected_fields: expectedFieldCount,
      extracted_fields: extractedFieldCount,
      correct_fields: correctFieldCount,
      per_field: perField,
    };
  }

  private async recognizeWithAutoLanguage(imagePath: string, langPath: string) {
    const recognize = async (language: string) => {
      const result = await Tesseract.recognize(
        imagePath,
        language,
        {
          langPath,
          gzip: false,
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1',
        } as any,
      );

      return {
        language,
        imagePath,
        text: result.data.text || '',
        confidence: result.data.confidence || 0,
        score: this.scoreOCRResult(result.data.text || '', result.data.confidence || 0),
      };
    };

    const english = await recognize('eng');

    if (english.score >= 95 && english.confidence >= 52) {
      return english;
    }

    try {
      const combined = await recognize('eng+kan+mal+hin');
      return [english, combined].sort((a, b) => b.score - a.score)[0];
    } catch (error) {
      console.error('Combined multilingual OCR failed; trying compact fallback:', error);
    }

    const candidates = [english];

    for (const language of ['eng+kan', 'eng+hin']) {
      try {
        candidates.push(await recognize(language));
      } catch (error) {
        console.error('OCR language failed:', language, error);
      }
    }

    return candidates.sort((a, b) => b.score - a.score)[0];
  }

  private pickPreprocessMode(quality: any): 'fast' | 'balanced' | 'strong' {
    if (!quality) return 'balanced';
    if (quality.edgeScore >= 7 && quality.stddev >= 38) return 'fast';
    if (quality.edgeScore < 3.5 || quality.stddev < 24) return 'strong';
    return 'balanced';
  }

  private async recognizeBestVariantFast(
    imagePaths: string[],
    langPath: string,
    mode: 'fast' | 'balanced' | 'strong' = 'balanced',
  ) {
    const segmentPaths = imagePaths.filter((imagePath) => /-segment-\d+\.png$/i.test(imagePath));
    const wholeImagePaths = imagePaths.filter((imagePath) => !/-segment-\d+\.png$/i.test(imagePath));
    const candidates = [];
    const maxFastVariants = Math.min(
      wholeImagePaths.length,
      mode === 'fast' ? 3 : mode === 'strong' ? 5 : 3,
    );
    for (let index = 0; index < maxFastVariants; index++) {
      const candidate = await this.recognizeEnglishOnly(wholeImagePaths[index], langPath);
      candidates.push(candidate);

      if (this.isExcellentOcr(candidate) && this.isCompleteEnoughForEarlyReturn(candidate.text)) {
        return candidate;
      }

      if (mode === 'fast' && this.isGoodOcr(candidate)) {
        return candidate;
      }
    }

    let best = candidates.sort((a, b) => b.score - a.score)[0];

    if (this.isGoodOcr(best)) {
      return best;
    }

    if (mode !== 'strong' && best?.score >= 112 && best?.confidence >= 48 && this.hasUsefulOcrDetail(best.text)) {
      return best;
    }

    if (this.hasBmtcOcrSignals(best?.text || '') && best?.score >= 80) {
      return best;
    }

    if (mode === 'strong' && segmentPaths.length >= 2) {
      const segmented = await this.recognizeReceiptSegments(segmentPaths, langPath);
      if (segmented && (!best || segmented.score > best.score || this.hasMoreReceiptDetail(segmented.text, best.text))) {
        return segmented;
      }
    }

    const fallbackImagePath = best?.imagePath || wholeImagePaths[0] || imagePaths[0];
    const multilingual = await this.recognizeMultilingualFallback(fallbackImagePath, langPath);
    best = [best, multilingual].filter(Boolean).sort((a, b) => b.score - a.score)[0];

    return best;
  }

  private async recognizeReceiptSegments(segmentPaths: string[], langPath: string) {
    const sortedSegments = [...segmentPaths].sort();
    const results = [];

    for (const segmentPath of sortedSegments.slice(0, 8)) {
      const result = await this.recognizeEnglishOnly(segmentPath, langPath);
      if (result.text.trim().length > 8) results.push(result);
    }

    if (!results.length) return null;

    const text = results.map((result) => result.text.trim()).join('\n');
    const confidence = results.reduce((sum, result) => sum + result.confidence, 0) / results.length;

    return {
      language: 'eng-segments',
      imagePath: sortedSegments[0] + ' +' + Math.max(0, results.length - 1) + ' segments',
      text,
      confidence,
      score: this.scoreOCRResult(text, confidence) + Math.min(results.length * 4, 20),
    };
  }

  private isExcellentOcr(candidate: any): boolean {
    return candidate?.score >= 145
      && candidate?.confidence >= 66
      && this.hasUsefulOcrDetail(candidate.text)
      && this.hasReceiptLineStructure(candidate.text);
  }

  private isGoodOcr(candidate: any): boolean {
    return candidate?.score >= 126
      && candidate?.confidence >= 56
      && this.hasUsefulOcrDetail(candidate.text);
  }

  private isCompleteEnoughForEarlyReturn(text: string): boolean {
    if (!this.hasBmtcOcrSignals(text)) return true;
    return this.ocrCompletenessScore(text) >= 2;
  }

  private ocrCompletenessScore(text: string): number {
    let score = 0;
    if (/\bto\b/i.test(text)) score += 1;
    if (/\b(depot\s*[- ]?\d+|dep[o0a]t\s*[- ]?\d+|dept\s*[- ]?\d+|gate|temple|field|hospital|towards)\b/i.test(text)) score += 1;
    if (/(?:Rs\.?|INR|\u20B9)\s*\d+(?:\.\d{1,2})?/i.test(text)) score += 1;
    if (/\b(cash|upi)\b/i.test(text)) score += 1;
    return score;
  }

  private hasUsefulOcrDetail(text: string): boolean {
    const meaningfulWords = (text.match(/[A-Za-z]{3,}|[\u0C80-\u0CFF]{2,}|[\u0D00-\u0D7F]{2,}|[\u0900-\u097F]{2,}/g) || []).length;
    const amountMatches = (text.match(/(?:Rs\.?|INR|\u20B9|[$])?\s*[0-9]+(?:\.[0-9]{1,2})?/gi) || []).length;
    const receiptSignals = (text.match(/\b(total|amount|receipt|invoice|bill|qty|quantity|item|price|tax|gst|upi|cash|card|ticket|fare|petrol|diesel|pharmacy|restaurant)\b|\u20B9|Rs\.?/gi) || []).length;

    return meaningfulWords >= 6 && amountMatches >= 2 && receiptSignals >= 2;
  }

  private hasReceiptLineStructure(text: string): boolean {
    const usefulLines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /[A-Za-z]{2,}|[0-9]+/.test(line));
    const priceLines = usefulLines.filter((line) => /(?:Rs\.?|INR|\u20B9|[$])?\s*[0-9]+(?:[,.][0-9]{1,2})?\s*$/i.test(line));

    return usefulLines.length >= 6 && priceLines.length >= 2;
  }

  private hasMoreReceiptDetail(candidateText = '', currentText = ''): boolean {
    const countDetails = (text: string) => {
      const lines = text.split('\n').filter((line) => line.trim().length > 2).length;
      const amounts = (text.match(/(?:Rs\.?|INR|\u20B9|[$])?\s*[0-9]+(?:[,.][0-9]{1,2})?/gi) || []).length;
      const words = (text.match(/[A-Za-z]{3,}/g) || []).length;
      return lines * 2 + amounts * 4 + words;
    };

    return countDetails(candidateText) > countDetails(currentText) + 8;
  }

  private normalizeOcrText(text: string): string {
    return String(text || '')
      .replace(/\r/g, '\n')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[|]/g, 'I')
      .replace(/\bTOTAI\b/gi, 'TOTAL')
      .replace(/\bSUBTOTAI\b/gi, 'SUBTOTAL')
      .replace(/\bVlSA\b/g, 'VISA')
      .replace(/\bUP1\b/g, 'UPI')
      .replace(/([A-Za-z])\s{2,}([A-Za-z])/g, '$1 $2')
      .replace(/[ \t]{2,}/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
      .join('\n')
      .trim();
  }

  private hasBmtcOcrSignals(text: string): boolean {
    return /\b(bmtc|bmrtc|depot\s*[- ]?\d*|dep[o0a]t\s*[- ]?\d*|dept\s*[- ]?\d*|ordinary|tkn|ticket|fare|cash|upi)\b/i.test(text);
  }

  private stripNonEnglishOnlyLines(text: string): string {
    return String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        const hasIndianScript = /[\u0C80-\u0CFF\u0D00-\u0D7F\u0900-\u097F]/.test(line);
        const hasEnglishOrNumber = /[A-Za-z0-9]/.test(line);
        return !hasIndianScript || hasEnglishOrNumber;
      })
      .join('\n')
      .trim();
  }

  private async recognizeMultilingualFallback(imagePath: string, langPath: string) {
    const recognize = async (language: string) => {
      const result = await Tesseract.recognize(
        imagePath,
        language,
        {
          langPath,
          gzip: false,
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1',
        } as any,
      );

      return {
        language,
        imagePath,
        text: result.data.text || '',
        confidence: result.data.confidence || 0,
        score: this.scoreOCRResult(result.data.text || '', result.data.confidence || 0),
      };
    };

    try {
      return await recognize('eng+kan+mal+hin');
    } catch (error) {
      console.error('Combined multilingual OCR failed; trying compact fallback:', error);
    }

    const candidates = [];

    for (const language of ['eng+kan', 'eng+hin']) {
      try {
        candidates.push(await recognize(language));
      } catch (error) {
        console.error('OCR language failed:', language, error);
      }
    }

    return candidates.sort((a, b) => b.score - a.score)[0];
  }

  private async recognizeEnglishOnly(imagePath: string, langPath: string) {
    const result = await Tesseract.recognize(
      imagePath,
      'eng',
      {
        langPath,
        gzip: false,
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
      } as any,
    );

    return {
      language: 'eng',
      imagePath,
      text: result.data.text || '',
      confidence: result.data.confidence || 0,
      score: this.scoreOCRResult(result.data.text || '', result.data.confidence || 0),
    };
  }

  private async calculateFileHash(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return createHash('sha256').update(buffer).digest('hex');
  }

  private getRequestUserId(request: Request): string {
    const headerValue = request.headers['x-user-id'];
    const rawUserId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const fallback = request.ip || request.socket?.remoteAddress || 'anonymous';

    return String(rawUserId || fallback || 'anonymous')
      .trim()
      .replace(/[^a-zA-Z0-9._:-]/g, '')
      .slice(0, 80) || 'anonymous';
  }

  private async checkUploadRateLimit(userId: string) {
    const now = Date.now();
    const hourStart = new Date(now - 60 * 60 * 1000);
    const dayStart = new Date(now - 24 * 60 * 60 * 1000);
    const [hourCount, dayCount] = await Promise.all([
      this.receiptService.countUserUploadsSince(userId, hourStart),
      this.receiptService.countUserUploadsSince(userId, dayStart),
    ]);

    if (hourCount >= 20) {
      return {
        allowed: false,
        message: 'Upload limit reached. You can upload only 20 receipts per hour. Please try again later.',
      };
    }

    if (dayCount >= 100) {
      return {
        allowed: false,
        message: 'Daily upload limit reached. You can upload only 100 receipts per day. Please try again tomorrow.',
      };
    }

    return { allowed: true, message: '' };
  }

  private async findExistingDuplicateByHash(fileHash: string, userId: string) {
    const existingHashedMatch = await this.receiptService.findDuplicateByFileHash(fileHash, userId);

    if (existingHashedMatch) return existingHashedMatch;

    const receipts = await this.receiptService.findAll(userId);

    for (const receipt of receipts) {
      if (!receipt?.filePath || receipt.status === 'cancelled') continue;

      if (receipt.fileHash) {
        if (receipt.fileHash === fileHash) return receipt;
        continue;
      }

      try {
        if (!existsSync(receipt.filePath)) continue;

        const existingHash = await this.calculateFileHash(receipt.filePath);
        await this.receiptService.saveFileHash(receipt.transactionId, existingHash);

        if (existingHash === fileHash) return receipt;
      } catch (error) {
        console.error('Could not backfill receipt file hash:', receipt.transactionId, error);
      }
    }

    return null;
  }

  private getPreviewContentType(fileName: string, mimeType = '') {
    const ext = extname(fileName).toLowerCase();

    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.heic' || ext === '.heif') return 'image/heic';
    if (mimeType) return mimeType;
    return 'application/octet-stream';
  }

  private async detectPreviewContentType(filePath: string) {
    const handle = await fs.open(filePath, 'r');

    try {
      const buffer = Buffer.alloc(12);
      await handle.read(buffer, 0, buffer.length, 0);

      if (buffer.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
      if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
      if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
      if (buffer.subarray(4, 12).toString().startsWith('ftypheic')) return 'image/heic';

      return 'application/octet-stream';
    } finally {
      await handle.close();
    }
  }

  private scoreOCRResult(text: string, confidence: number): number {
    const meaningfulWords = (text.match(/[A-Za-z]{3,}|[\u0C80-\u0CFF]{2,}|[\u0D00-\u0D7F]{2,}|[\u0900-\u097F]{2,}/g) || []).length;
    const amountMatches = (text.match(/(?:Rs\.?|INR|\u20B9|[$])?\s*[0-9]+(?:\.[0-9]{1,2})?/gi) || []).length;
    const receiptBonus = /(total|amount|fare|ticket|refund|receipt|invoice|bill|rs|\u20B9|upi|cash|card|from|to)/i.test(text) ? 35 : 0;
    const scriptBonus = /[\u0C80-\u0CFF\u0D00-\u0D7F\u0900-\u097F]/.test(text) ? 8 : 0;
    const lengthScore = Math.min(text.trim().length / 25, 20);
    const noisePenalty = (text.match(/[{}~^_|§£]/g) || []).length * 3;
    const brokenCharPenalty = (text.match(/[�]/g) || []).length * 8;

    return confidence + meaningfulWords * 2 + amountMatches * 3 + receiptBonus + scriptBonus + lengthScore - noisePenalty - brokenCharPenalty;
  }

  private validateReceiptLikeText(rawText: string, confidence: number): { ok: boolean; message: string } {
    const text = rawText.replace(/\s+/g, ' ').trim();
    const words = text.match(/[A-Za-z]{3,}|[\u0C80-\u0CFF]{2,}|[\u0D00-\u0D7F]{2,}|[\u0900-\u097F]{2,}/g) || [];
    const amountMatches = text.match(/(?:Rs\.?|INR|\u20B9|[$])?\s*[0-9]+(?:[,.][0-9]{1,2})?/gi) || [];
    const hasBmtcDepotSignal = /\b(?:bmtc|bmrtc|depot|dep[o0a]t|dept)\s*[-:]?\s*\d*\b/i.test(text);
    const hasNonBillDocumentSignal = /\b(curriculum\s+vitae|resume|professional\s+summary|work\s+experience|education|technical\s+skills|certifications?|portfolio|cover\s+letter|project\s+assignment|core\s+functional\s+requirements|project\s+deliverables|evaluation\s+criteria|milestones?|suggested\s+technology\s+stack|resources\s+to\s+get\s+started)\b/i.test(text);
    const billSignals = text.match(/\b(receipt|invoice|bill|store|total|subtotal|tax|gst|cgst|sgst|igst|amount|paid|balance|discount|qty|quantity|item|price|mrp|cash|card|upi|visa|refund|return|fare|ticket|pnr|depot|dept|departure|arrival|boarding|train|railway|irctc|pizza|food|restaurant|health|medical|pharmacy|paracetamol|antibiotic|petrol|diesel|fuel|pump|density|litre|liter|ltr)\b|\u20B9|Rs\.?/gi) || [];
    const identitySignals = text.match(/\b(receipt|invoice|bill|store|ticket|pnr|voucher|slip|gst|upi|cash|card|depot|dept|train|irctc|petrol|diesel|pharmacy|restaurant|bmtc|bmrtc)\b/gi) || [];
    const paymentSignals = text.match(/\b(cash|card|upi|visa|mastercard|paid|payment|charge|refund)\b/gi) || [];
    const lineItemSignals = text.match(/\b(total|subtotal|tax|gst|qty|quantity|item|price|mrp|fare|rate|litre|liter|ltr)\b/gi) || [];
    const hasCurrencySymbol = /(?:Rs\.?|INR|\u20B9|[$])\s*\d/i.test(text);
    const hasReceiptIdentity = identitySignals.length > 0;
    const hasTransactionShape =
      /\b(?:receipt|invoice|bill|ticket|pnr|txn|transaction|voucher|slip|tkn)\s*(?:no|number|#|:|-)?\s*[A-Z0-9][A-Z0-9\/-]{2,}\b/i.test(text)
      || /\b(?:rec|inv|tkn|pnr)#?\s*[A-Z0-9][A-Z0-9\/-]{2,}\b/i.test(text);
    const hasTotalWithCurrency = /\b(?:total|subtotal|amount|fare|paid|refund|tax|gst)\b.{0,30}(?:Rs\.?|INR|\u20B9|[$])?\s*\d+(?:[,.]\d{1,2})?/i.test(text);
    const hasReceiptLikeStructure =
      hasReceiptIdentity
      && (
        ((hasCurrencySymbol || paymentSignals.length > 0) && (lineItemSignals.length >= 2 || hasTransactionShape || amountMatches.length >= 3))
        || (hasTransactionShape && hasTotalWithCurrency && lineItemSignals.length >= 2)
      );
    const hasStrongTicketStructure =
      /\b(?:pnr|boarding|departure|arrival|irctc|railway|train|depot|dept|bmtc|bmrtc)\b/i.test(text)
      && /\b(?:to|fare|ticket|total|cash|upi)\b/i.test(text)
      && amountMatches.length >= 1;
    const hasFuelStructure =
      /\b(?:petrol|diesel|fuel|pump|density|litre|liter|ltr)\b/i.test(text)
      && (hasCurrencySymbol || amountMatches.length >= 2);
    const hasStoreReceiptStructure =
      /\bstore\b/i.test(text)
      && (hasCurrencySymbol || amountMatches.length >= 2)
      && /\b(?:total|subtotal|cash|card|upi|visa|charge|paid|item|price|qty|quantity)\b/i.test(text);

    if (hasBmtcDepotSignal) {
      return { ok: true, message: '' };
    }

    if (hasNonBillDocumentSignal) {
      return {
        ok: false,
        message: 'This does not look like a bill or ticket. Please upload a receipt, travel ticket, refund bill, or fuel bill.',
      };
    }

    if (hasStoreReceiptStructure) {
      return { ok: true, message: '' };
    }

    if (confidence < 25 && words.length < 8) {
      return {
        ok: false,
        message: 'Receipt could not be read clearly. Please upload a sharper, well-lit bill image.',
      };
    }

    if (words.length < 5 || amountMatches.length === 0) {
      return {
        ok: false,
        message: 'This does not look like a bill or ticket. Please upload a receipt, travel ticket, refund bill, or fuel bill.',
      };
    }

    if (
      billSignals.length < 3
      || (!hasReceiptLikeStructure && !hasStrongTicketStructure && !hasFuelStructure && !hasStoreReceiptStructure)
    ) {
      return {
        ok: false,
        message: 'This image does not appear to contain bill details. Please upload a valid bill or ticket.',
      };
    }

    return { ok: true, message: '' };
  }

  private getTesseractLangPath(): string {
    const tessdataPath = join(process.cwd(), 'tessdata');
    return existsSync(join(tessdataPath, 'eng.traineddata')) ? tessdataPath : process.cwd();
  }

  private buildReceiptCsv(data: any): string {
    const rows: any[][] = [['field', 'value']];
    for (const [field, value] of Object.entries(this.flattenObject(data))) {
      rows.push([field, value]);
    }

    return rows.map((row) => row.map((value) => this.escapeCsv(value)).join(',')).join('\n');
  }

  private buildReceiptExcel(data: any): string {
    const rows = Object.entries(this.flattenObject(data));
    const tableRows = rows
      .map(([field, value]) => '<tr><td>' + this.escapeHtml(field) + '</td><td class="value">' + this.escapeHtml(value) + '</td></tr>')
      .join('');

    return [
      '<html><head><meta charset="UTF-8"><style>td,th{vertical-align:top;border:1px solid #999;padding:6px;font-family:Arial,\"Noto Sans Kannada\",\"Noto Sans Devanagari\",sans-serif}.value{white-space:pre-wrap;mso-data-placement:same-cell}</style></head><body>',
      '<table border="1">',
      '<thead><tr><th>Field</th><th>Value</th></tr></thead>',
      '<tbody>',
      tableRows,
      '</tbody></table>',
      '</body></html>',
    ].join('');
  }

  private buildReceiptPdf(transactionId: string, data: any): Buffer {
    const jsonLines = JSON.stringify(data, null, 2).split('\n');
    const lines = ['Transaction: ' + transactionId, ...jsonLines]
      .flatMap((line) => this.wrapPdfLine(this.toPdfSafeText(line), 92));
    const pages: string[][] = [];

    for (let index = 0; index < lines.length; index += 42) {
      pages.push(lines.slice(index, index + 42));
    }

    const objects: string[] = [];
    objects.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n');

    const pageObjectIds = pages.map((_, index) => 3 + index * 2);
    objects.push('2 0 obj << /Type /Pages /Kids [' + pageObjectIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >> endobj\n');

    pages.forEach((pageLines, index) => {
      const pageId = 3 + index * 2;
      const contentId = pageId + 1;
      const content = [
        'BT',
        '/F1 10 Tf',
        '40 790 Td',
        ...pageLines.map((line, lineIndex) => (lineIndex === 0 ? '' : '0 -16 Td\n') + '(' + this.escapePdfText(line) + ') Tj'),
        'ET',
      ].join('\n');

      objects.push(pageId + ' 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >> /Contents ' + contentId + ' 0 R >> endobj\n');
      objects.push(contentId + ' 0 obj << /Length ' + Buffer.byteLength(content, 'utf8') + ' >> stream\n' + content + '\nendstream endobj\n');
    });

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const object of objects) {
      offsets.push(Buffer.byteLength(pdf, 'utf8'));
      pdf += object;
    }

    const xrefOffset = Buffer.byteLength(pdf, 'utf8');
    pdf += 'xref\n0 ' + (objects.length + 1) + '\n';
    pdf += '0000000000 65535 f \n';
    for (const offset of offsets.slice(1)) {
      pdf += String(offset).padStart(10, '0') + ' 00000 n \n';
    }
    pdf += 'trailer << /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\n';
    pdf += 'startxref\n' + xrefOffset + '\n%%EOF';

    return Buffer.from(pdf, 'utf8');
  }

  private flattenObject(value: any, prefix = ''): Record<string, any> {
    if (value === null || value === undefined) return prefix ? { [prefix]: '' } : {};
    if (typeof value !== 'object') return prefix ? { [prefix]: value } : {};

    const output: Record<string, any> = {};
    const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);

    for (const [key, childValue] of entries as any) {
      const path = prefix ? prefix + '.' + key : key;
      if (childValue && typeof childValue === 'object') {
        Object.assign(output, this.flattenObject(childValue, path));
      } else {
        output[path] = childValue ?? '';
      }
    }

    return output;
  }

  private normalizeMetricValue(value: any): string {
    return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private escapeCsv(value: any): string {
    return '"' + String(value ?? '').replace(/"/g, '""') + '"';
  }

  private escapeHtml(value: any): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private toPdfSafeText(value: any): string {
    return String(value ?? '')
      .replace(/\u20B9/g, 'INR')
      .replace(/[^\x20-\x7E]/g, (character) => {
        const code = character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
        return '\\u' + code;
      });
  }

  private wrapPdfLine(line: string, width: number): string[] {
    if (line.length <= width) return [line];

    const chunks: string[] = [];
    for (let index = 0; index < line.length; index += width) {
      chunks.push(line.slice(index, index + width));
    }

    return chunks;
  }

  private escapePdfText(value: any): string {
    return String(value ?? '').replace(/[\\()]/g, '\\$&');
  }
}
