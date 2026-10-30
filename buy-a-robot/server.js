// buy-a-robot: one request that buys a robot, start to finish, through every service in the shop.
//
// It is the storefront's checkout with the browser taken out: where a person clicks through
// five pages, this makes the same calls in order and reports each one. It exists so that one
// send from Debugt draws the whole shop as a single trace — every service, and the calls the
// services make to each other underneath:
//
//   buy-a-robot ─┬─ catalogue-node   categories, products
//                ├─ catalogue-go     the product, from the Go twin of the same service
//                ├─ user             register, login            (history, at the end)
//                ├─ ratings          rate, fetch                └─ catalogue   (checks the SKU)
//                ├─ cart             add                        └─ catalogue   (looks the product up)
//                ├─ shipping         codes, match, calc, confirm └─ cart        (adds the shipping line)
//                └─ payment          pay                        ├─ user        (checks the user, saves the order)
//                                                               ├─ the payment gateway (paypal.com unless set)
//                                                               └─ cart        (empties it)
//
// No dependencies: Node's own http server and fetch. Where each service is comes from the
// environment, with this machine's ports from DEBUGT.md as the defaults.
//
//   POST /buy            buys one robot with a new user; every field of the body is optional:
//                        { "user", "password", "email", "sku", "qty", "score", "country", "city", "skip": ["ratings"] }
//   GET  /health         OK
'use strict';

const http = require('http');

const PORT = Number(process.env.BUY_SERVER_PORT || 8088);

const at = {
  catalogue: process.env.CATALOGUE_URL || 'http://localhost:8081',
  catalogueGo: process.env.CATALOGUE_GO_URL || 'http://localhost:8087',
  user: process.env.USER_URL || 'http://localhost:8082',
  cart: process.env.CART_URL || 'http://localhost:8083',
  payment: process.env.PAYMENT_URL || 'http://localhost:8084',
  shipping: process.env.SHIPPING_URL || 'http://localhost:8085',
  ratings: process.env.RATINGS_URL || 'http://localhost:8086',
};

/** A step that failed: what was asked, and what came back instead of what was needed. */
class StepFailed extends Error {}

/**
 * One purchase. `steps` is the report: each call as it was made, in order, whether or not the
 * ones after it were reached.
 */
async function buy(options) {
  const steps = [];
  const skip = new Set(Array.isArray(options.skip) ? options.skip : []);

  /** Makes one call and notes it. Anything but a 2xx stops the purchase, unless `allow` names the status. */
  async function call(service, method, path, { body, allow = [] } = {}) {
    const url = `${at[service]}${path}`;
    const started = Date.now();
    const step = { service, method, url };
    steps.push(step);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      step.ms = Date.now() - started;
      step.error = String((err.cause && err.cause.code) || err.message);
      throw new StepFailed(`${service} could not be reached at ${url} — is it running?`);
    }
    const text = await response.text();
    step.status = response.status;
    step.ms = Date.now() - started;
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON: several of the shop's services answer in plain text.
    }
    if (!response.ok && !allow.includes(response.status)) {
      step.error = typeof data === 'string' ? data.slice(0, 300) : data;
      throw new StepFailed(`${method} ${url} answered ${response.status}`);
    }
    return { status: response.status, data };
  }

  const result = { ok: false, steps };
  try {
    // 1. What is for sale — from the Node catalogue, then the same product from the Go one.
    await call('catalogue', 'GET', '/categories');
    const products = (await call('catalogue', 'GET', '/products')).data;
    const product = options.sku
      ? products.find((candidate) => candidate.sku === options.sku)
      : products.find((candidate) => candidate.instock > 0);
    if (!product) throw new StepFailed(options.sku ? `No product with SKU ${options.sku}` : 'Nothing is in stock');
    result.product = { sku: product.sku, name: product.name, price: product.price };
    if (!skip.has('catalogue-go')) await call('catalogueGo', 'GET', `/product/${product.sku}`);

    // 2. Who is buying. A new user each time unless one is named; one that exists already logs in.
    const name = options.user || `buyer-${Date.now().toString(36)}`;
    const password = options.password || 'secret';
    result.user = name;
    await call('user', 'POST', '/register', { body: { name, password, email: options.email || `${name}@example.com` }, allow: [400] });
    await call('user', 'POST', '/login', { body: { name, password } });

    // 3. A rating for the robot. Ratings checks the SKU with the catalogue before it saves.
    if (!skip.has('ratings')) {
      const score = Number(options.score) || 5;
      await call('ratings', 'PUT', `/api/rate/${product.sku}/${score}`);
      result.rating = (await call('ratings', 'GET', `/api/fetch/${product.sku}`)).data;
    }

    // 4. Into the cart. Cart looks the product up in the catalogue itself.
    const qty = Math.max(1, Number(options.qty) || 1);
    await call('cart', 'GET', `/add/${name}/${product.sku}/${qty}`);

    // 5. Where to send it, and what that costs. Confirming has shipping add its line to the cart.
    const codes = (await call('shipping', 'GET', '/codes')).data;
    const wanted = String(options.country || 'gb').toLowerCase();
    const country = codes.find((code) => String(code.code).toLowerCase() === wanted) || codes[0];
    if (!country) throw new StepFailed('Shipping knows no countries — is its database loaded?');
    const cities = (await call('shipping', 'GET', `/match/${country.code}/${encodeURIComponent(options.city || 'lon')}`)).data;
    const city = cities[0];
    if (!city) throw new StepFailed(`Shipping found no city in ${country.name} starting with "${options.city || 'lon'}"`);
    const quote = (await call('shipping', 'GET', `/calc/${city.uuid}`)).data;
    const location = `${country.name} ${city.name}`;
    result.shipping = { location, distance: quote.distance, cost: quote.cost };
    await call('shipping', 'POST', `/confirm/${name}`, { body: { distance: quote.distance, cost: quote.cost, location } });

    // 6. The cart as it now stands — the robot and the shipping — is what gets paid for.
    const cart = (await call('cart', 'GET', `/cart/${name}`)).data;
    result.total = cart.total;

    // 7. Pay. Payment checks the user, calls its gateway, queues the order for dispatch, saves it
    //    to the user's history and empties the cart.
    const paid = (await call('payment', 'POST', `/pay/${name}`, { body: cart })).data;
    result.orderid = paid.orderid;

    // 8. And the order is in the user's history.
    const history = (await call('user', 'GET', `/history/${name}`)).data;
    const orders = (history && history.history) || [];
    result.inHistory = orders.some((order) => order.orderid === paid.orderid);

    result.ok = true;
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    result.failed = err.message;
  }
  result.calls = steps.length;
  return result;
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      try {
        const parsed = text.trim() ? JSON.parse(text) : {};
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve(null);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  };
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  if (req.method === 'POST' && pathname === '/buy') {
    const options = await readBody(req);
    if (options === null) return send(400, { ok: false, failed: 'The body is not JSON' });
    try {
      const result = await buy(options);
      // 502 when a service underneath is what failed: this one did its part.
      return send(result.ok ? 200 : 502, result);
    } catch (err) {
      return send(500, { ok: false, failed: String(err && err.stack ? err.stack : err) });
    }
  }
  send(404, { ok: false, failed: 'POST /buy, or GET /health', services: at });
});

server.listen(PORT, () => {
  console.log(`buy-a-robot listening on ${PORT}`);
});
