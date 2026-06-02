/**
 * k6 Load Test — Utility Account Payment System
 *
 * Scenario:
 *   - Setup:     Login as admin (bearer mode), onboard 10 customers
 *   - Load test: Mixed payment workload across all customers/accounts
 *                using both MPESA and MTN providers
 *
 * Run with:
 *   k6 run load-test.js
 *
 * Install k6:
 *   Windows: winget install k6 --source winget
 *   Or download from: https://dl.k6.io/msi/k6-latest-amd64.msi
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ==============================================================================
// Configuration
// ==============================================================================

const BASE_URL = 'http://192.168.1.168';

const MPESA_API_KEY = 'e7e75fe1-4192-4e34-af5e-6010d787c029';
const MTN_API_KEY   = '0df87c1d-2dde-4a08-8f9f-7739b471073a';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin';

// ==============================================================================
// Load Test Stages
// Ramp up → sustain → spike → ramp down
// ==============================================================================

export const options = {
  stages: [
    { duration: '15s', target: 10  },   // Ramp up to 10 virtual users
    { duration: '30s', target: 50  },   // Ramp up to 50 virtual users
    { duration: '60s', target: 50  },   // Sustain 50 virtual users
    { duration: '15s', target: 100 },   // Spike to 100 virtual users
    { duration: '30s', target: 100 },   // Sustain spike
    { duration: '15s', target: 0   },   // Ramp down
  ],
  thresholds: {
    // 95% of requests must complete within 500ms
    http_req_duration: ['p(95)<500'],
    // Error rate must stay below 5%
    http_req_failed: ['rate<0.05'],
  },
};

// ==============================================================================
// Custom Metrics
// ==============================================================================

const paymentSuccessRate = new Rate('payment_success_rate');
const paymentDuration    = new Trend('payment_duration_ms');
const paymentErrors      = new Counter('payment_errors');

// ==============================================================================
// Setup — runs once before the load test
// Onboards 10 customers and collects their IDs and account numbers
// ==============================================================================

export function setup() {
  console.log('=== SETUP: Logging in as admin (bearer mode) ===');

  // Login with X-Auth-Mode: bearer — token returned in response body, no cookies, no CSRF
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    { headers: {
        'Content-Type': 'application/json',
        'X-Auth-Mode': 'bearer',
    }}
  );

  check(loginRes, { 'login succeeded': r => r.status === 200 });

  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.body);
    return {};
  }

  const accessToken = JSON.parse(loginRes.body).accessToken;

  if (!accessToken) {
    console.error('No accessToken in response body');
    return {};
  }

  // Bearer auth headers for all admin requests — no cookies, no CSRF needed
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'X-Auth-Mode': 'bearer',
  };

  console.log('=== SETUP: Onboarding 10 customers ===');

  // Unique suffix per run to avoid unique constraint conflicts on re-runs
  const suffix = String(Date.now()).slice(-6);

  const customers = [];
  const firstNames = ['Sipho', 'Nomsa', 'Thabo', 'Zanele', 'Bongani', 'Lerato', 'Mpho', 'Nkosi', 'Ayanda', 'Thembi'];
  const lastNames  = ['Dlamini', 'Nkosi', 'Molefe', 'Khumalo', 'Sithole', 'Ndlovu', 'Mahlangu', 'Zulu', 'Mthembu', 'Shabalala'];
  const mobiles    = [`082${suffix}01`, `082${suffix}02`, `082${suffix}03`, `082${suffix}04`, `082${suffix}05`,
                      `082${suffix}06`, `082${suffix}07`, `082${suffix}08`, `082${suffix}09`, `082${suffix}10`];
  const emails     = [`sipho${suffix}@loadtest.com`, `nomsa${suffix}@loadtest.com`, `thabo${suffix}@loadtest.com`,
                      `zanele${suffix}@loadtest.com`, `bongani${suffix}@loadtest.com`, `lerato${suffix}@loadtest.com`,
                      `mpho${suffix}@loadtest.com`, `nkosi${suffix}@loadtest.com`, `ayanda${suffix}@loadtest.com`,
                      `thembi${suffix}@loadtest.com`];

  for (let i = 0; i < 10; i++) {
    const payload = {
      firstName:    firstNames[i],
      lastName:     lastNames[i],
      mobileNumber: mobiles[i],
      email:        emails[i],
    };

    const res = http.post(
      `${BASE_URL}/api/v1/customers`,
      JSON.stringify(payload),
      { headers: authHeaders }
    );

    if (res.status === 201 || res.status === 200) {
      const customer = JSON.parse(res.body);
      console.log(`Created customer: ${customer.customerId} — ${customer.firstName} ${customer.lastName}`);
      customers.push({ customerId: customer.customerId });
    } else {
      console.error(`Failed to create customer ${i + 1}: ${res.status} ${res.body}`);
    }

    sleep(0.2);
  }

  // Fetch account numbers for each customer
  console.log('=== SETUP: Fetching account numbers ===');

  const testData = [];

  for (const customer of customers) {
    const res = http.get(
      `${BASE_URL}/api/v1/customers/${customer.customerId}/accounts`,
      { headers: authHeaders }
    );

    if (res.status === 200) {
      const accounts = JSON.parse(res.body);
      if (accounts.length > 0) {
        testData.push({
          customerId:    customer.customerId,
          accountNumber: accounts[0].accountNumber,
        });
        console.log(`Customer ${customer.customerId} → Account ${accounts[0].accountNumber}`);
      }
    }

    sleep(0.2);
  }

  console.log(`=== SETUP COMPLETE: ${testData.length} customers ready for load test ===`);
  return { testData };
}

// ==============================================================================
// Default function — runs for each virtual user on each iteration
// ==============================================================================

export default function (data) {
  if (!data.testData || data.testData.length === 0) {
    console.error('No test data available');
    return;
  }

  // Pick a random customer
  const target = data.testData[Math.floor(Math.random() * data.testData.length)];

  // Randomly alternate between payment styles and providers
  const useCustomerId = Math.random() > 0.5;
  const useMpesa      = Math.random() > 0.5;
  const apiKey        = useMpesa ? MPESA_API_KEY : MTN_API_KEY;

  const paymentHeaders = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
  };

  const reference = `LOAD-${Date.now()}-${Math.floor(Math.random() * 999999)}`;
  const amount    = parseFloat((Math.random() * 500 + 10).toFixed(2));

  const url = useCustomerId
    ? `${BASE_URL}/api/v1/customers/${target.customerId}/payments`
    : `${BASE_URL}/api/v1/accounts/${target.accountNumber}/payments`;

  const payload = JSON.stringify({ paymentReference: reference, amount });

  const start    = Date.now();
  const res      = http.post(url, payload, { headers: paymentHeaders });
  const duration = Date.now() - start;

  paymentDuration.add(duration);

  const success = check(res, {
    'payment status 200': r => r.status === 200,
    'has receipt number': r => {
      try { return JSON.parse(r.body).receiptNumber !== undefined; }
      catch { return false; }
    },
  });

  paymentSuccessRate.add(success);

  if (!success) {
    paymentErrors.add(1);
    console.error(`Payment failed: ${res.status} — ${url} — ${res.body.substring(0, 200)}`);
  }

  // Small think time — realistic user behaviour
  sleep(Math.random() * 0.5);
}

// ==============================================================================
// Teardown — runs once after the load test completes
// ==============================================================================

export function teardown(data) {
  console.log('=== TEARDOWN COMPLETE ===');
  console.log(`Tested against ${data.testData ? data.testData.length : 0} customers`);
}