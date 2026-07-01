import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs/promises';

import {
  Receipt,
  ReceiptDocument,
} from './receipt.schema';

@Injectable()
export class ReceiptService implements OnModuleInit {
  constructor(
    @InjectModel(Receipt.name)
    private receiptModel: Model<ReceiptDocument>,
  ) {}

  async onModuleInit() {
    await this.ensureReceiptIndexes();
  }

  private async ensureReceiptIndexes() {
    try {
      const indexes = await this.receiptModel.collection.indexes();
      const hasLegacyGlobalVendorIndex = indexes.some((index) => index.name === 'vendorReceiptKey_1');

      if (hasLegacyGlobalVendorIndex) {
        await this.receiptModel.collection.dropIndex('vendorReceiptKey_1');
      }

      await this.receiptModel.collection.createIndex(
        { userId: 1, vendorReceiptKey: 1 },
        {
          name: 'userId_1_vendorReceiptKey_1',
          unique: true,
          partialFilterExpression: {
            vendorReceiptKey: { $type: 'string', $gt: '' },
          },
        },
      );
    } catch (error) {
      console.error('Receipt index repair failed:', error);
    }
  }

  async createReceipt(
    transactionId: string,
    filePath: string,
    originalName = '',
    mimeType = '',
    fileHash = '',
    userId = 'anonymous',
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
      userId,
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

  async countUserUploadsSince(
    userId: string,
    since: Date,
  ) {
    return this.receiptModel.countDocuments({
      userId,
      createdAt: { $gte: since },
      status: { $ne: 'cancelled' },
    });
  }

  async findDuplicateByFileHash(
    fileHash: string,
    userId = 'anonymous',
    transactionId = '',
  ) {
    if (!fileHash) return null;

    return this.receiptModel.findOne({
      fileHash,
      ...this.userScopeQuery(userId),
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
    const currentReceipt = await this.receiptModel.findOne({ transactionId });
    const duplicateWarning = await this.deleteOlderDuplicate(
      transactionId,
      vendorReceiptKey,
      currentReceipt?.userId || 'anonymous',
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

  async findAll(userId = '') {
    const query = userId ? this.userScopeQuery(userId) : {};
    return this.receiptModel.find(query).sort({ createdAt: -1 });
  }

  async getMonthlyCategoryAnalytics(
    userId: string,
    month = '',
  ) {
    const selectedMonth = /^\d{4}-\d{2}$/.test(month)
      ? month
      : new Date().toISOString().slice(0, 7);
    const start = new Date(selectedMonth + '-01T00:00:00.000Z');
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);

    const receipts = await this.receiptModel.find({
      ...this.userScopeQuery(userId),
      status: 'completed',
      createdAt: { $gte: start, $lt: end },
    });

    const categoryTotals: Record<string, { category: string; total: number; count: number }> = {};
    let receiptCount = 0;

    for (const receipt of receipts) {
      const data = receipt.receiptData || {};
      const total = this.asNumber(data?.totals?.total || data?.payment?.amount || data?.refund?.refund_amount);

      if (!total) continue;

      receiptCount++;

      if (data?.document?.type === 'ticket') {
        this.addCategoryTotal(categoryTotals, 'Travel', total);
        continue;
      }

      if (data?.document?.receipt_category === 'fuel' || data?.fuel) {
        this.addCategoryTotal(categoryTotals, 'Fuel', total);
        continue;
      }

      if (data?.document?.transaction_type === 'refund') {
        this.addCategoryTotal(categoryTotals, 'Refunds', -Math.abs(total));
        continue;
      }

      const items = Array.isArray(data?.items) ? data.items : [];
      const itemRows = items
        .map((item: any) => ({
          category: this.normalizeCategory(item?.category || this.inferCategory(item?.name || '')),
          total: this.asNumber(item?.total_price || item?.amount || (this.asNumber(item?.quantity) * this.asNumber(item?.unit_price))),
        }))
        .filter((item: any) => item.total > 0);

      const itemTotal = itemRows.reduce((sum: number, item: any) => sum + item.total, 0);

      if (itemRows.length && itemTotal > 0) {
        const scale = total / itemTotal;
        for (const item of itemRows) {
          this.addCategoryTotal(categoryTotals, item.category, item.total * scale);
        }
      } else {
        this.addCategoryTotal(categoryTotals, 'General', total);
      }
    }

    const totalSpending = Object.values(categoryTotals)
      .reduce((sum, row) => sum + row.total, 0);
    const categories = Object.values(categoryTotals)
      .map((row) => ({
        category: row.category,
        total: Number(row.total.toFixed(2)),
        count: row.count,
        percentage: totalSpending ? Number(((row.total / totalSpending) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    return {
      month: selectedMonth,
      userId,
      receiptCount,
      total: Number(totalSpending.toFixed(2)),
      currency: 'INR',
      categories,
    };
  }

  async updateReceiptData(
    transactionId: string,
    receiptData: any,
  ) {
    const vendorReceiptKey = this.buildVendorReceiptKey(receiptData);
    const currentReceipt = await this.receiptModel.findOne({ transactionId });
    const duplicateWarning = await this.deleteOlderDuplicate(
      transactionId,
      vendorReceiptKey,
      currentReceipt?.userId || 'anonymous',
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
    userId: string,
  ): Promise<string> {
    if (!vendorReceiptKey) return '';

    const existing = await this.receiptModel.findOne({
      transactionId: { $ne: transactionId },
      vendorReceiptKey,
      ...this.userScopeQuery(userId),
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

  private userScopeQuery(userId: string) {
    return {
      $or: [
        { userId },
        { userId: { $exists: false } },
        { userId: '' },
        { userId: 'anonymous' },
      ],
    };
  }

  private addCategoryTotal(
    categoryTotals: Record<string, { category: string; total: number; count: number }>,
    category: string,
    amount: number,
  ) {
    const normalized = this.normalizeCategory(category);
    categoryTotals[normalized] ??= { category: normalized, total: 0, count: 0 };
    categoryTotals[normalized].total += amount;
    categoryTotals[normalized].count++;
  }

  private normalizeCategory(value: string): string {
    const clean = String(value || '').trim();
    if (!clean) return 'General';

    return clean
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private inferCategory(name: string): string {
    const text = String(name || '').toLowerCase();

    if (/petrol|diesel|fuel|pump/.test(text)) return 'Fuel';
    if (/medicine|medical|pharmacy|tablet|paracetamol|antibiotic|health/.test(text)) return 'Medical';
    if (/pizza|food|restaurant|meal|burger|rice|tea|coffee/.test(text)) return 'Food';
    if (/bus|train|ticket|fare|travel/.test(text)) return 'Travel';

    return 'General';
  }

  private asNumber(value: any): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
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
