export async function processReceiptWithAI(rawText: string) {
  const cleanText = rawText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 1)
    .join('\n');
  const ocrForPrompt = cleanText.length > 4500 ? cleanText.slice(0, 4500) : cleanText;

  const prompt = [
    'Return ONLY valid JSON. No markdown. No explanation.',
    'The OCR may be English, Kannada, Malayalam, or Hindi. Translate labels and names to English where useful, but preserve all numbers, dates, ticket numbers, receipt numbers, routes, card suffixes, and currency exactly.',
    'Final JSON values must be English/ASCII text only. Do not output Kannada, Malayalam, Hindi, or other non-English scripts. If a value cannot be translated, leave it empty or keep only English/numeric parts.',
    'First classify the document into exactly one of these:',
    '1. purchase receipt: grocery, shop, store, restaurant, food, pizza, health, medical, pharmacy, paracetamol, antibiotic, invoice, retail receipt, normal bill. If OCR contains the word store anywhere, classify it as a grocery/purchase receipt unless it also has a stronger BMTC/fuel/refund signal.',
    '2. fuel receipt: fuel pump bill or petrol/diesel bill. If OCR contains IndianOil, Indian Oil, Bharat Petroleum, Bharath Petroleum, BPCL, HPCL, petrol, diesel, density, pump, nozzle, litre, liter, or ltr with fuel context, classify as fuel receipt.',
    '3. travel ticket: bus/train/flight/taxi/auto ticket, fare ticket, boarding/travel document. If OCR contains BMTC, depot, depat, dept, or a depot number anywhere, classify it as a BMTC/Bangalore bus travel ticket. Also classify as travel ticket if OCR contains a standalone TO line, route-like place names, fare/total Rs amount, departure, arrival, boarding, PNR, IRCTC, railway, train, passanger/passenger, Ordinary, bus/operator text, or No: ticket number.',
    '4. refund receipt: refund, return, reversal, cancelled purchase, amount returned.',
    'Return the matching schema only. Do not mix schemas. Travel ticket fields should prioritize issuer, pickup_point, destination, total fare, and payment method.',
    'Fuel receipts must use the fuel schema with document.receipt_category = "fuel"; do not put fuel details in items.',
    'For bus tickets use travel.route and travel.ticket_number. For train tickets use travel.class and travel.PNR instead of route and ticket_number.',
    'VERY IMPORTANT BMTC rule: if OCR contains depot, depat, dept, or a depot number anywhere, this is a BMTC/Bangalore bus travel ticket.',
    'VERY IMPORTANT BMTC layout rule: the pickup_point and destination are in the center part of the uploaded image around the standalone word TO. The nearest readable English place text above TO is pickup_point. If the nearest line above TO is Kannada/non-English/noisy, ignore it and keep scanning upward until the nearest readable English place name. The nearest readable English place text below TO is destination. If the first line below TO is Kannada/non-English/noisy, ignore it and keep scanning downward until the nearest readable English place name. Keep the place name exactly as OCR text when readable.',
    'VERY IMPORTANT BMTC amount rule: totals.total and payment.amount must come only from the two-digit rupee amount printed next to (CASH) or (UPI), for example Rs.15.00 (CASH) => 15 and Rs.35.00 (UPI) => 35. Do not use ticket number, phone number, depot number, route number, GST line, or fare math as total.',
    'For train tickets, travel.PNR must be the 10-digit PNR number. travel.class must be one of these railway class codes when present: 1A, 2A, 3A, 3E, EA, EC, CC, EV, VS, SL, FC, 2S, UR, GEN, GS.',
    'For train ticket journey stations, use only the layout section with headings Booked From, Boarding At, and To. pickup_point must be the value under Boarding At; if Boarding At is missing use Booked From. destination must be the value under To. Preserve station names and codes exactly, such as HOWRAH JN (HWH). Do not use city notes like (Howrah / Kolkata).',
    'For purchase receipts, extract item/product rows only when the row has a readable item name and a real amount/price. Never use receipt numbers, invoice numbers, dates, phone numbers, store IDs, card numbers, or transaction IDs as item prices. Never create a product row from a header such as store name + receipt number.',
    'For tabular product receipts with headings such as Name of Product / Service, Batch No, MFG Date, Expiry Date, HSN/SAC, Qty, MRP, Rate, Disc, Taxable Value: use only the text under Name of Product / Service as item.name. Put Qty under quantity, Rate under unit_price, and Taxable Value or row amount under total_price. Do not append batch number, manufacture date, expiry date, HSN/SAC, MRP, rate, discount, or totals to item.name. Ignore rows labeled Total, IGST, CGST, SGST, tax, subtotal, or grand total as products.',
    'Do not invent values. If a field is not present or not readable in OCR, keep it as an empty string, 0, or [] according to the schema. Keep vendor names, product names, station names, pickup, and destination exactly as OCR text when readable.',
    'Use empty strings for missing text, 0 for missing numbers, [] for missing arrays. Always include totals.discounts as an array. Discount amounts must be positive numbers and totals.total must be the final amount after subtracting discounts.',
    '',
    'Schema for purchase receipt:',
    JSON.stringify({
      document: { type: 'receipt', transaction_type: 'purchase', transport_type: '' },
      vendor: { name: '', address: '', phone: '' },
      transaction: { date: '', time: '', receipt_number: '', currency: '' },
      items: [{ name: '', quantity: 1, unit_price: 0, total_price: 0, category: '' }],
      totals: { subtotal: 0, tax: 0, discounts: [], total: 0 },
      payment: { method: '', amount: 0 },
      raw_text: '',
    }),
    '',
    'Schema for fuel receipt:',
    JSON.stringify({
      document: { type: 'receipt', receipt_category: 'fuel', transaction_type: 'purchase', transport_type: '' },
      vendor: { name: '', address: '' },
      transaction: { date: '', time: '', receipt_number: '', currency: 'INR' },
      fuel: { product: '', quantity: 0, unit: 'Litre', rate_per_unit: 0 },
      payment: { method: '', amount: 0 },
      totals: { subtotal: 0, discounts: [], total: 0 },
      raw_text: '',
    }),
    '',
    'Schema for bus travel ticket:',
    JSON.stringify({
      document: { type: 'ticket', transaction_type: 'purchase', transport_type: 'bus' },
      issuer: { name: '', address: '', phone: '' },
      travel: { pickup_point: '', destination: '', route: '', ticket_number: '' },
      transaction: { date: '', time: '', currency: '' },
      totals: { subtotal: 0, discounts: [], total: 0 },
      payment: { method: '', amount: 0 },
      raw_text: '',
    }),
    '',
    'Schema for train travel ticket:',
    JSON.stringify({
      document: { type: 'ticket', transaction_type: 'purchase', transport_type: 'train' },
      issuer: { name: '', address: '', phone: '' },
      travel: { pickup_point: '', destination: '', class: '', PNR: '' },
      transaction: { date: '', time: '', currency: '' },
      totals: { subtotal: 0, discounts: [], total: 0 },
      payment: { method: '', amount: 0 },
      raw_text: '',
    }),
    '',
    'Schema for refund receipt:',
    JSON.stringify({
      document: { type: 'receipt', transaction_type: 'refund', transport_type: '' },
      vendor: { name: '', address: '', phone: '' },
      transaction: { date: '', time: '', receipt_number: '', original_receipt_number: '', currency: '' },
      items: [{ name: '', quantity: 1, unit_price: 0, refund_amount: 0, reason: '' }],
      refund: { refund_method: '', refund_amount: 0 },
      totals: { subtotal: 0, discounts: [], total: 0 },
      raw_text: '',
    }),
    '',
    'OCR:',
    ocrForPrompt,
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 10000));
  const ollamaUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');

  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'llama3.1',
      prompt,
      stream: false,
      keep_alive: '10m',
      options: {
        temperature: 0,
        num_predict: Number(process.env.AI_NUM_PREDICT || 1200),
        num_ctx: Number(process.env.AI_NUM_CTX || 3072),
      },
    }),
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    throw new Error('AI model request failed with status ' + response.status);
  }

  const data = await response.json();

  if (!data.response) {
    throw new Error('No response received from AI model');
  }

  const cleaned = data.response
    .replace(/`{3}json/g, '')
    .replace(/`{3}/g, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error('AI did not return valid JSON');
  }

  const jsonOnly = cleaned.substring(firstBrace, lastBrace + 1);

  let parsed: any;

  try {
    parsed = JSON.parse(jsonOnly);
  } catch {
    throw new Error('AI returned broken JSON');
  }

  parsed.raw_text = cleanText;

  return JSON.stringify(parsed);
}
