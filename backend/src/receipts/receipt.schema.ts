import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ReceiptDocument = Receipt & Document;

@Schema({ timestamps: true })
export class Receipt {
  @Prop({ required: true, unique: true })
  transactionId: string;

  @Prop({ default: 'processing' })
  status: string;

  @Prop()
  filePath: string;

  @Prop({ default: '' })
  originalName: string;

  @Prop({ default: '' })
  mimeType: string;

  @Prop({ default: '' })
  fileHash: string;

  @Prop({ default: '' })
  duplicateOfTransactionId: string;

  @Prop({ default: '' })
  vendorReceiptKey: string;

  @Prop({ default: '' })
  duplicateWarning: string;

  @Prop({ type: Object, default: {} })
  receiptData: any;

  @Prop({ default: '' })
  rawText: string;

  @Prop({ default: '' })
  error: string;
}

export const ReceiptSchema = SchemaFactory.createForClass(Receipt);

ReceiptSchema.index(
  { vendorReceiptKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      vendorReceiptKey: { $type: 'string', $gt: '' },
    },
  },
);

ReceiptSchema.index(
  { fileHash: 1 },
  {
    partialFilterExpression: {
      fileHash: { $type: 'string', $gt: '' },
    },
  },
);
