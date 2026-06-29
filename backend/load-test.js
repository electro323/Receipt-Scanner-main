import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  vus: 5,
  duration: '1m',
};

export default function () {
  http.get('http://localhost:3000/receipts');
  sleep(1);
}