import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { ReceiptService } from './receipts/receipt.service';
import { enrichReceiptData } from './postprocess.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: ReceiptService,
          useValue: {},
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('accuracy metrics', () => {
    it('calculates field-level accuracy', () => {
      const result = appController.calculateAccuracyMetrics({
        expected: { vendor: { name: 'Red Store' }, totals: { total: 320.63 } },
        actual: { vendor: { name: 'Red Store' }, totals: { total: 320.63 } },
      });

      expect(result.field_accuracy).toBe(1);
      expect(result.precision).toBe(1);
      expect(result.recall).toBe(1);
    });
  });

  describe('bill content validation', () => {
    it('rejects a non-bill PDF-like document even when it has generic numbers', () => {
      const nonBillText = [
        'Project Assignment Web Based AI Receipt Scanner',
        'Objective',
        'Build a full stack web application that allows users to upload files.',
        'Section 1 Introduction',
        'The total number of requirements is 12 and the amount of effort varies.',
        'This document contains instructions and evaluation details.',
      ].join('\n');

      const result = (appController as any).validateReceiptLikeText(nonBillText, 100);

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/valid bill or ticket/i);
    });

    it('accepts a real receipt-like text with totals and payment signals', () => {
      const receiptText = [
        'REDSTORE',
        'Receipt No 989789',
        '1 XIOMI NOTE 5 $50.99',
        'SUBTOTAL $50.99',
        'TAX $5.00',
        'TOTAL $55.99',
        'VISA CHARGE $55.99',
      ].join('\n');

      const result = (appController as any).validateReceiptLikeText(receiptText, 100);

      expect(result.ok).toBe(true);
    });
  });

  describe('BMTC route parsing', () => {
    it('uses the English place above and below TO while skipping Kannada lines', () => {
      const rawText = [
        'Depot-29',
        'Ragigudda Temple',
        'TO',
        'Kannada text line',
        'Depot-25 Gate (Towards Hebbala)',
        'Ad: 1x Rs.15.00 = Rs.15.00',
        'Total: Rs.15.00 (CASH)',
        'Ordinary KA41D2747 Tkn No: 6384',
      ].join('\n');

      const result = enrichReceiptData({}, rawText);

      expect(result.document.type).toBe('ticket');
      expect(result.document.transport_type).toBe('bus');
      expect(result.travel.pickup_point).toBe('Ragigudda Temple');
      expect(result.travel.destination).toBe('Depot-25 Gate (Towards Hebbala)');
      expect(result.totals.total).toBe(15);
      expect(result.payment.amount).toBe(15);
      expect(result.payment.method).toBe('Cash');
    });

    it('skips noisy OCR between TO and the real English destination', () => {
      const rawText = [
        'Depot-29',
        'T No: 180',
        '14-04-2024',
        'Ragigudda Templo',
        'tO',
        'dwf.ox .w0 aupc 25',
        'Depot-25 Gate (Towards Hebbdla)',
        'Faro + G$T',
        'Ad: 1xRs.15.00.s Rs.15.00',
        'Totol:',
        'Ordinary',
      ].join('\n');

      const result = enrichReceiptData({}, rawText);

      expect(result.travel.pickup_point).toBe('Ragigudda Temple');
      expect(result.travel.destination).toBe('Depot-25 Gate (Towards Hebbdla)');
      expect(result.totals.total).toBe(15);
      expect(result.payment.amount).toBe(15);
    });

    it('treats any depot OCR as a BMTC bus ticket even if AI guessed another schema', () => {
      const rawText = [
        'Depot',
        'Kundalahalli Gate',
        'TO',
        'Whitefield TTMC (Vydehi Hospital)',
        'Total: Rs.18.00 (UPI)',
      ].join('\n');

      const result = enrichReceiptData({
        document: { type: 'receipt', transaction_type: 'refund', transport_type: '' },
        refund: { refund_amount: 18 },
      }, rawText);

      expect(result.document.type).toBe('ticket');
      expect(result.document.transport_type).toBe('bus');
      expect(result.travel.pickup_point).toBe('Kundalahalli Gate');
      expect(result.travel.destination).toBe('Whitefield (Vydehi Hospital)');
      expect(result.totals.total).toBe(18);
    });

    it('classifies BMTC Silk Board to Kadubeesanahalli ticket as bus ticket, not receipt', () => {
      const rawText = [
        'BMTC',
        'Depat-28',
        'T No: 189',
        '31-03-2026 11:58:00',
        'Central Silk Board /Towards Marathahalli',
        'TO',
        'Kadubeesanahalli',
        'Ad: 1x Rs.33.33 = Rs.33.33',
        'Fare + GST +1.67',
        'Total: Rs.35.00 (UPI)',
        'Vajra KA57F1278 Tkn No: 16644',
      ].join('\n');

      const result = enrichReceiptData({
        document: { type: 'receipt', transaction_type: 'purchase', transport_type: '' },
      }, rawText);

      expect(result.document.type).toBe('ticket');
      expect(result.document.transport_type).toBe('bus');
      expect(result.travel.pickup_point).toBe('Silk Board');
      expect(result.travel.destination).toBe('Kadubeesanahalli');
      expect(result.totals.total).toBe(35);
      expect(result.payment.method).toBe('UPI');
      expect(result.payment.amount).toBe(35);
    });
  });

  describe('product table parsing', () => {
    it('uses table columns instead of appending batch/date/hsn fields to product name', () => {
      const rawText = [
        'Sr. No. Name of Product / Service Batch No MFG Date Expiry Date HSN / SAC Qty MRP Rate Disc. (%) Taxable Value',
        '1 Paracetamol 500 mg A1 Dec 2024 Dec 2026 30045031 10 TBS 50.00 40.00 10.00 360.00',
        '2 Cough Syrup (200ml) 30045031 Jul 2023 Dec 2025 30045031 20 BTL 90.00 80.00 10.00 1,440.00',
        '3 Antibiotic Cream (30g) C23456 Jan 2022 Dec 2024 30042019 10 PKG 55.00 45.00 10.00 405.00',
        'IGST (12.00 %) 264.60',
        'Total 40 245.00 ₹ 2,469.60',
      ].join('\n');

      const result = enrichReceiptData({}, rawText);

      expect(result.items).toHaveLength(3);
      expect(result.items[0].name).toBe('Paracetamol 500 mg');
      expect(result.items[0].quantity).toBe(10);
      expect(result.items[0].unit_price).toBe(40);
      expect(result.items[0].total_price).toBe(360);
      expect(result.items[1].name).toBe('Cough Syrup (200ml)');
      expect(result.items[2].name).toBe('Antibiotic Cream (30g)');
      expect(result.items.some((item: any) => /total/i.test(item.name))).toBe(false);
    });

    it('extracts simple receipt rows with quantity, product name, and amount', () => {
      const rawText = [
        'REDSTORE',
        'RED STORE - 989789',
        '10/07/2020 05:25 PM',
        '1 XIOMI NOTE 5 $50.99',
        '1 SAMSUNG NOTE 7 $89.99',
        '1 I PHONE $150.5',
        'SUBTOTAL $291.48',
        'T = TAX $10.00% ON $291.48 $29.15',
        'TOTAL $320.63',
        'VISA***852 CHARGE $320.63',
      ].join('\n');

      const result = enrichReceiptData({}, rawText);

      expect(result.items).toHaveLength(3);
      expect(result.items[0]).toMatchObject({ name: 'XIOMI NOTE 5', quantity: 1, total_price: 50.99 });
      expect(result.items[1]).toMatchObject({ name: 'SAMSUNG NOTE 7', quantity: 1, total_price: 89.99 });
      expect(result.items[2]).toMatchObject({ name: 'I PHONE', quantity: 1, total_price: 150.5 });
      expect(result.items.some((item: any) => /RED STORE|989789|TOTAL/i.test(item.name))).toBe(false);
    });

    it('pairs split OCR product lines with the following amount-only line', () => {
      const rawText = [
        'REDSTORE',
        '1 XIOMI NOTE 5',
        '$50.99',
        '1 SAMSUNG NOTE 7',
        '$89.99',
        '1 I PHONE',
        '$150.50',
        'SUBTOTAL',
        '$291.48',
        'TOTAL',
        '$320.63',
      ].join('\n');

      const result = enrichReceiptData({}, rawText);

      expect(result.items).toHaveLength(3);
      expect(result.items.map((item: any) => item.name)).toEqual([
        'XIOMI NOTE 5',
        'SAMSUNG NOTE 7',
        'I PHONE',
      ]);
      expect(result.items.map((item: any) => item.total_price)).toEqual([50.99, 89.99, 150.5]);
    });
  });
});
