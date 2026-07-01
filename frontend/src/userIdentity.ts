const RECEIPT_USER_ID_KEY = 'receiptScannerUserId';

export function getReceiptUserId() {
  const existing = localStorage.getItem(RECEIPT_USER_ID_KEY);

  if (existing) return existing;

  const randomPart = Math.random().toString(36).slice(2, 12);
  const userId = 'user-' + Date.now().toString(36) + '-' + randomPart;

  localStorage.setItem(RECEIPT_USER_ID_KEY, userId);

  return userId;
}

export function getUserHeaders() {
  return {
    'X-User-Id': getReceiptUserId(),
  };
}
