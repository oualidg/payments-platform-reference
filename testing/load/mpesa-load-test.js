/**
 * k6 Load Test — M-Pesa Gateway Confirmation Pipeline
 *
 * Scenario:
 *   - Setup:     Login as admin (bearer mode), onboard 50 customers,
 *                collect customer IDs and account numbers
 *   - Load test: Fire M-Pesa confirmation callbacks at full speed,
 *                alternating between customer ID and account number as BillRefNumber
 *
 * What this validates:
 *   - Gateway confirmation ingest throughput (MongoDB write + HTTP 200)
 *   - Outbox processor draining under burst load
 *   - RabbitMQ buffering of provisioning requests
 *   - Provisioning Service processing under UA Service rate limiting (20 req/s)
 *   - Retry with backoff handling 429s from UA Service
 *   - All events eventually reach POSTED state
 *
 * Expected behaviour:
 *   - Gateway returns HTTP 200 on every confirmation immediately
 *   - UA Service rate limiter (20 req/s) causes provisioning 429s -- retries handle this
 *   - Outbox backlog grows during burst, drains linearly after load stops
 *   - All events transition to POSTED or SUSPENDED (no silent loss)
 *
 * Run with:
 *   k6 run mpesa-load-test.js
 *
 * Target:
 *   - Confirmation ingest: http://192.168.1.168:8081 (direct, no Nginx rate limiting)
 *   - Customer setup:      http://192.168.1.168 (via Nginx)
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

const UA_BASE_URL     = 'http://192.168.1.168';       // Via Nginx — for admin setup
const GATEWAY_URL     = 'http://192.168.1.168:8081';  // Direct — no rate limiting on ingest
const CALLBACK_TOKEN  = 'CfTJa5wCvGYFQx4rXt50';
const SHORT_CODE      = '600123';

const ADMIN_USERNAME  = 'admin';
const ADMIN_PASSWORD  = 'admin';

const CUSTOMER_COUNT  = 50;

// ==============================================================================
// Load Test Stages — mirrors UA Service load test profile
// Ramp up -> sustain -> spike -> ramp down
// ==============================================================================

export const options = {
  stages: [
    { duration: '15s', target: 10  },  // Ramp up to 10 virtual users
    { duration: '30s', target: 50  },  // Ramp up to 50 virtual users
    { duration: '60s', target: 50  },  // Sustain 50 virtual users
    { duration: '15s', target: 100 },  // Spike to 100 virtual users
    { duration: '30s', target: 100 },  // Sustain spike
    { duration: '15s', target: 0   },  // Ramp down
  ],
  thresholds: {
    // Gateway returns 200 immediately on ingest -- near-zero failures expected
    http_req_failed: ['rate<0.01'],
    // Ingest is a MongoDB write -- should be fast
    http_req_duration: ['p(95)<500'],
  },
};

// ==============================================================================
// Custom Metrics
// ==============================================================================

const confirmationSuccessRate = new Rate('confirmation_success_rate');
const confirmationDuration    = new Trend('confirmation_duration_ms');
const confirmationErrors      = new Counter('confirmation_errors');

// ==============================================================================
// Setup — runs once before the load test
// Creates 50 customers and collects their IDs and account numbers
// ==============================================================================

export function setup() {
  console.log('=== SETUP: Logging in as admin (bearer mode) ===');

  const loginRes = http.post(
    `${UA_BASE_URL}/api/auth/login`,
    JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Mode': 'bearer',
      }
    }
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

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'X-Auth-Mode': 'bearer',
  };

  console.log(`=== SETUP: Onboarding ${CUSTOMER_COUNT} customers ===`);

  const suffix = String(Date.now()).slice(-6);

  const firstNames = ['Sipho', 'Nomsa', 'Thabo', 'Zanele', 'Bongani', 'Lerato', 'Mpho', 'Nkosi', 'Ayanda', 'Thembi',
                      'Kagiso', 'Palesa', 'Tshepo', 'Refilwe', 'Siyanda', 'Lindiwe', 'Mandla', 'Precious', 'Lungelo', 'Nokwanda',
                      'Tebogo', 'Funani', 'Sibusiso', 'Ntombi', 'Lwazi', 'Bongiwe', 'Sandile', 'Zintle', 'Mthokozisi', 'Nompumelelo',
                      'Akhona', 'Sifiso', 'Naledi', 'Lunga', 'Busisiwe', 'Musa', 'Zodwa', 'Sbonelo', 'Hlengiwe', 'Dumisani',
                      'Phindile', 'Mxolisi', 'Ntombizodwa', 'Mbuso', 'Khanyisile', 'Sizwe', 'Nobuhle', 'Bhekani', 'Nokukhanya', 'Mlungisi'];

  const lastNames = ['Dlamini', 'Nkosi', 'Molefe', 'Khumalo', 'Sithole', 'Ndlovu', 'Mahlangu', 'Zulu', 'Mthembu', 'Shabalala',
                     'Khoza', 'Mkhize', 'Buthelezi', 'Cele', 'Ntuli', 'Mhlongo', 'Zwane', 'Ngcobo', 'Majola', 'Ngema',
                     'Hadebe', 'Gumede', 'Mnguni', 'Mbatha', 'Ntanzi', 'Msweli', 'Myeni', 'Mchunu', 'Ngubane', 'Mthethwa',
                     'Bhengu', 'Madlala', 'Maphumulo', 'Mthiyane', 'Mabaso', 'Zungu', 'Hlongwane', 'Luthuli', 'Mdlalose', 'Mhlungu',
                     'Xulu', 'Mngomezulu', 'Nxumalo', 'Mthembu', 'Vilakazi', 'Mkhwanazi', 'Ngwenya', 'Msweli', 'Jiyane', 'Msomi'];

  const customers = [];

  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const payload = {
      firstName:    firstNames[i],
      lastName:     lastNames[i],
      mobileNumber: `08${suffix}${String(i).padStart(2, '0')}`,
      email:        `${firstNames[i].toLowerCase()}${suffix}${i}@mpesatest.com`,
    };

    const res = http.post(
      `${UA_BASE_URL}/api/v1/customers`,
      JSON.stringify(payload),
      { headers: authHeaders }
    );

    if (res.status === 201 || res.status === 200) {
      const customer = JSON.parse(res.body);
      console.log(`Created customer ${i + 1}/${CUSTOMER_COUNT}: ${customer.customerId} — ${customer.firstName} ${customer.lastName}`);
      customers.push({ customerId: customer.customerId });
    } else {
      console.error(`Failed to create customer ${i + 1}: ${res.status} ${res.body}`);
    }

    sleep(0.1);
  }

  // Fetch account numbers for each customer
  console.log('=== SETUP: Fetching account numbers ===');

  const testData = [];

  for (const customer of customers) {
    const res = http.get(
      `${UA_BASE_URL}/api/v1/customers/${customer.customerId}/accounts`,
      { headers: authHeaders }
    );

    if (res.status === 200) {
      const accounts = JSON.parse(res.body);
      if (accounts.length > 0) {
        testData.push({
          customerId:    customer.customerId,
          accountNumber: accounts[0].accountNumber,
        });
        console.log(`Customer ${customer.customerId} -> Account ${accounts[0].accountNumber}`);
      }
    }

    sleep(0.1);
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

  // Alternate between customer ID and account number as BillRefNumber
  const useCustomerId = Math.random() > 0.5;
  const billRef       = useCustomerId
    ? String(target.customerId)
    : String(target.accountNumber);

  // Unique TransID per request — prevents idempotency collisions
  const transId = `MPESA-${Date.now()}-${Math.floor(Math.random() * 9999999)}`;
  const amount  = parseFloat((Math.random() * 500 + 10).toFixed(2));

  const payload = JSON.stringify({
    TransactionType:  'Pay Bill',
    TransID:          transId,
    TransTime:        '20240315123045',
    TransAmount:      String(amount),
    BusinessShortCode: SHORT_CODE,
    BillRefNumber:    billRef,
    InvoiceNumber:    '',
    OrgAccountBalance: '50000.00',
    ThirdPartyTransID: '',
    MSISDN:           '254712345678',
    FirstName:        'LOAD',
    MiddleName:       'T',
    LastName:         'TEST',
  });

  const start = Date.now();

  const res = http.post(
    `${GATEWAY_URL}/api/v1/confirmation?token=${CALLBACK_TOKEN}`,
    payload,
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );

  const duration = Date.now() - start;
  confirmationDuration.add(duration);

  const success = check(res, {
    'confirmation status 200': r => r.status === 200,
  });

  confirmationSuccessRate.add(success);

  if (!success) {
    confirmationErrors.add(1);
    console.error(`Confirmation failed: ${res.status} — transId=${transId} — ${res.body.substring(0, 200)}`);
  }

  // No sleep — hammer as fast as possible to stress the pipeline
}

// ==============================================================================
// Teardown — runs once after the load test completes
// ==============================================================================

export function teardown(data) {
  console.log('=== TEARDOWN COMPLETE ===');
  console.log(`Tested against ${data.testData ? data.testData.length : 0} customers`);
  console.log('');
  console.log('Next steps to verify pipeline completion:');
  console.log('1. Wait for outbox to drain (sent=false count returns to 0)');
  console.log('2. Check RabbitMQ queues depth returns to 0');
  console.log('3. Verify all events reach POSTED or SUSPENDED:');
  console.log('   docker exec -it mongodb mongosh -u admin -p admin --authenticationDatabase admin \\');
  console.log('   --eval "db.getSiblingDB(\'mpesa\').mpesa_events.aggregate([{$group:{_id:\'$state\',count:{$sum:1}}}]).pretty()"');
}
