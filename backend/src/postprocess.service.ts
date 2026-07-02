function asNumber(value: any): number {
  const parsed = Number(
    String(value ?? 0)
      .replace(/[$\u20B9,]/g, '')
      .replace(/Rs\.?/gi, '')
      .replace(/INR/gi, '')
      .trim(),
  );

  return Number.isFinite(parsed) ? parsed : 0;
}

function hasTravelTicketSignals(rawText: string): boolean {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => cleanPlaceName(line).toLowerCase())
    .filter(Boolean);

  const hasStandaloneTo = lines.some((line) => line === 'to' || line.startsWith('to '));
  const hasBmtc = hasBmtcSignal(rawText);
  const hasDepot = hasDepotSignal(rawText);
  const hasHardTravelWord = /\b(passanger|passenger|depot|departure|arrival|boarding|pnr|irctc|railway|train)\b/i.test(rawText) || hasBmtc;
  const hasFareAmount = /(?:fare|total|amount|ad)\s*[;:=\- ]*\s*(?:1x)?\s*(?:Rs\.?|INR|\u20B9)\s*\d+/i.test(rawText);
  const hasTicketNumber = /\b(?:ticket|pnr|booking|ordinary|trip|journey|train)\b\s*[:#-]?\s*[A-Z0-9][A-Z0-9\/-]{2,}/i.test(rawText);
  const hasTransportWord = /\b(bus|ksrtc|bmtc|bmrtc|ordinary|passanger|passenger|route|pickup|destination|departure|arrival|boarding|pnr|irctc|railway|train|from|fare|journey|ticket|depot|dept)\b/i.test(rawText);
  const hasRoutePlaces = hasStandaloneTo && lines.some((line) => /gate|field|hospital|stand|station|terminal|stop|road|circle|cross|depot|dept|market|temple|layout|ttmc/.test(line));

  const score = [hasStandaloneTo, hasFareAmount, hasTicketNumber, hasTransportWord, hasRoutePlaces, hasDepot, hasBmtc, hasHardTravelWord]
    .filter(Boolean)
    .length;

  return hasHardTravelWord || (hasBmtc && hasStandaloneTo) || score >= 2 || (hasStandaloneTo && hasFareAmount);
}

function hasDepotSignal(rawText: string): boolean {
  return /\b(?:depot|dep[o0a]t|dept)\s*[-:]?\s*\d*\b/i.test(rawText);
}

function hasBmtcSignal(rawText: string): boolean {
  return /\b(?:bmtc|bmrtc|bmtc\b|bangalore metropolitan|ordinary\s+kas|kas\d)\b/i.test(rawText)
    || hasDepotSignal(rawText);
}

function hasFuelBillSignals(rawText: string): boolean {
  const hasBrand = /\b(indian\s*oil|indianoil|bharat\s*petroleum|bharath\s*petroleum|bpcl|hindustan\s*petroleum|hpcl)\b/i.test(rawText);
  const hasFuelProduct = /\b(petrol|diesel|fuel)\b/i.test(rawText);
  const hasFuelStationSignal = /\b(density|pump|nozzle|litre|liter|litres|liters|ltr)\b/i.test(rawText);

  return hasBrand || (hasFuelProduct && hasFuelStationSignal);
}

function hasPurchaseReceiptSignals(rawText: string): boolean {
  return /\b(pizza|food|restaurant|health|paracetamol|antibiotic|pharmacy|medical|grocery|super\s*market|supermarket|mart|store|fresh|retail|invoice|receipt|cash\s*memo|tax\s*invoice|subtotal|gst|cgst|sgst|mrp)\b/i.test(rawText);
}

function detectDocumentKind(data: any, rawText: string): 'purchase' | 'ticket' | 'refund' | 'fuel' {
  const text = rawText.toLowerCase();
  const doc = data?.document || {};

  if (hasBmtcSignal(rawText) || hasTravelTicketSignals(rawText)) {
    return 'ticket';
  }

  if (
    hasFuelBillSignals(rawText) ||
    doc.receipt_category === 'fuel' ||
    data?.fuel ||
    data?.vendor?.customer ||
    (data?.items || []).some((item: any) => /fuel|petrol|diesel/i.test(String(item.category || item.name || '')))
  ) {
    return 'fuel';
  }

  if (
    hasPurchaseReceiptSignals(rawText) &&
    !/\b(passanger|passenger|depot|dept|departure|arrival|boarding|pnr|irctc|railway|train|bus|ksrtc|bmtc|bmrtc)\b/i.test(rawText)
  ) {
    return 'purchase';
  }

  if (hasTravelTicketSignals(rawText)) {
    return 'ticket';
  }

  if (doc.type === 'ticket' || data?.travel || /ticket|pnr|boarding|journey|pickup|destination|departure|arrival|route|bus|train|flight|fare|passanger|passenger|depot|seat|\bto\b/i.test(text)) {
    return 'ticket';
  }

  if (doc.transaction_type === 'refund' || /refund|returned|return receipt|reversal|cancelled|credited|amount returned/i.test(rawText)) {
    return 'refund';
  }

  return 'purchase';
}

function detectTransportType(data: any, rawText: string): string {
  const existing = data?.document?.transport_type || '';
  if (hasBmtcSignal(rawText)) return 'bus';
  if (existing) return existing;
  if (/train|railway|pnr|irctc|boarding|departure|arrival/i.test(rawText)) return 'train';
  if (/flight|airline|airport|boarding pass/i.test(rawText)) return 'flight';
  if (/taxi|cab|uber|ola|auto/i.test(rawText)) return 'taxi';
  if (/bus|ksrtc|bmtc|bmrtc|route|ordinary|depot|dept/i.test(rawText)) return 'bus';
  return '';
}

function fillCommonTransaction(transaction: any, rawText: string) {
  transaction ??= {};
  transaction.date ??= '';
  transaction.time ??= '';
  transaction.currency ??= '';

  const dateMatch = rawText.match(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b/);
  if (!transaction.date && dateMatch) transaction.date = dateMatch[0];

  const timeMatch = rawText.match(/\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?\b/i);
  if (!transaction.time && timeMatch) transaction.time = timeMatch[0];

  if (!transaction.currency) {
    if (/Rs\.?|\u20B9|INR/i.test(rawText)) transaction.currency = 'INR';
    else if (rawText.includes('$')) transaction.currency = 'USD';
  }

  return transaction;
}

function fillPayment(payment: any, total: number, rawText: string) {
  payment ??= {};
  payment.method ??= '';
  payment.amount = asNumber(payment.amount) || total || 0;

  if (/visa/i.test(rawText)) payment.method = payment.method || 'Visa';
  else if (/mastercard/i.test(rawText)) payment.method = payment.method || 'Mastercard';
  else if (/amex/i.test(rawText)) payment.method = payment.method || 'Amex';
  else if (/upi/i.test(rawText)) payment.method = payment.method || 'UPI';
  else if (/cash/i.test(rawText)) payment.method = payment.method || 'Cash';

  const cardSuffix = rawText.match(/(?:visa|mastercard|amex|card).*?(\*{2,}|x{2,}|\d{4})\s*(\d{4})/i);
  if (cardSuffix && !/\d{4}/.test(payment.method)) {
    payment.method = (payment.method || 'Card') + ' ****' + cardSuffix[2];
  }

  return payment;
}

function findTotal(rawText: string): number {
  const totalMatches = [...rawText.matchAll(/(?:grand\s+total|total)\s*(?:amount|fare|paid|collected|refund)?\s*[;:=\- ]*\s*(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.\d{1,2})?)/gi)];
  if (totalMatches.length) return asNumber(totalMatches[totalMatches.length - 1][1]);

  const fallbackMatches = [...rawText.matchAll(/(?:net amount|amount paid|refund amount|fare)\s*[;:=\- ]*\s*(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.\d{1,2})?)/gi)];
  return fallbackMatches.length ? asNumber(fallbackMatches[fallbackMatches.length - 1][1]) : 0;
}

function findSubtotal(rawText: string): number {
  const subtotalMatches = [...rawText.matchAll(/(?:subtotal|sub\s*total)\s*[;:=\- ]*\s*(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.\d{1,2})?)/gi)];
  return subtotalMatches.length ? asNumber(subtotalMatches[subtotalMatches.length - 1][1]) : 0;
}

function findTax(rawText: string): number {
  const taxLines = rawText
    .split(/\r?\n/)
    .filter((line) => /\b(tax|gst|cgst|sgst|igst|vat)\b/i.test(line));

  for (const line of taxLines.reverse()) {
    const amounts = [...line.matchAll(/(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.\d{1,2})?)/g)]
      .map((match) => asNumber(match[1]))
      .filter((value) => value > 0);

    if (amounts.length) return amounts[amounts.length - 1];
  }

  return 0;
}

function normalizeDiscounts(discounts: any[] = [], rawText = '') {
  const normalized = discounts
    .map((discount: any) => ({
      type: discount.type || discount.kind || 'discount',
      description: discount.description || discount.name || discount.label || '',
      amount: asNumber(discount.amount || discount.value),
    }))
    .filter((discount: any) => discount.amount > 0);

  if (normalized.length) return normalized;

  return [...rawText.matchAll(/(?:discount|coupon|offer|promo|savings?|less)\s*[:#-]?\s*([A-Za-z0-9 %/-]*?)\s*(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.\d{1,2})?)/gi)]
    .map((match) => ({
      type: /coupon/i.test(match[0]) ? 'coupon' : 'discount',
      description: cleanEnglishText(match[1] || match[0]).slice(0, 80),
      amount: asNumber(match[2]),
    }))
    .filter((discount) => discount.amount > 0);
}

function sumDiscounts(discounts: any[]): number {
  return discounts.reduce((sum, discount) => sum + asNumber(discount.amount), 0);
}

function findReceiptNumber(rawText: string): string {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/\b(?:receipt|invoice|bill|txn|transaction|rec|voucher|slip)(?:[ \t]*(?:no|number))?\b[ \t]*[:#-]?[ \t]*([A-Z0-9][A-Z0-9\/-]{2,})|\b(?:no|number)\b[ \t]*[:#-]?[ \t]*([A-Z0-9][A-Z0-9\/-]{2,})|#[ \t]*([A-Z0-9][A-Z0-9\/-]{2,})/i);
    const value = match?.[1] || match?.[2] || match?.[3] || '';

    if (value && !/\b(receipt|invoice|bill|txn|transaction|number|voucher|slip)\b/i.test(value)) {
      return value;
    }
  }

  return '';
}

function extractFuelVendor(rawText: string): string {
  if (/indian\s*oil|indianoil/i.test(rawText)) return 'Indian Oil';
  if (/bharat\s*petroleum|bharath\s*petroleum|bpcl/i.test(rawText)) return 'Bharat Petroleum';
  if (/hindustan\s*petroleum|hpcl/i.test(rawText)) return 'Hindustan Petroleum';

  const pumpMatch = rawText.match(/^(.{3,60}?\b(?:petroleum|fuel|pump|service station)\b.*)$/im);
  return cleanPlaceName(pumpMatch?.[1] || '');
}

function detectFuelName(rawText: string): string {
  if (/\bdiesel\b/i.test(rawText)) return 'Diesel';
  if (/\bpetrol\b/i.test(rawText)) return 'Petrol';
  return 'Fuel';
}

function findFuelQuantity(rawText: string): number {
  const labeledMatch = rawText.match(/(?:qty|quantity|volume|litres?|liters?|ltr)\s*[:=-]?\s*([0-9,]+(?:\.\d+)?)/i);
  if (labeledMatch) return asNumber(labeledMatch[1]);

  const unitMatch = rawText.match(/([0-9,]+(?:\.\d+)?)\s*(?:l|ltr|litre|liter|litres|liters)\b/i);
  return unitMatch ? asNumber(unitMatch[1]) : 0;
}

function findFuelUnitPrice(rawText: string): number {
  const labeledMatch = rawText.match(/(?:rate|price|unit\s*price)\s*[:=-]?\s*(?:Rs\.?|INR|\u20B9)?\s*([0-9,]+(?:\.\d{1,2})?)/i);
  if (labeledMatch) return asNumber(labeledMatch[1]);

  const perLitreMatch = rawText.match(/(?:Rs\.?|INR|\u20B9)?\s*([0-9,]+(?:\.\d{1,2})?)\s*\/\s*(?:l|ltr|litre|liter)\b/i);
  return perLitreMatch ? asNumber(perLitreMatch[1]) : 0;
}

function findTrainTicketTotal(rawText: string): number {
  const preferredMatch = rawText.match(/(?:total collected fare|total fare|total refund amount|total)\s*[;:=\- ]*\s*(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.\d{1,2})?)/i);
  if (preferredMatch) return asNumber(preferredMatch[1]);

  const nonRefundFare = [...rawText.matchAll(/^(?!.*refund)(?!.*cancellation).*?(?:fare|amount paid)\s*[;:=\- ]*\s*(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.\d{1,2})?)/gim)];
  return nonRefundFare.length ? asNumber(nonRefundFare[0][1]) : findTotal(rawText);
}

function normalizeBmtcFareAmount(value: number, rawText: string): number {
  if (!isBmtcTicket(rawText) || value <= 0) return value;

  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 2) return value;

  return Number(digits.slice(0, 2));
}

function isBmtcTicket(rawText: string): boolean {
  return hasBmtcSignal(rawText);
}

function findBmtcFareTotal(rawText: string): number {
  if (!isBmtcTicket(rawText)) return findTotal(rawText);

  const paymentLine = rawText
    .split(/\r?\n/)
    .find((line) => /\b(cash|upi)\b/i.test(line) && /(?:Rs\.?|INR|\u20B9)?\s*[0-9,]+(?:\.\d{1,2})?/i.test(line));

  if (paymentLine) {
    const amounts = [...paymentLine.matchAll(/(?:Rs\.?|INR|\u20B9)?\s*([0-9,]+(?:\.\d{1,2})?)/gi)]
      .map((match) => asNumber(match[1]))
      .filter((amount) => amount > 0);
    if (amounts.length) return normalizeBmtcFareAmount(amounts[amounts.length - 1], rawText);
  }

  const cashOrUpiMatch = rawText.match(/(?:Rs\.?|INR|\u20B9)?\s*([0-9,]+(?:\.\d{1,2})?)\s*\(?\s*(?:cash|upi)\s*\)?/i);
  if (cashOrUpiMatch) return normalizeBmtcFareAmount(asNumber(cashOrUpiMatch[1]), rawText);

  const fareLine = rawText
    .split(/\r?\n/)
    .find((line) => /\b(ad|fare|total)\b/i.test(line) && /(?:Rs\.?|INR|\u20B9)\s*[0-9,]+(?:\.\d{1,2})?/i.test(line));

  if (fareLine) {
    const amounts = [...fareLine.matchAll(/(?:Rs\.?|INR|\u20B9)\s*([0-9,]+(?:\.\d{1,2})?)/gi)]
      .map((match) => asNumber(match[1]))
      .filter((amount) => amount > 0);
    if (amounts.length) return normalizeBmtcFareAmount(amounts[amounts.length - 1], rawText);
  }

  const value = findTotal(rawText);

  return normalizeBmtcFareAmount(value, rawText);
}

function canonicalizeBmtcPlace(value: string): string {
  return cleanPlaceName(value).replace(/\s+\(/g, ' (').trim();
}

function isRouteNoiseLine(value: string): boolean {
  const cleaned = cleanPlaceName(value);

  return (
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(cleaned) ||
    /\b(?:research\.?digital|digital|photo|image|screenshot)\b/i.test(cleaned) ||
    /\b20\d{2}\b/.test(cleaned) ||
    /\b\d{1,2}[:.]\d{2}\b/.test(cleaned) ||
    /^[,.\s-]*[A-Za-z]{1,3}[,.\s-]*$/.test(cleaned)
  );
}

function isDepotOnlyLine(value: string): boolean {
  return /^\s*(?:depot|dep[o0a]t|dept)\s*[-:]?\s*\d+\s*$/i.test(cleanPlaceName(value));
}

function cleanPlaceName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9 .,&()/-]/g, ' ')
    .replace(/\s*\/\s*towards\b.*$/i, '')
    .replace(/\b(Res|Ad|Total|Ordinary|UPI|Cash|Card|No)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanEnglishText(value: any): any {
  if (typeof value !== 'string') return value;

  return value
    .replace(/[\u0C80-\u0CFF\u0D00-\u0D7F\u0900-\u097F]+/g, ' ')
    .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function cleanEnglishRawText(rawText: string): string {
  return rawText
    .split(/\r?\n/)
    .map((line) => cleanEnglishText(line))
    .filter((line) => /[A-Za-z0-9]/.test(line))
    .join('\n');
}

function enforceEnglishJson(value: any): any {
  if (Array.isArray(value)) {
    return value.map((item) => enforceEnglishJson(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [
        key,
        key === 'raw_text' ? cleanEnglishRawText(String(childValue ?? '')) : enforceEnglishJson(childValue),
      ]),
    );
  }

  return cleanEnglishText(value);
}

function isUsefulPlaceLine(line: string): boolean {
  const cleaned = cleanPlaceName(line);
  const hasPlaceShape =
    /[A-Z][a-z]{2,}/.test(cleaned) ||
    /[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(cleaned) ||
    /\b(gate|field|hospital|stand|station|terminal|stop|road|circle|cross|depot|market|junction|bridge|hall)\b/i.test(cleaned) ||
    /^[A-Z][A-Z ]{6,}$/.test(cleaned);

  return /[A-Za-z]{3,}/.test(cleaned)
    && hasPlaceShape
    && !isRouteNoiseLine(cleaned)
    && !isDepotOnlyLine(cleaned)
    && bmtcPlaceConfidence(cleaned) >= 5
    && !/(total|amount|fare|rs\.?|upi|ordinary|ticket|no:|ad:|bmtc|ksrtc|phone|date|time|boarding at|booked from|departure|arrival|pnr|class|train)/i.test(cleaned);
}

function isRoutePlaceLine(line: string): boolean {
  const cleaned = cleanPlaceName(line);

  return /[A-Za-z]{3,}/.test(cleaned)
    && !isRouteNoiseLine(cleaned)
    && !isDepotOnlyLine(cleaned)
    && !/(total|amount|fare|rs\.?|\u20B9|upi|ordinary|ticket|no:|ad:|bmtc|ksrtc|phone|date|time|boarding at|booked from|departure|arrival|pnr|class|train|payment|passenger|quota|distance|kannada|english text|text line)/i.test(cleaned);
}

function bmtcPlaceConfidence(line: string): number {
  const cleaned = cleanPlaceName(line);
  const alpha = cleaned.replace(/[^A-Za-z]/g, '');
  const symbolCount = (cleaned.match(/[.,'"`~!@#$%^*_+=|\\<>?]/g) || []).length;
  const digitCount = (cleaned.match(/\d/g) || []).length;
  const words = cleaned.match(/[A-Za-z]{3,}/g) || [];
  const hasGenericPlaceWord = /\b(gate|temple|field|hospital|stand|station|terminal|stop|road|circle|cross|market|junction|bridge|hall|layout|ttmc|depot)\b/i.test(cleaned);
  let score = 0;

  if (!alpha || alpha.length < 4) return 0;
  if (symbolCount >= 2 && !/\bdepot\b/i.test(cleaned)) score -= 4;
  if (digitCount >= 3 && !/\bdepot\s*[- ]?\d+\b/i.test(cleaned)) score -= 3;
  if (/[A-Z][a-z]{2,}/.test(cleaned)) score += 2;
  if (/[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(cleaned)) score += 3;
  if (hasGenericPlaceWord) score += 5;
  if (words.length === 1 && alpha.length >= 7 && digitCount === 0) score += 3;
  if (words.length >= 2 && digitCount === 0) score += 2;
  if (words.length > 3 && !hasGenericPlaceWord) score -= 2;
  if (digitCount > 0 && !hasGenericPlaceWord) score -= 3;

  return score;
}

function isEnglishRouteCandidate(line: string): boolean {
  const cleaned = cleanPlaceName(line);
  const original = String(line || '');

  if (!cleaned || !/[A-Za-z]{3,}/.test(cleaned)) return false;
  if (/[\u0C80-\u0CFF\u0D00-\u0D7F\u0900-\u097F]/.test(original) && !/[A-Za-z]{3,}/.test(original)) return false;
  if (!isRoutePlaceLine(cleaned)) return false;
  if (/^\d|^\W*$/.test(cleaned)) return false;

  return bmtcPlaceConfidence(cleaned) >= 5;
}

function isRouteSeparator(line: string): boolean {
  const normalized = cleanPlaceName(line)
    .replace(/0/g, 'O')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();

  return normalized === 'TO';
}

function findFirstEnglishPlaceFromTo(lines: string[], startIndex: number, direction: -1 | 1): string {
  for (let index = startIndex, scanned = 0; index >= 0 && index < lines.length && scanned < 10; index += direction, scanned++) {
    if (isEnglishRouteCandidate(lines[index])) {
      return canonicalizeBmtcPlace(lines[index]);
    }
  }

  return '';
}

function extractRouteAroundTo(rawLines: string[]): { pickup: string; destination: string } {
  const centerIndex = (rawLines.length - 1) / 2;
  const toIndexes = rawLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isRouteSeparator(line))
    .map(({ index }) => index)
    .sort((left, right) => {
      const distance = Math.abs(left - centerIndex) - Math.abs(right - centerIndex);
      return distance || right - left;
    });

  for (const toIndex of toIndexes) {
    const pickup = findFirstEnglishPlaceFromTo(rawLines, toIndex - 1, -1);
    const destination = findFirstEnglishPlaceFromTo(rawLines, toIndex + 1, 1);

    if (pickup && destination && pickup.toLowerCase() !== destination.toLowerCase()) {
      return { pickup, destination };
    }
  }

  return { pickup: '', destination: '' };
}

function extractLabeledPlace(rawText: string, labels: string[]): string {
  for (const label of labels) {
    const pattern = new RegExp('(?:^|\\n)\\s*' + label + '\\s*[:=-]?\\s*([^\\n]+)', 'i');
    const match = rawText.match(pattern);
    if (match) {
      const value = cleanPlaceName(match[1]);
      if (value && isUsefulPlaceLine(value)) return value;
    }
  }

  return '';
}

function extractSingleLineValue(rawText: string, labels: string[]): string {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const label of labels) {
    const sameLinePattern = new RegExp('^\\s*' + label + '\\s*(?:point)?\\s*[:#-]?\\s+(.+)$', 'i');

    for (let index = 0; index < lines.length; index++) {
      const sameLineMatch = lines[index].match(sameLinePattern);
      if (sameLineMatch) return cleanPlaceName(sameLineMatch[1]);

      if (new RegExp('^\\s*' + label + '\\s*(?:point)?\\s*$', 'i').test(lines[index])) {
        for (let nextIndex = index + 1; nextIndex < Math.min(lines.length, index + 4); nextIndex++) {
          const value = cleanPlaceName(lines[nextIndex]);
          if (value && !new RegExp(labels.join('|'), 'i').test(value)) return value;
        }
      }
    }
  }

  return '';
}

function extractTrainPlaceByLabel(rawText: string, labels: string[]): string {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const labelPattern = labels.join('|');

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const sameLineMatch = line.match(new RegExp('\\b(?:' + labelPattern + ')\\b\\s*(?:point)?\\s*[:#-]?\\s*([A-Z][A-Z0-9 .()/-]{2,80})', 'i'));
    const sameLineValue = normalizeTrainStationValue(sameLineMatch?.[1] || '') || cleanPlaceName(sameLineMatch?.[1] || '');

    if (sameLineValue && isRoutePlaceLine(sameLineValue)) {
      return sameLineValue;
    }

    if (new RegExp('\\b(?:' + labelPattern + ')\\b\\s*(?:point)?\\b', 'i').test(line)) {
      for (let nextIndex = index + 1; nextIndex < Math.min(lines.length, index + 5); nextIndex++) {
        const value = normalizeTrainStationValue(lines[nextIndex]) || cleanPlaceName(lines[nextIndex]);
        if (value && isRoutePlaceLine(value)) return value;
      }
    }
  }

  return '';
}

function normalizeTrainStationValue(value: string): string {
  const cleaned = cleanEnglishText(value)
    .replace(/\s+/g, ' ')
    .trim();
  const stationWithCode = cleaned.match(/\b([A-Z][A-Z .'-]{2,}?\([A-Z0-9]{2,6}\))/);
  if (stationWithCode) return stationWithCode[1].replace(/\s+\(/g, ' (').trim();

  const codeAfterHyphen = cleaned.match(/\b([A-Z][A-Z .'-]{2,}?)\s*-\s*([A-Z0-9]{2,6})\b/);
  if (codeAfterHyphen) return (codeAfterHyphen[1].trim() + ' (' + codeAfterHyphen[2].trim() + ')').replace(/\s+/g, ' ');

  const uppercaseStation = cleaned.match(/\b([A-Z][A-Z .'-]{3,})\b/);
  return uppercaseStation ? uppercaseStation[1].trim() : '';
}

function extractTrainPlacesFromHeaderRows(rawText: string): { pickup: string; destination: string } {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length - 1; index++) {
    const header = lines[index];

    if (!/\bbooked\s+from\b/i.test(header) || !/\bboarding(?:\s+at|\s+point)?\b/i.test(header) || !/\bto\b/i.test(header)) {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < Math.min(lines.length, index + 4); nextIndex++) {
      const valueLine = lines[nextIndex];
      if (!/[A-Za-z]{3,}/.test(valueLine) || /\b(start date|departure|arrival|train|class|pnr|quota|distance)\b/i.test(valueLine)) {
        continue;
      }

      const parts = valueLine
        .split(/\s{2,}|\t+/)
        .map((part) => normalizeTrainStationValue(part))
        .filter(Boolean);

      if (parts.length >= 3) {
        return {
          pickup: parts[1],
          destination: parts[2],
        };
      }

      const stationMatches = [...valueLine.matchAll(/\b[A-Z][A-Z .'-]{2,}?\s*(?:-\s*[A-Z0-9]{2,6}|\([A-Z0-9]{2,6}\))/g)]
        .map((match) => normalizeTrainStationValue(match[0]))
        .filter(Boolean);

      if (stationMatches.length >= 3) {
        return {
          pickup: stationMatches[1],
          destination: stationMatches[2],
        };
      }
    }
  }

  return { pickup: '', destination: '' };
}

function extractTrainClass(rawText: string, travel: any): string {
  const normalizeClass = (value: string): string => {
    const match = String(value || '')
      .toUpperCase()
      .match(/\b(1A|2A|3A|3E|EA|EC|CC|EV|VS|SL|FC|2S|UR|GEN|GS)\b/);

    return match ? match[1] : '';
  };

  const existing = travel.class || travel.travel_class || travel.coach_class || '';
  const existingClass = normalizeClass(existing);
  if (existingClass) return existingClass;

  const labeledClass = extractSingleLineValue(rawText, ['Class']);
  const labeledClassCode = normalizeClass(labeledClass);
  if (labeledClassCode) return labeledClassCode;

  const classMatch = rawText.match(/\b(?:class)\s*[:#-]?\s*([A-Z0-9 ()/-]{2,30})/i);
  const classMatchCode = normalizeClass(classMatch?.[1] || '');
  if (classMatchCode) return classMatchCode;

  return normalizeClass(rawText);
}

function extractTrainPnr(rawText: string, travel: any): string {
  const normalizePnr = (value: string): string => {
    const match = String(value || '').match(/\b\d{10}\b/);
    return match ? match[0] : '';
  };

  const existing = travel.PNR || travel.pnr || travel.ticket_number || travel.ticketNumber || '';
  const existingPnr = normalizePnr(existing);
  if (existingPnr) return existingPnr;

  const labeledPnr = extractSingleLineValue(rawText, ['PNR']);
  const labeledPnrNumber = normalizePnr(labeledPnr);
  if (labeledPnrNumber) return labeledPnrNumber;

  return normalizePnr(rawText);
}

function inferTrainTravel(rawText: string, travel: any) {
  const rawLines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const routeAroundTo = extractRouteAroundTo(rawLines);
  const headerPlaces = extractTrainPlacesFromHeaderRows(rawText);
  const labeledPickup = extractTrainPlaceByLabel(rawText, ['Boarding Point', 'Boarding At', 'Boarding', 'Booked From', 'From']);
  const labeledDestination = extractTrainPlaceByLabel(rawText, ['To', 'Destination', 'Arrival']);

  if (headerPlaces.pickup || headerPlaces.destination) {
    travel.pickup_point = headerPlaces.pickup || travel.pickup_point || labeledPickup || routeAroundTo.pickup || '';
    travel.destination = headerPlaces.destination || travel.destination || labeledDestination || routeAroundTo.destination || '';
  } else if (labeledPickup || labeledDestination) {
    travel.pickup_point = labeledPickup || travel.pickup_point || routeAroundTo.pickup || '';
    travel.destination = labeledDestination || travel.destination || routeAroundTo.destination || '';
  } else if (routeAroundTo.pickup && routeAroundTo.destination) {
    travel.pickup_point = routeAroundTo.pickup;
    travel.destination = routeAroundTo.destination;
  } else {
    travel.pickup_point ||= extractSingleLineValue(rawText, ['Booked From', 'Boarding At', 'Boarding Point', 'From']);
    travel.destination ||= extractSingleLineValue(rawText, ['To', 'Destination', 'Arrival']);
  }

  travel.class = extractTrainClass(rawText, travel);
  travel.PNR = extractTrainPnr(rawText, travel);

  delete travel.route;
  delete travel.ticket_number;
  delete travel.ticketNumber;
  delete travel.pnr;

  return travel;
}

function inferTicketTravel(rawText: string, travel: any) {
  const rawLines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const isBmtc = isBmtcTicket(rawText);
  const cleanedLines = rawLines.map((line) => cleanPlaceName(line));
  const routeAroundTo = extractRouteAroundTo(rawLines);

  if (!isBmtc) {
    travel.pickup_point ||= extractLabeledPlace(rawText, ['from', 'source', 'pickup', 'pickup point', 'boarding', 'start']);
    travel.destination ||= extractLabeledPlace(rawText, ['to', 'destination', 'drop', 'drop point', 'alighting', 'end']);
  }

  if (routeAroundTo.pickup && routeAroundTo.destination) {
    travel.pickup_point = routeAroundTo.pickup;
    travel.destination = routeAroundTo.destination;
  }

  const toIndex = cleanedLines.findIndex((line) => /^to$/i.test(line) || /^to\b/i.test(line));

  if (!isBmtc && toIndex > 0 && !travel.pickup_point) {
    for (let index = toIndex - 1; index >= 0; index--) {
      if (isUsefulPlaceLine(rawLines[index])) {
        travel.pickup_point = canonicalizeBmtcPlace(rawLines[index]);
        break;
      }
    }
  }

  if (!isBmtc && toIndex >= 0 && !travel.destination) {
    for (let index = toIndex + 1; index < rawLines.length; index++) {
      if (isUsefulPlaceLine(rawLines[index])) {
        travel.destination = canonicalizeBmtcPlace(rawLines[index]);
        break;
      }
    }
  }

  const usefulPlaces = rawLines
    .map((line, index) => ({ index, value: canonicalizeBmtcPlace(line) }))
    .filter((line) => isUsefulPlaceLine(line.value));

  if (!isBmtc && (!travel.pickup_point || !travel.destination) && usefulPlaces.length >= 2) {
    const fareIndex = rawLines.findIndex((line) => /(?:fare|total|amount|rs\.?|\u20B9|upi|ordinary|ticket|no\s*:)/i.test(line));
    const beforeFare = fareIndex >= 0 ? usefulPlaces.filter((line) => line.index < fareIndex) : usefulPlaces;
    const candidates = beforeFare.length >= 2 ? beforeFare : usefulPlaces;

    if (!travel.pickup_point) {
      travel.pickup_point = candidates[0]?.value || '';
    }

    if (!travel.destination) {
      travel.destination = candidates[candidates.length - 1]?.value || '';
    }
  }

  if (travel.pickup_point && travel.destination && travel.pickup_point === travel.destination) {
    travel.destination = '';
  }

  if (!travel.route && travel.pickup_point && travel.destination) {
    travel.route = travel.pickup_point + ' to ' + travel.destination;
  }

  return travel;
}

function findBusTicketNumber(rawText: string): string {
  const preferred = rawText.match(/\b(?:tkn|token|ticket)\s*no\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/-]{2,})/i);
  if (preferred) return preferred[1];

  const ordinaryLine = rawText.match(/\bordinary\b[^\n]*\bno\.?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/-]{2,})/i);
  if (ordinaryLine) return ordinaryLine[1];

  const generic = rawText.match(/\b(?:pnr|booking|trip|journey|number)\b\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/-]{2,})|#\s*([A-Z0-9][A-Z0-9\/-]{2,})/i);
  return generic ? (generic[1] || generic[2]) : '';
}

function inferPurchaseVendorName(rawText: string): string {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => cleanEnglishText(cleanPlaceName(line)))
    .filter(Boolean);

  return lines.find((line) =>
    /[A-Za-z]{3,}/.test(line) &&
    !/\b(receipt|invoice|bill|date|time|total|subtotal|tax|gst|amount|cash|card|upi|qty|quantity|item|price|phone|mobile|tin|cin|fssai)\b/i.test(line) &&
    !/\d{4,}/.test(line),
  ) || '';
}

function inferPurchaseCategory(name: string, rawText: string): string {
  const source = name + ' ' + rawText;
  if (/\b(pizza|burger|food|restaurant|meal|coffee|tea|juice)\b/i.test(source)) return 'Food';
  if (/\b(paracetamol|antibiotic|tablet|capsule|pharmacy|medical|medicine|health)\b/i.test(source)) return 'Medical';
  if (/\b(banana|apple|tomato|onion|vegetable|fruit|produce)\b/i.test(source)) return 'Produce';
  return '';
}

function cleanItemName(value: string): string {
  return cleanEnglishText(value)
    .replace(/^\d+\s+/, '')
    .replace(/^(item|desc|description|name)\s*[:#-]?\s*/i, '')
    .replace(/\b(?:qty|quantity|rate|price|mrp|rs|inr)\b\s*[:#-]?\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isNonItemReceiptLine(line: string): boolean {
  return (
    /\b(total|subtotal|grand|tax|gst|cgst|sgst|igst|discount|balance|change|paid|payment|cash|card|upi|receipt|invoice|bill|date|time|expires|round|saving|amount due|visa|mastercard|charge|rec#|vcd#)\b/i.test(line) ||
    /^[A-Z ]+\s*-\s*\d{4,}$/i.test(line) ||
    /^[-\s\d/:.APM]+$/i.test(line)
  );
}

function isAmountOnlyLine(line: string): boolean {
  return /^(?:Rs\.?|INR|\u20B9|[$])?\s*[0-9,]+(?:\.[0-9]{1,2})?\s*$/.test(line.trim());
}

function parseTrailingAmount(line: string): number {
  const match = line.match(/(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*$/i);
  return match ? asNumber(match[1]) : 0;
}

function pushPurchaseItem(items: any[], name: string, quantity: number, totalPrice: number, rawText: string) {
  const cleanName = cleanItemName(name);
  const cleanQuantity = asNumber(quantity) || 1;
  const cleanTotal = asNumber(totalPrice);

  if (cleanName.length < 2 || cleanTotal <= 0 || /^\d+$/.test(cleanName)) return;
  if (isNonItemReceiptLine(cleanName)) return;

  items.push({
    name: cleanName,
    quantity: cleanQuantity,
    unit_price: cleanQuantity ? cleanTotal / cleanQuantity : cleanTotal,
    total_price: cleanTotal,
    category: inferPurchaseCategory(cleanName, rawText),
  });
}

function isSuspiciousPurchaseItem(item: any, receiptTotal: number): boolean {
  const name = String(item?.name || '');
  const totalPrice = asNumber(item?.total_price);

  return (
    !/[A-Za-z]{2,}/.test(name) ||
    /\b(receipt|invoice|bill|store|subtotal|total|tax|visa|charge|date|expires)\b/i.test(name) ||
    (receiptTotal > 0 && totalPrice > receiptTotal * 1.5) ||
    totalPrice > 100000
  );
}

function isLikelyIdentifierAmount(value: number, rawText: string, transaction: any): boolean {
  if (!value || value < 1000 || !Number.isInteger(value)) return false;

  const compactValue = String(value);
  const receiptNumber = String(transaction?.receipt_number || '').replace(/\D/g, '');

  if (receiptNumber && compactValue === receiptNumber) return true;

  const escaped = compactValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identifierPattern = new RegExp(
    '\\b(?:receipt|rec|invoice|bill|voucher|transaction|txn|store|vcd|no|number|phone|mobile|gst|tin)\\s*[:#-]?\\s*' + escaped + '\\b',
    'i',
  );

  return identifierPattern.test(rawText);
}

function hasReadableItemNameAndAmount(item: any, rawText: string, transaction: any, receiptTotal: number): boolean {
  const name = cleanItemName(String(item?.name || item?.description || ''));
  const totalPrice = asNumber(item?.total_price || item?.amount || item?.price);

  if (!/[A-Za-z]{2,}/.test(name)) return false;
  if (totalPrice <= 0) return false;
  if (isLikelyIdentifierAmount(totalPrice, rawText, transaction)) return false;
  if (isSuspiciousPurchaseItem({ ...item, name, total_price: totalPrice }, receiptTotal)) return false;

  return true;
}

function hasProductTableHeaders(rawText: string): boolean {
  return /name\s+of\s+product|product\s*\/\s*service|batch\s+no|mfg\s+date|expir(?:y|e)\s+date|hsn\s*\/\s*sac|taxable\s+value/i.test(rawText)
    && /\b(qty|mrp|rate)\b/i.test(rawText);
}

function cleanTableProductName(value: string): string {
  return cleanItemName(value)
    .replace(/\b(?:batch|mfg|manufactur(?:e|ing)|expir(?:y|e)|hsn|sac|qty|mrp|rate|disc|taxable|value)\b.*$/i, '')
    .replace(/\b[A-Z]\d{1,6}\b\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseTableQuantity(value: string): number {
  const match = String(value || '').match(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:tbs?|tabs?|btl|pkg|pcs?|nos?|strip|strips|units?)?\b/i);
  return match ? asNumber(match[1]) : 1;
}

function extractProductTableItems(rawText: string) {
  if (!hasProductTableHeaders(rawText)) return [];

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => cleanEnglishText(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const items: any[] = [];

  for (const line of lines) {
    if (!/^[0-9]+\s+[A-Za-z]/.test(line)) continue;
    if (/\b(total|subtotal|igst|cgst|sgst|tax|taxable\s+total|grand)\b/i.test(line)) continue;

    const tokens = line.split(/\s+/);
    const srNo = tokens.shift();
    if (!srNo || !/^\d+$/.test(srNo)) continue;

    const amountMatches = [...line.matchAll(/\b[0-9,]+\.[0-9]{2}\b/g)].map((match) => ({
      value: asNumber(match[0]),
      index: match.index ?? 0,
    }));

    if (amountMatches.length < 2) continue;

    const firstAmountIndex = amountMatches[0].index;
    const textBeforeAmounts = line.slice(String(srNo).length, firstAmountIndex).trim();
    const quantityMatch = textBeforeAmounts.match(/\b([0-9]+(?:\.[0-9]+)?)\s*(?:tbs?|tabs?|btl|pkg|pcs?|nos?|strip|strips|units?)\b/i);
    const quantity = quantityMatch ? parseTableQuantity(quantityMatch[0]) : 1;
    const nameSource = quantityMatch
      ? textBeforeAmounts.slice(0, quantityMatch.index).trim()
      : textBeforeAmounts;
    const nameWithoutCodes = nameSource
      .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\b/gi, ' ')
      .replace(/\b\d{6,10}\b/g, ' ')
      .replace(/\b[A-Z]\d{1,6}\b/g, ' ');
    const name = cleanTableProductName(nameWithoutCodes);

    if (!/[A-Za-z]{2,}/.test(name)) continue;

    const mrp = amountMatches[0]?.value || 0;
    const rate = amountMatches[1]?.value || mrp;
    const lineTotal = amountMatches.length >= 4
      ? amountMatches[amountMatches.length - 1].value
      : rate * quantity;

    items.push({
      name,
      quantity,
      unit_price: rate,
      total_price: lineTotal,
      category: inferPurchaseCategory(name, rawText),
      mrp,
    });
  }

  return items;
}

function extractPurchaseItems(rawText: string) {
  const tableItems = extractProductTableItems(rawText);
  if (tableItems.length) return tableItems;

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => cleanEnglishText(line))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !/^[-_=]+$/.test(line));
  const items: any[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (!line || isNonItemReceiptLine(line)) {
      continue;
    }

    const detailedMatch = line.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:x|@)\s*(?:Rs\.?|INR|\u20B9)?\s*([0-9,]+(?:\.[0-9]{1,2})?)\s+(?:Rs\.?|INR|\u20B9)?\s*([0-9,]+(?:\.[0-9]{1,2})?)$/i);
    if (detailedMatch) {
      const name = cleanItemName(detailedMatch[1]);
      if (name.length >= 2) {
        items.push({
          name,
          quantity: asNumber(detailedMatch[2]) || 1,
          unit_price: asNumber(detailedMatch[3]),
          total_price: asNumber(detailedMatch[4]),
          category: inferPurchaseCategory(name, rawText),
        });
      }
      continue;
    }

    const leadingQtyAmountMatch = line.match(/^([0-9]+(?:\.[0-9]+)?)\s+(.+?)\s+(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.[0-9]{1,2})?)$/i);
    if (leadingQtyAmountMatch) {
      const hasExplicitLineAmount = /(?:Rs\.?|INR|\u20B9|[$])\s*[0-9,]+(?:\.[0-9]{1,2})?\s*$/i.test(line)
        || /[0-9,]+\.[0-9]{1,2}\s*$/.test(line);
      if (!hasExplicitLineAmount) {
        continue;
      }

      const quantity = asNumber(leadingQtyAmountMatch[1]) || 1;
      const name = cleanItemName(leadingQtyAmountMatch[2]);
      const totalPrice = asNumber(leadingQtyAmountMatch[3]);

      if (name.length >= 2 && totalPrice > 0) {
        pushPurchaseItem(items, name, quantity, totalPrice, rawText);
      }
      continue;
    }

    if (isAmountOnlyLine(line) && index > 0) {
      const totalPrice = parseTrailingAmount(line);

      for (let previousIndex = index - 1; previousIndex >= 0 && previousIndex >= index - 4; previousIndex--) {
        const previousLine = lines[previousIndex];
        if (!previousLine || isAmountOnlyLine(previousLine)) continue;
        if (isNonItemReceiptLine(previousLine)) break;
        if (!/[A-Za-z]{2,}/.test(previousLine)) continue;

        const splitLineMatch = previousLine.match(/^(?:([0-9]+(?:\.[0-9]+)?)\s+)?(.+?)$/);
        const quantity = asNumber(splitLineMatch?.[1]) || 1;
        const name = cleanItemName(splitLineMatch?.[2] || previousLine);

        pushPurchaseItem(items, name, quantity, totalPrice, rawText);
        break;
      }

      continue;
    }

    if (!/[A-Za-z]/.test(line) || !/\d/.test(line)) {
      continue;
    }

    const hasCurrencyAmount = /(?:Rs\.?|INR|\u20B9|[$])\s*[0-9,]+(?:\.[0-9]{1,2})?\s*$/i.test(line);
    const hasDecimalAmount = /[0-9,]+\.[0-9]{1,2}\s*$/.test(line);
    const amountAtEndMatch = line.match(/^(.+?)\s+(?:Rs\.?|INR|\u20B9|[$])?\s*([0-9,]+(?:\.[0-9]{1,2})?)$/i);
    if (!amountAtEndMatch) continue;
    if (!hasCurrencyAmount && !hasDecimalAmount) continue;

    let namePart = amountAtEndMatch[1];
    const totalPrice = asNumber(amountAtEndMatch[2]);
    let quantity = 1;
    let unitPrice = totalPrice;
    const qtyRateMatch = namePart.match(/^(.+?)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:x|@)\s*(?:Rs\.?|INR|\u20B9)?\s*([0-9,]+(?:\.[0-9]{1,2})?)$/i);

    if (qtyRateMatch) {
      namePart = qtyRateMatch[1];
      quantity = asNumber(qtyRateMatch[2]) || 1;
      unitPrice = asNumber(qtyRateMatch[3]) || (quantity ? totalPrice / quantity : totalPrice);
    }

    const name = cleanItemName(namePart);

    if (name.length < 2 || totalPrice <= 0 || /^\d+$/.test(name)) continue;

    items.push({
      name,
      quantity,
      unit_price: unitPrice,
      total_price: totalPrice,
      category: inferPurchaseCategory(name, rawText),
    });
  }

  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.name.toLowerCase() + '::' + item.total_price;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 60);
}

function normalizePurchase(data: any, rawText: string) {
  const vendor = data.vendor || {};
  const transaction = fillCommonTransaction(data.transaction || {}, rawText);
  transaction.receipt_number ??= '';

  if (!transaction.receipt_number) transaction.receipt_number = findReceiptNumber(rawText);
  const rawTotal = findTotal(rawText);

  const aiItems = (data.items || []).map((item: any) => {
    const quantity = asNumber(item.quantity) || 1;
    const unitPrice = asNumber(item.unit_price ?? item.price);
    const totalPrice = asNumber(item.total_price) || unitPrice * quantity;
    const name = cleanItemName(item.name || item.description || '');

    return {
      name,
      quantity,
      unit_price: unitPrice || (quantity ? totalPrice / quantity : totalPrice),
      total_price: totalPrice,
      category: item.category || '',
    };
  }).filter((item: any) => hasReadableItemNameAndAmount(item, rawText, transaction, rawTotal));
  const fallbackItems = extractPurchaseItems(rawText);
  const aiItemsLookBad = aiItems.length === 0 || aiItems.some((item: any) => isSuspiciousPurchaseItem(item, rawTotal));
  const items = aiItemsLookBad && fallbackItems.length ? fallbackItems : aiItems;

  const totals = data.totals || {};
  const itemsSubtotal = items.reduce((sum: number, item: any) => sum + asNumber(item.total_price), 0);
  totals.subtotal = findSubtotal(rawText) || asNumber(totals.subtotal) || itemsSubtotal;
  totals.tax = findTax(rawText) || asNumber(totals.tax);
  totals.discounts = normalizeDiscounts(totals.discounts || data.discounts || [], rawText);
  totals.total = rawTotal || asNumber(totals.total) || Math.max(0, itemsSubtotal + totals.tax - sumDiscounts(totals.discounts));

  return {
    document: { type: 'receipt', transaction_type: 'purchase', transport_type: '' },
    vendor: { name: vendor.name || inferPurchaseVendorName(rawText), address: vendor.address || '', phone: vendor.phone || '' },
    transaction,
    items,
    totals,
    payment: fillPayment(data.payment || {}, totals.total, rawText),
    raw_text: rawText,
  };
}

function normalizeFuel(data: any, rawText: string) {
  const vendor = data.vendor || {};
  const transaction = fillCommonTransaction(data.transaction || {}, rawText);
  transaction.receipt_number ??= '';
  transaction.currency ||= 'INR';

  if (!transaction.receipt_number) transaction.receipt_number = findReceiptNumber(rawText);

  const fuelData = data.fuel || {};
  const firstFuelItem = (data.items || []).find((item: any) =>
    /fuel|petrol|diesel/i.test(String(item.category || item.name || '')),
  ) || data.items?.[0] || {};
  const product = fuelData.product || firstFuelItem.name || detectFuelName(rawText);
  const quantity = asNumber(fuelData.quantity ?? firstFuelItem.quantity) || findFuelQuantity(rawText);
  const unit = fuelData.unit || firstFuelItem.unit || (quantity ? 'Litre' : 'Litre');
  const ratePerUnit = asNumber(fuelData.rate_per_unit ?? fuelData.rate ?? firstFuelItem.rate_per_unit ?? firstFuelItem.unit_price) || findFuelUnitPrice(rawText);
  const discounts = normalizeDiscounts(data.totals?.discounts || data.discounts || [], rawText);
  const grossTotal = findTotal(rawText) || asNumber(data.totals?.total) || asNumber(firstFuelItem.total_price) || asNumber(data.payment?.amount) || (quantity * ratePerUnit);
  const total = Math.max(0, grossTotal - sumDiscounts(discounts));

  return {
    document: {
      type: 'receipt',
      receipt_category: 'fuel',
      transaction_type: 'purchase',
      transport_type: '',
    },
    vendor: {
      name: vendor.name || vendor.customer || extractFuelVendor(rawText),
      address: vendor.address || '',
    },
    transaction,
    fuel: {
      product,
      quantity,
      unit,
      rate_per_unit: ratePerUnit,
    },
    payment: fillPayment(data.payment || {}, total, rawText),
    totals: { subtotal: grossTotal, discounts, total },
    raw_text: rawText,
  };
}

function normalizeTicket(data: any, rawText: string) {
  const issuer = data.issuer || data.vendor || {};
  const travel = data.travel || {};
  const transportType = detectTransportType(data, rawText) || 'bus';
  travel.pickup_point = String(
    travel.pickup_point || travel.pickupPoint || travel.from || travel.source || travel.boarding || '',
  ).trim();
  travel.destination = String(
    travel.destination || travel.to || travel.drop || travel.drop_point || travel.dropPoint || travel.alighting || '',
  ).trim();
  if (transportType === 'train') {
    inferTrainTravel(rawText, travel);
  } else {
    travel.route = String(travel.route || '').trim();
    travel.ticket_number = String(travel.ticket_number || travel.ticketNumber || travel.pnr || '').trim();
    if (isBmtcTicket(rawText)) {
      if (!isEnglishRouteCandidate(travel.pickup_point)) travel.pickup_point = '';
      if (!isEnglishRouteCandidate(travel.destination)) travel.destination = '';
      travel.route = '';
    }
    inferTicketTravel(rawText, travel);
    travel.pickup_point = canonicalizeBmtcPlace(travel.pickup_point || '');
    travel.destination = canonicalizeBmtcPlace(travel.destination || '');

    travel.ticket_number = findBusTicketNumber(rawText) || travel.ticket_number;
    if (travel.pickup_point && travel.destination) {
      travel.route = travel.pickup_point + ' to ' + travel.destination;
    }
  }

  const discounts = normalizeDiscounts(data.totals?.discounts || data.discounts || [], rawText);
  const grossTotal = transportType === 'train'
    ? (findTrainTicketTotal(rawText) || asNumber(data.totals?.total))
    : normalizeBmtcFareAmount(findBmtcFareTotal(rawText) || asNumber(data.totals?.total), rawText);
  const total = Math.max(0, grossTotal - sumDiscounts(discounts));

  return {
    document: { type: 'ticket', transaction_type: 'purchase', transport_type: transportType },
    issuer: { name: issuer.name || '', address: issuer.address || '', phone: issuer.phone || '' },
    travel,
    transaction: fillCommonTransaction(data.transaction || {}, rawText),
    totals: { subtotal: grossTotal, discounts, total },
    payment: fillPayment(
      {
        ...(data.payment || {}),
        amount: normalizeBmtcFareAmount(asNumber(data.payment?.amount), rawText) || total,
      },
      total,
      rawText,
    ),
    raw_text: rawText,
  };
}

function normalizeRefund(data: any, rawText: string) {
  const vendor = data.vendor || {};
  const transaction = fillCommonTransaction(data.transaction || {}, rawText);
  transaction.receipt_number ??= '';
  transaction.original_receipt_number ??= '';

  const receiptMatch = rawText.match(/(?:refund|return|receipt|invoice|bill|txn|transaction|rec|no|number|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/-]{2,})/i);
  if (!transaction.receipt_number && receiptMatch) transaction.receipt_number = receiptMatch[1];

  const originalMatch = rawText.match(/(?:original|old|source)\s*(?:receipt|bill|txn|transaction|no|number)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/-]{2,})/i);
  if (!transaction.original_receipt_number && originalMatch) transaction.original_receipt_number = originalMatch[1];

  const discounts = normalizeDiscounts(data.totals?.discounts || data.refund?.discounts || data.discounts || [], rawText);
  const grossRefundAmount = findTotal(rawText) || asNumber(data.refund?.refund_amount);
  const refundAmount = Math.max(0, grossRefundAmount - sumDiscounts(discounts));
  const items = (data.items || []).map((item: any) => ({
    name: item.name || item.description || '',
    quantity: asNumber(item.quantity) || 1,
    unit_price: asNumber(item.unit_price ?? item.price),
    refund_amount: asNumber(item.refund_amount) || refundAmount,
    reason: item.reason || '',
  }));

  return {
    document: { type: 'receipt', transaction_type: 'refund', transport_type: '' },
    vendor: { name: vendor.name || '', address: vendor.address || '', phone: vendor.phone || '' },
    transaction,
    items,
    refund: {
      refund_method: data.refund?.refund_method || data.payment?.method || '',
      refund_amount: refundAmount,
    },
    totals: {
      subtotal: grossRefundAmount,
      discounts,
      total: refundAmount,
    },
    raw_text: rawText,
  };
}

export function enrichReceiptData(data: any, rawText: string) {
  data ??= {};
  const kind = detectDocumentKind(data, rawText);
  let result: any;

  if (kind === 'ticket') result = normalizeTicket(data, rawText);
  else if (kind === 'fuel') result = normalizeFuel(data, rawText);
  else if (kind === 'refund') result = normalizeRefund(data, rawText);
  else result = normalizePurchase(data, rawText);

  return enforceEnglishJson(result);
}
