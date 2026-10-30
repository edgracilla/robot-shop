# Running Robot Shop under Debugt

Six of the shop's services run on this machine, started from VS Code by Debugt — three Node,
one Python, one Java (`shipping`) and one PHP (`ratings`). The first five have their hops traced
and their code recorded; `ratings` has the requests into it traced, and no more (see the notes).
Everything else stays in Docker.

| Runs from VS Code (Debugt) | Port | Stays in Docker |
|---|---|---|
| `catalogue` (Node) | 8081 | `mongodb` (published on 27018), `redis` (6379), `rabbitmq` (5672, console on 15672) |
| `user` (Node) | 8082 | `mysql` (3306), `dispatch` (Go) |
| `cart` (Node) | 8083 | `web` — the storefront, http://localhost:8080 |
| `payment` (Python) | 8084 | |
| `shipping` (Java) | 8085 | |
| `ratings` (PHP) | 8086 | |

## Start

1. The Docker side — note the list leaves out the six services above:

   ```bash
   docker compose -f docker-compose.yaml -f docker-compose.debugt.yaml up -d mongodb redis rabbitmq mysql dispatch web
   ```

2. Open this folder in VS Code. Its launch configurations (`.vscode/launch.json`) are the six
   services; Debugt lists them under Services.

3. In Debugt, put the six on a canvas. Each is an **API**; give each its host:

   | Service | Host |
   |---|---|
   | catalogue | `http://localhost:8081` |
   | user | `http://localhost:8082` |
   | cart | `http://localhost:8083` |
   | payment | `http://localhost:8084` |
   | shipping | `http://localhost:8085` |
   | ratings | `http://localhost:8086` |

4. Draw three lines. The services call each other by their Docker names on port 8080, which is
   written into their code; each line is the redirect that sends that call to the local port.

   | Line | Redirect calls to | To |
   |---|---|---|
   | cart → catalogue | `http://catalogue:8080` | `http://localhost:8081` |
   | payment → user | `http://user:8080` | `http://localhost:8082` |
   | payment → cart | `http://cart:8080` | `http://localhost:8083` |

   `shipping` needs no line: where it finds the cart is an environment variable, set in its
   launch configuration.

5. Run all.

## Use

- The storefront, http://localhost:8080, now goes through the local services: browsing hits
  `catalogue`, the cart hits `cart`, logging in hits `user`, shipping hits `shipping`, paying hits `payment`.
- Or send requests from Debugt's runner straight to a service — `GET /products` on catalogue,
  `GET /add/<id>/<sku>/1` on cart, `POST /pay/<id>` on payment with the cart as its body.
- An order end to end: `GET /api/user/uniqueid` → `GET /api/cart/add/<id>/HPTD/1` →
  `POST /api/shipping/confirm/<id>` with `{"distance": 100, "cost": 5, "location": "Somewhere"}` →
  `POST /api/payment/pay/<id>` with what confirm returned. `payment` then calls `user` twice, the
  payment gateway, and `cart`, and publishes the order to RabbitMQ, where `dispatch` logs it.
- `POST /api/payment/pay/partner-57` is written to fail.

## One send through everything: buy-a-robot

`buy-a-robot` is not one of the shop's services. It is the checkout with the browser taken out:
one request to it makes every call a purchase makes, in order, so a single send from Debugt
draws the whole shop as one trace — including the calls the services make to each other.

It is the last launch configuration, a Node service on port 8088 with no dependencies to
install. Put it on the canvas as an **API** with host `http://localhost:8088`, run it with the
rest, and send:

```
POST http://localhost:8088/buy
Content-Type: application/json

{}
```

An empty body buys one robot — the first in stock — as a new user, shipped to London. What that
calls, and what each of those calls underneath:

| buy-a-robot calls | For | Which itself calls |
|---|---|---|
| catalogue (Node) | categories, products | |
| catalogue (Go) | the product | |
| user | register, login, and the order history at the end | |
| ratings | rate, fetch | catalogue, to check the SKU (made with curl: not in the trace) |
| cart | add, then read the cart | catalogue, to look the product up |
| shipping | codes, match, calc, confirm | cart, to add the shipping line |
| payment | pay | user (check, then save the order), the payment gateway, cart (empty it) — and queues the order for `dispatch` |

Every field of the body is optional:

| Field | Default | |
|---|---|---|
| `user`, `password`, `email` | a new `buyer-…` user | an existing user logs in instead |
| `sku` | the first product in stock | |
| `qty` | 1 | |
| `score` | 5 | the rating given, 1–5 |
| `country`, `city` | `gb`, `lon` | a country code, and the first three or more letters of a city |
| `skip` | none | `["ratings"]` and/or `["catalogue-go"]`, for when one is not running |

The answer is the report: each call with its status and time, then the order id, the total and
whether the order reached the user's history. It stops at the first call that fails, says which,
and answers 502.

It finds the services on this machine's ports (8081–8087), so it needs no lines drawn out of it;
`CATALOGUE_URL`, `CATALOGUE_GO_URL`, `USER_URL`, `CART_URL`, `PAYMENT_URL`, `SHIPPING_URL` and
`RATINGS_URL` in its launch configuration move any of them.

## Notes

- First time only: `npm install` in `catalogue`, `user` and `cart`; and for `payment`,
  `python3 -m venv .venv && .venv/bin/pip install Flask requests pika prometheus_client opentracing instana`.
- `shipping` needs a JDK (11 or 17) and VS Code's Java extensions, `redhat.java` and
  `vscjava.vscode-java-debug`. They build it from `shipping/pom.xml`; the first time, that means
  downloading its dependencies, and Run fails until it is done — watch the Java status in VS
  Code's status bar.
- Each service logs that it cannot reach an Instana agent. There is none; it is harmless.
- `payment` calls its "payment gateway" on every order — `https://paypal.com/` unless
  `PAYMENT_GATEWAY` is set in its launch configuration.
- To go back to the stock shop: `docker compose down`, then `docker compose up -d`.
- `ratings` needs PHP with Xdebug on this machine, and VS Code's PHP Debug extension
  (`xdebug.php-debug`). Once:

  ```bash
  brew install php composer
  pecl install xdebug
  cd ratings/html && composer install --ignore-platform-req=php
  ```

  `--ignore-platform-req=php` because the project asks for PHP 7.4 and Homebrew's is 8; it was
  written for Symfony 5, which runs on both. It keeps its scores in the `ratings` database of the
  `mysql` container, on port 3306.
- What Debugt shows of `ratings`: each request into it, with its body and its answer. Not the
  call it makes to `catalogue` to check a SKU — that one is made with curl directly, which a PHP
  tracer cannot see — and not what its code did. Where it finds `catalogue` is an environment
  variable in its launch configuration, so it needs no line on the canvas, and a line drawn out
  of it would not be applied.
- Called directly, its paths start with `/api`: `PUT http://localhost:8086/api/rate/HPTD/5`,
  `GET http://localhost:8086/api/fetch/HPTD`. Through the storefront that is
  `/api/ratings/api/…`.
