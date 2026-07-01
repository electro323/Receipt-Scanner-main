import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const USER_PREFIX = __ENV.USER_PREFIX || 'load-user';

export const options = {
  scenarios: {
    read_traffic: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 50),
      duration: __ENV.DURATION || '1m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
    receipts_read_ok: ['rate>0.99'],
    analytics_read_ok: ['rate>0.99'],
  },
};

const receiptsLatency = new Trend('receipts_read_latency');
const analyticsLatency = new Trend('analytics_read_latency');
const receiptsReadOk = new Rate('receipts_read_ok');
const analyticsReadOk = new Rate('analytics_read_ok');

function userHeaders() {
  return {
    headers: {
      'X-User-Id': `${USER_PREFIX}-${__VU}`,
    },
  };
}

export default function () {
  group('receipt history and analytics reads', () => {
    const receipts = http.get(`${BASE_URL}/receipts`, userHeaders());
    receiptsLatency.add(receipts.timings.duration);
    receiptsReadOk.add(receipts.status === 200);
    check(receipts, {
      'GET /receipts returns 200': (response) => response.status === 200,
      'GET /receipts returns JSON': (response) =>
        String(response.headers['Content-Type'] || '').includes('application/json'),
    });

    const analytics = http.get(`${BASE_URL}/analytics/monthly`, userHeaders());
    analyticsLatency.add(analytics.timings.duration);
    analyticsReadOk.add(analytics.status === 200);
    check(analytics, {
      'GET /analytics/monthly returns 200': (response) => response.status === 200,
      'GET /analytics/monthly returns JSON': (response) =>
        String(response.headers['Content-Type'] || '').includes('application/json'),
    });
  });

  sleep(1);
}
