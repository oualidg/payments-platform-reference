/**
 * k6 Dev Seeder — Utility Account Payment System (localhost)
 *
 * Onboards 100 customers and fires 60 payments per account (6 000 rows total).
 * Use this to populate dev data before testing pagination.
 *
 * Run with:
 *   k6 run load-test-dev.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

// ==============================================================================
// Configuration
// ==============================================================================

const BASE_URL = 'http://localhost:8080';

const MPESA_API_KEY = 'e7e75fe1-4192-4e34-af5e-6010d787c029';
const MTN_API_KEY   = '0df87c1d-2dde-4a08-8f9f-7739b471073a';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin';

const CUSTOMER_COUNT = 100;
const PAYMENTS_EACH  = 60;

// ==============================================================================
// Single VU, single iteration — setup does the work, default just reports
// ==============================================================================

export const options = {
  vus: 1,
  iterations: 1,
};

// ==============================================================================
// Setup
// ==============================================================================

export function setup() {
  // --- Login ---
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json', 'X-Auth-Mode': 'bearer' }}
  );

  check(loginRes, { 'login succeeded': r => r.status === 200 });
  if (loginRes.status !== 200) {
    console.error('Login failed:', loginRes.body);
    return {};
  }

  const accessToken = JSON.parse(loginRes.body).accessToken;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'X-Auth-Mode': 'bearer',
  };

  // --- Onboard customers ---
  const suffix = String(Date.now()).slice(-6);

  const firstNames = ['Sipho','Nomsa','Thabo','Zanele','Bongani','Lerato','Mpho','Nkosi','Ayanda','Thembi',
                      'Sifiso','Naledi','Lwazi','Zodwa','Sandile','Busisiwe','Lungelo','Palesa','Mthokozisi','Lindiwe',
                      'Sibusiso','Nokwanda','Thandeka','Mandla','Nompumelelo','Khulekani','Nonhlanhla','Siyanda','Ntombi','Phiwayinkosi',
                      'Vusi','Ntombifuthi','Lungisa','Nobuhle','Msizi','Khanyisile','Nhlanhla','Simangele','Zwelakhe','Mbalenhle',
                      'Lungani','Ntuthuko','Zinhle','Sibonelo','Bongiwe','Thulani','Nomcebo','Mduduzi','Sphesihle','Nokubonga',
                      'Mfanafuthi','Ntandokazi','Buhlebenkosi','Mlungisi','Ntombizethu','Sbongile','Ntokozo','Wiseman','Khethiwe','Nokukhanya',
                      'Langelihle','Nozipho','Mawande','Nomalanga','Sinethemba','Siphesihle','Skhumbuzo','Ntombizodwa','Buhle','Smangaliso',
                      'Nokwazi','Lindokuhle','Zamokuhle','Ntuthuzelo','Nothile','Qiniso','Samkelo','Nomathemba','Thamsanqa','Nobukhosi',
                      'Mondli','Nondumiso','Phila','Ntombifikile','Sibonokuhle','Zolani','Nokufa','Mthokozisi','Ntombizinhle','Siyabonga',
                      'Nozinhle','Sithembile','Mbuso','Buyani','Noxolo','Lwandle','Njabulo','Nosipho','Bhekani','Tholakele'];

  const lastNames  = ['Dlamini','Nkosi','Molefe','Khumalo','Sithole','Ndlovu','Mahlangu','Zulu','Mthembu','Shabalala',
                      'Cele','Mbatha','Gumede','Majola','Mthethwa','Ngcobo','Ngema','Ntanzi','Mhlongo','Zungu',
                      'Buthelezi','Ntuli','Mabaso','Luthuli','Msweli','Mdlalose','Nxumalo','Mthiyane','Khoza','Hadebe',
                      'Mchunu','Dube','Ngubane','Madlala','Bhengu','Mhlanga','Mabika','Maphumulo','Gumbi','Zuma',
                      'Dlamini','Nkosi','Molefe','Khumalo','Sithole','Ndlovu','Mahlangu','Zulu','Mthembu','Shabalala',
                      'Cele','Mbatha','Gumede','Majola','Mthethwa','Ngcobo','Ngema','Ntanzi','Mhlongo','Zungu',
                      'Buthelezi','Ntuli','Mabaso','Luthuli','Msweli','Mdlalose','Nxumalo','Mthiyane','Khoza','Hadebe',
                      'Mchunu','Dube','Ngubane','Madlala','Bhengu','Mhlanga','Mabika','Maphumulo','Gumbi','Zuma',
                      'Dlamini','Nkosi','Molefe','Khumalo','Sithole','Ndlovu','Mahlangu','Zulu','Mthembu','Shabalala',
                      'Cele','Mbatha','Gumede','Majola','Mthethwa','Ngcobo','Ngema','Ntanzi','Mhlongo','Zungu'];

  console.log(`=== Onboarding ${CUSTOMER_COUNT} customers ===`);

  const customers = [];
  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const res = http.post(
      `${BASE_URL}/api/v1/customers`,
      JSON.stringify({
        firstName:    firstNames[i],
        lastName:     lastNames[i],
        mobileNumber: `082${suffix}${String(i).padStart(2, '0')}`.slice(0, 11),
        email:        `user${i}_${suffix}@loadtest.com`,
      }),
      { headers: authHeaders }
    );

    if (res.status === 201 || res.status === 200) {
      const c = JSON.parse(res.body);
      customers.push({ customerId: c.customerId });
      if ((i + 1) % 10 === 0) console.log(`  Onboarded ${i + 1}/${CUSTOMER_COUNT}`);
    } else {
      console.error(`  Failed customer ${i + 1}: ${res.status} ${res.body}`);
    }
    sleep(0.1);
  }

  // --- Fetch account numbers ---
  console.log('=== Fetching account numbers ===');

  const testData = [];
  for (const c of customers) {
    const res = http.get(
      `${BASE_URL}/api/v1/customers/${c.customerId}/accounts`,
      { headers: authHeaders }
    );
    if (res.status === 200) {
      const accounts = JSON.parse(res.body);
      if (accounts.length > 0) {
        testData.push({ customerId: c.customerId, accountNumber: accounts[0].accountNumber });
      }
    }
    sleep(0.1);
  }

  console.log(`=== Setup complete: ${testData.length} accounts ready ===`);
  return { testData };
}

// ==============================================================================
// Default — fires PAYMENTS_EACH payments to every account
// ==============================================================================

export default function (data) {
  if (!data.testData || data.testData.length === 0) {
    console.error('No test data — check setup logs');
    return;
  }

  let total = 0, success = 0;

  for (const target of data.testData) {
    for (let p = 0; p < PAYMENTS_EACH; p++) {
      const apiKey = p % 2 === 0 ? MPESA_API_KEY : MTN_API_KEY;

      const res = http.post(
        `${BASE_URL}/api/v1/accounts/${target.accountNumber}/payments`,
        JSON.stringify({
          paymentReference: `SEED-${target.accountNumber}-${p}-${Date.now()}`,
          amount: parseFloat((Math.random() * 490 + 10).toFixed(2)),
        }),
        { headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey } }
      );

      total++;
      if (res.status === 200) {
        success++;
      } else {
        console.error(`  Payment failed [acct ${target.accountNumber} #${p}]: ${res.status} ${res.body.substring(0, 120)}`);
      }
    }

    const idx = data.testData.indexOf(target) + 1;
    if (idx % 10 === 0) console.log(`  Seeded ${idx}/${data.testData.length} accounts (${success}/${total} ok)`);
  }

  console.log(`=== DONE: ${success}/${total} payments seeded ===`);
}

// ==============================================================================
// Teardown
// ==============================================================================

export function teardown(data) {
  console.log(`Seeded ${data.testData ? data.testData.length : 0} accounts x ${PAYMENTS_EACH} payments each.`);
  console.log('Check your DB — you should have ~6 000 payment rows.');
}