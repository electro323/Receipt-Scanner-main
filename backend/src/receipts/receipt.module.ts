import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Receipt, ReceiptSchema } from './receipt.schema';
import { ReceiptService } from './receipt.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Receipt.name,
        schema: ReceiptSchema,
      },
    ]),
  ],
  providers: [ReceiptService],
  exports: [ReceiptService],
})
export class ReceiptModule {}