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
    '1. purchase receipt: grocery, shop, restaurant, food, pizza, health, medical, pharmacy, paracetamol, antibiotic, invoice, retail receipt, normal bill.',
    '2. fuel receipt: fuel pump bill or petrol/diesel bill. If OCR contains IndianOil, Indian Oil, Bharat Petroleum, Bharath Petroleum, BPCL, HPCL, petrol, diesel, density, pump, nozzle, litre, liter, or ltr with fuel context, classify as fuel receipt.',
    '3. travel ticket: bus/train/flight/taxi/auto ticket, fare ticket, boarding/travel document. If OCR contains a standalone TO line, route-like place names, fare/total Rs amount, depot, departure, arrival, boarding, PNR, IRCTC, railway, train, passanger/passenger, Ordinary, bus/operator text, or No: ticket number, classify as travel ticket, not receipt.',
    '4. refund receipt: refund, return, reversal, cancelled purchase, amount returned.',
    'Return the matching schema only. Do not mix schemas. Travel ticket fields should prioritize issuer, pickup_point, destination, total fare, and payment method.',
    'Fuel receipts must use the fuel schema with document.receipt_category = "fuel"; do not put fuel details in items.',
    'For bus tickets use travel.route and travel.ticket_number. For train tickets use travel.class and travel.PNR instead of route and ticket_number.',
    'For train tickets, travel.PNR must be the 10-digit PNR number. travel.class must be one of these railway class codes when present: 1A, 2A, 3A, 3E, EA, EC, CC, EV, VS, SL, FC, 2S, UR, GEN, GS.',
    'For train ticket journey stations, use only the layout section with headings Booked From, Boarding At, and To. pickup_point must be the value under Boarding At; if Boarding At is missing use Booked From. destination must be the value under To. Preserve station names and codes exactly, such as HOWRAH JN (HWH). Do not use city notes like (Howrah / Kolkata).',
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
