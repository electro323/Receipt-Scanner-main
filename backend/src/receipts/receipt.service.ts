import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs/promises';

import {
  Receipt,
  ReceiptDocument,
} from './receipt.schema';

@Injectable()
export class ReceiptService {
  constructor(
    @InjectModel(Receipt.name)
    private receiptModel: Model<ReceiptDocument>,
  ) {}

  async createReceipt(
    transactionId: string,
    filePath: string,
    originalName = '',
    mimeType = '',
    fileHash = '',
    status = 'processing',
    duplicateOfTransactionId = '',
  ) {
    return this.receiptModel.create({
      transactionId,
      status,
      filePath,
      originalName,
      mimeType,
      fileHash,
      duplicateOfTransactionId,
      vendorReceiptKey: '',
      duplicateWarning: duplicateOfTransactionId
        ? 'This exact bill was already uploaded as transaction ' + duplicateOfTransactionId + '. Replace the old bill or cancel this upload.'
        : '',
      receiptData: {},
      rawText: '',
      error: '',
    });
  }

  async findDuplicateByFileHash(
    fileHash: string,
    transactionId = '',
  ) {
    if (!fileHash) return null;

    return this.receiptModel.findOne({
      fileHash,
      transactionId: transactionId ? { $ne: transactionId } : { $exists: true },
      status: { $ne: 'cancelled' },
    }).sort({ createdAt: -1 });
  }

  async saveOCR(
    transactionId: string,
    rawText: string,
  ) {
    return this.receiptModel.findOneAndUpdate(
      { transactionId },
      { rawText },
      { returnDocument: 'after' },
    );
  }

  async saveAIResult(
    transactionId: string,
    receiptData: any,
  ) {
    const vendorReceiptKey = this.buildVendorReceiptKey(receiptData);
    const duplicateWarning = await this.deleteOlderDuplicate(
      transactionId,
      vendorReceiptKey,
    );

    return this.receiptModel.findOneAndUpdate(
      { transactionId },
      {
        receiptData,
        status: 'completed',
        vendorReceiptKey,
        duplicateWarning,
        error: '',
      },
      { returnDocument: 'after' },
    );
  }

  async markFailed(
    transactionId: string,
    error: string,
  ) {
    return this.receiptModel.findOneAndUpdate(
      { transactionId },
      {
        status: 'failed',
        error,
      },
      { returnDocument: 'after' },
    );
  }

  async findByTransactionId(
    transactionId: string,
  ) {
    return this.receiptModel.findOne({ transactionId });
  }

  async saveFileHash(
    transactionId: string,
    fileHash: string,
  ) {
    return this.receiptModel.findOneAndUpdate(
      { transactionId },
      { fileHash },
      { returnDocument: 'after' },
    );
  }

  async confirmDuplicateReplacement(
    transactionId: string,
  ) {
    const duplicate = await this.receiptModel.findOne({ transactionId });

    if (!duplicate) return null;

    const oldTransactionId = duplicate.duplicateOfTransactionId;

    if (oldTransactionId) {
      const existing = await this.receiptModel.findOne({ transactionId: oldTransactionId });

      if (existing) {
        await this.deleteStoredFiles(existing.filePath);
        await this.receiptModel.deleteOne({ _id: existing._id });
      }
    }

    return this.receiptModel.findOneAndUpdate(
      { transactionId },
      {
        status: 'processing',
        duplicateOfTransactionId: '',
        duplicateWarning: oldTransactionId
          ? 'This exact bill was already uploaded. Transaction ' + oldTransactionId + ' was deleted and replaced.'
          : '',
        error: '',
      },
      { returnDocument: 'after' },
    );
  }

  async cancelDuplicateUpload(
    transactionId: string,
  ) {
    const receipt = await this.receiptModel.findOne({ transactionId });

    if (!receipt) return null;

    await this.deleteStoredFiles(receipt.filePath);
    await this.receiptModel.deleteOne({ _id: receipt._id });

    return {
      transactionId,
      status: 'cancelled',
      message: 'Duplicate upload cancelled. The existing bill was kept.',
    };
  }

  async findAll() {
    return this.receiptModel.find().sort({ createdAt: -1 });
  }

  async updateReceiptData(
    transactionId: string,
    receiptData: any,
  ) {
    const vendorReceiptKey = this.buildVendorReceiptKey(receiptData);
    const duplicateWarning = await this.deleteOlderDuplicate(
      transactionId,
      vendorReceiptKey,
    );

    return this.receiptModel.findOneAndUpdate(
      { transactionId },
      {
        receiptData,
        vendorReceiptKey,
        duplicateWarning,
        status: 'completed',
        error: '',
      },
      { returnDocument: 'after' },
    );
  }

  private async deleteOlderDuplicate(
    transactionId: string,
    vendorReceiptKey: string,
  ): Promise<string> {
    if (!vendorReceiptKey) return '';

    const existing = await this.receiptModel.findOne({
      transactionId: { $ne: transactionId },
      vendorReceiptKey,
    });

    if (!existing) return '';

    await this.deleteStoredFiles(existing.filePath);
    await this.receiptModel.deleteOne({ _id: existing._id });

    return 'This receipt was already uploaded. The older transaction was deleted and replaced.';
  }

  private buildVendorReceiptKey(receiptData: any): string {
    if (receiptData?.document?.type === 'ticket') {
      const issuerName = receiptData?.issuer?.name || receiptData?.vendor?.name || receiptData?.document?.transport_type || 'travel';
      const ticketId = receiptData?.travel?.PNR || receiptData?.travel?.ticket_number || '';

      if (!ticketId) return '';

      return 'ticket::' + this.normalizeKeyPart(issuerName) + '::' + this.normalizeKeyPart(ticketId);
    }

    const prefix = receiptData?.document?.receipt_category === 'fuel' ? 'fuel::' : '';
    const vendorName = receiptData?.vendor?.name || receiptData?.vendor?.customer || '';
    const receiptNumber = receiptData?.transaction?.receipt_number || '';

    if (!vendorName || !receiptNumber) return '';

    return prefix + this.normalizeKeyPart(vendorName) + '::' + this.normalizeKeyPart(receiptNumber);
  }

  private normalizeKeyPart(value: string): string {
    return String(value)
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9\u0C80-\u0CFF\u0D00-\u0D7F\u0900-\u097F]+/g, '');
  }

  private async deleteStoredFiles(filePath?: string) {
    if (!filePath) return;

    const suffixes = [
      '',
      '.jpg',
      '-normalized.png',
      '-contrast.png',
      '-bright.png',
      '-threshold.png',
      '-clean.png',
      '-high-contrast.png',
      '-shadow-lift.png',
      '-denoise.png',
      '-bw.png',
      '-original-clean.png',
      '.jpg-normalized.png',
      '.jpg-contrast.png',
      '.jpg-bright.png',
      '.jpg-threshold.png',
      '.jpg-clean.png',
      '.jpg-high-contrast.png',
      '.jpg-shadow-lift.png',
      '.jpg-denoise.png',
      '.jpg-bw.png',
      '.jpg-original-clean.png',
    ];

    const candidates = suffixes.map((suffix) => filePath + suffix);

    await Promise.all(
      candidates.map(async (candidate) => {
        try {
          await fs.unlink(candidate);
        } catch {
          // Converted and processed variants may not exist.
        }
      }),
    );
  }
}
