import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const RECEIPT_FILE = __ENV.RECEIPT_FILE;
const MIME_TYPE = __ENV.MIME_TYPE || 'image/jpeg';
const FILE_NAME = __ENV.FILE_NAME || 'load-test-receipt.jpg';
const USER_PREFIX = __ENV.USER_PREFIX || `load-user-${Date.now()}`;
const POLL_STATUS = String(__ENV.POLL_STATUS || 'false').toLowerCase() === 'true';

if (!RECEIPT_FILE) {
  throw new Error(
    'Set RECEIPT_FILE to a real JPG/PNG/HEIC/PDF receipt path. Example: k6 run -e RECEIPT_FILE=./samples/receipt.jpg load-tests/upload-50-users.js',
  );
}

const receiptBytes = open(RECEIPT_FILE, 'b');

export const options = {
  scenarios: {
    upload_burst: {
      executor: 'shared-iterations',
      vus: Number(__ENV.VUS || 50),
      iterations: Number(__ENV.ITERATIONS || 50),
      maxDuration: __ENV.MAX_DURATION || '3m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    upload_accepted: ['rate>0.95'],
    upload_response_latency: ['p(95)<5000'],
  },
};

const uploadAccepted = new Rate('upload_accepted');
const uploadLatency = new Trend('upload_response_latency');
const processingVisible = new Rate('processing_status_visible');

function userHeaders() {
  return {
    headers: {
      'X-User-Id': `${USER_PREFIX}-${__VU}`,
    },
  };
}

function pollReceipt(transactionId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = http.get(`${BASE_URL}/receipt/${transactionId}/output`, userHeaders());
    const statusOk = response.status === 200
      && /processing|completed|failed|duplicate_pending/.test(response.body || '');
    processingVisible.add(statusOk);

    if (/completed|failed|duplicate_pending/.test(response.body || '')) {
      return;
    }

    sleep(2);
  }
}

function parseJsonBody(response) {
  try {
    return response.json();
  } catch (_error) {
    return {};
  }
}

export default function () {
  group('concurrent receipt uploads', () => {
    const payload = {
      receipt: http.file(receiptBytes, FILE_NAME, MIME_TYPE),
    };

    const response = http.post(`${BASE_URL}/upload`, payload, userHeaders());
    uploadLatency.add(response.timings.duration);

    const body = parseJsonBody(response);
    const accepted = response.status === 201 || response.status === 200;
    const hasTransaction = Boolean(body && body.transactionId);

    uploadAccepted.add(accepted && hasTransaction);
    check(response, {
      'POST /upload accepted': () => accepted,
      'upload returns transactionId': () => hasTransaction,
      'upload returns active status': () =>
        body && ['processing', 'duplicate_pending'].includes(body.status),
    });

    if (POLL_STATUS && body?.transactionId) {
      pollReceipt(body.transactionId);
    }
  });
}
