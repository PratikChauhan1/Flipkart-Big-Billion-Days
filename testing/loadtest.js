import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// ==========================================
// TARGET APPLICATION LOAD BALANCER
// ==========================================
const BASE_URL = 'http://flipkart-alb-1911595787.ap-south-1.elb.amazonaws.com';

// ==========================================
// CUSTOM BIG BILLION DAY METRICS
// ==========================================
const orderQueueSuccess = new Counter('bbd_orders_placed');
const flashSaleErrors   = new Rate('bbd_error_rate');
const catalogLatency    = new Trend('bbd_catalog_latency_ms');
const checkoutLatency   = new Trend('bbd_checkout_latency_ms');
const authLatency       = new Trend('bbd_auth_latency_ms');

// ==========================================
// BIG BILLION DAY TRAFFIC PROFILE (TSUNAMI CURVE)
// ==========================================
export const options = {
  scenarios: {
    // SCENARIO 1: The Midnight Flash Sale Rush (Deal Hunters)
    // Simulates frantic shoppers spamming deals and checking out simultaneously
    flash_sale_rush: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '20s', target: 50 },   // 11:59 PM - Shoppers waiting & refreshing
        { duration: '20s', target: 250 },  // 12:00 AM - THE MIDNIGHT SPIKE! (Flash sale starts)
        { duration: '2m',  target: 350 },  // Peak rush - 350 users spamming deals & checkout
        { duration: '30s', target: 100 },  // Deal sold out - traffic subsides
        { duration: '20s', target: 0 },    // Cool-down
      ],
      exec: 'dealHunterFlow',
    },

    // SCENARIO 2: High-Volume Catalog Browsers (Window Shoppers)
    // 70% of e-commerce traffic is heavy read-traffic filtering categories
    window_shoppers: {
      executor: 'ramping-vus',
      startVUs: 20,
      stages: [
        { duration: '30s', target: 100 },  // Steady stream of browsers
        { duration: '2m',  target: 200 },  // Thousands browsing deals across categories
        { duration: '30s', target: 20 },   // Drop off
      ],
      exec: 'catalogBrowserFlow',
    },

    // SCENARIO 3: Customer Logins & Auth (CPU Math / Bcrypt Stress)
    // Repeated logins force AWS ECS containers to compute heavy password hashes
    auth_checkouts: {
      executor: 'constant-vus',
      vus: 25,
      duration: '3m',
      exec: 'customerAuthFlow',
    },
  },

  thresholds: {
    // 95% of catalog requests should be served under 400ms (ALB cache / fast Node response)
    'bbd_catalog_latency_ms': ['p(95)<400'],
    // 95% of checkouts into queue should take under 600ms
    'bbd_checkout_latency_ms': ['p(95)<600'],
    // Overall error rate should remain below 5% under extreme load
    'bbd_error_rate': ['rate<0.05'],
  },
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CATEGORIES = ['Mobiles', 'Electronics', 'Fashion', 'Appliances'];
const SEARCH_TERMS = ['iPhone', 'MacBook', 'Samsung', 'Nike', 'Sony', 'OLED', 'Watch'];

// =================================================================
// 🛒 FLOW 1: Deal Hunter (Aggressive Flash-Sale Shopper)
// =================================================================
export function dealHunterFlow() {
  group('⚡ Flash Sale Deal Hunting', function () {
    // 1. Rapidly check Big Billion Day deals
    const randomCat = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
    const dealStart = Date.now();
    const dealRes = http.get(`${BASE_URL}/api/products?category=${randomCat}`);
    catalogLatency.add(Date.now() - dealStart);

    check(dealRes, {
      'deal list 200': (r) => r.status === 200,
    }) || flashSaleErrors.add(1);

    // 2. Poll Order Queue health status (simulating live queue widget)
    http.get(`${BASE_URL}/api/orders/queue-stats`);

    // 3. Instant Rush Checkout into Order Queue (High Concurrency Rush)
    const burstCount = Math.floor(Math.random() * 5) + 3; // 3 to 7 simultaneous items
    const checkoutStart = Date.now();
    const burstRes = http.post(
      `${BASE_URL}/api/orders/simulate-burst`,
      JSON.stringify({ count: burstCount }),
      { headers: JSON_HEADERS }
    );
    checkoutLatency.add(Date.now() - checkoutStart);

    const isSuccess = check(burstRes, {
      'rush checkout enqueued 200': (r) => r.status === 200,
    });

    if (isSuccess) {
      orderQueueSuccess.add(burstCount);
    } else {
      flashSaleErrors.add(1);
    }

    // Fast aggressive clicker: 0.1s to 0.4s pause
    sleep(0.1 + Math.random() * 0.3);
  });
}

// =================================================================
// 📱 FLOW 2: Window Shopper (Catalog Search, Filter & View Details)
// =================================================================
export function catalogBrowserFlow() {
  group('🔍 Catalog Search & Discovery', function () {
    // 1. Search for specific hot items
    const query = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
    const searchStart = Date.now();
    const searchRes = http.get(`${BASE_URL}/api/products?search=${query}`);
    catalogLatency.add(Date.now() - searchStart);

    check(searchRes, {
      'search results 200': (r) => r.status === 200,
    }) || flashSaleErrors.add(1);

    // 2. Filter with price constraints & sorting
    http.get(`${BASE_URL}/api/products?minPrice=5000&maxPrice=100000&sort=price_asc`);

    // 3. Health check ping
    http.get(`${BASE_URL}/api/health`);

    // Casual browsing pause: 0.3s to 0.8s
    sleep(0.3 + Math.random() * 0.5);
  });
}

// =================================================================
// 🔐 FLOW 3: Customer Authentication & Order Tracking (CPU Stress)
// =================================================================
export function customerAuthFlow() {
  group('🔑 User Authentication & History', function () {
    // 1. Login with Bcrypt verification (Intentionally CPU-intensive for AWS)
    const authStart = Date.now();
    const loginRes = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({
        email: 'user@flipkart.com',
        password: 'user123',
      }),
      { headers: JSON_HEADERS }
    );
    authLatency.add(Date.now() - authStart);

    check(loginRes, {
      'login successful 200': (r) => r.status === 200,
    }) || flashSaleErrors.add(1);

    // 2. Check personal order history
    http.get(`${BASE_URL}/api/orders/my-orders?email=user@flipkart.com`);

    // Think time before next user login
    sleep(0.5);
  });
}
