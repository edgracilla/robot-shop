// The dispatch service: a port of ../dispatch/main.go to Node.
//
// It takes orders off RabbitMQ — the `orders` queue, bound to the `robot-shop` exchange, which
// is where payment publishes each order it takes — and "dispatches" each one, which in this
// shop means logging it and spending a little time on it. The same queue, exchange and
// binding, the same environment variables and the same things said in the log, so it can stand
// in for the Go service wherever that one runs.
//
// What is not carried over is the Instana tracer. The Go service's two functions, createSpan
// and processSale, were named for the spans they opened; here they keep their names and what
// else they did — the wait, and the share of orders that fail — without the spans. Whether an
// order arrived with a trace behind it is still told from its headers, and still logged.
//
// One thing is deliberately not the same: an order whose body is JSON but not an object, or
// has no `orderid` that is a string, stopped the Go service outright — an unchecked type
// assertion. Here it is an order with an unknown id, like one that is not JSON at all.

const amqp = require('amqplib');
const pino = require('pino');

const logger = pino({
    level: 'info',
    prettyPrint: false,
    useLevelLabels: true
});

const amqpHost = process.env.AMQP_HOST || 'rabbitmq';
const amqpUri = `amqp://guest:guest@${amqpHost}:5672/`;

// The share of orders that fail to dispatch, out of a hundred: nothing but 0 to 100, and 0
// for anything that is not a whole number.
var errorPercent = 0;
if (process.env.DISPATCH_ERROR_PERCENT !== undefined) {
    const epct = process.env.DISPATCH_ERROR_PERCENT;
    if (/^[+-]?\d+$/.test(epct.trim())) {
        errorPercent = Math.min(100, Math.max(0, parseInt(epct, 10)));
    }
}

const dataCenters = [
    'asia-northeast2',
    'asia-south1',
    'europe-west3',
    'us-east1',
    'us-west1'
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Whole numbers from 0 up to, and not including, n.
function randomInt(n) {
    return Math.floor(Math.random() * n);
}

function failOnError(err, msg) {
    if (err) {
        logger.fatal(`${msg} : ${err}`);
        process.exit(1);
    }
}

// Tries until it is connected, once a second.
async function connectToRabbitMQ(uri) {
    for (;;) {
        try {
            return await amqp.connect(uri);
        } catch (err) {
            logger.error(String(err));
            logger.info(`Reconnecting to ${uri}`);
            await sleep(1000);
        }
    }
}

function getOrderId(order) {
    var id = 'unknown';
    try {
        const m = JSON.parse(order.toString());
        if (m && typeof m.orderid === 'string') {
            id = m.orderid;
        }
    } catch (err) {
        // Not JSON: an order with an unknown id.
    }
    return id;
}

// Whether the order came with a trace to carry on: the headers Instana's tracer reads, and
// the W3C one. The Go service asked its tracer; with no tracer, the headers are asked.
function hasTraceContext(headers) {
    const names = Object.keys(headers || {}).map((name) => name.toLowerCase());
    return names.includes('x-instana-t') || names.includes('traceparent');
}

async function createSpan(headers, order) {
    // get the order id
    logger.info(`order ${order}`);

    var datacenter;
    if (hasTraceContext(headers)) {
        logger.info('Creating child span');
        datacenter = dataCenters[randomInt(dataCenters.length)];
    } else {
        logger.info('Failed to get context from headers');
        logger.info('Creating root span');
    }

    await sleep(42 + randomInt(42));
    if (randomInt(100) < errorPercent) {
        logger.info({ orderid: order, datacenter: datacenter, 'error.kind': 'Exception', message: 'Failed to dispatch to SOP' }, 'Span tagged with error');
    }

    await processSale(order);
}

async function processSale(order) {
    logger.info({ orderid: order }, 'Order sent for processing');
    await sleep(42 + randomInt(42));
}

// Connects, declares what the queue hangs off, and takes orders until the connection goes —
// then does it all again.
async function rabbitConnector(uri) {
    for (;;) {
        logger.info(`Connecting to ${amqpUri}`);
        const rabbitConn = await connectToRabbitMQ(uri);
        const closed = new Promise((resolve) => {
            rabbitConn.on('close', resolve);
            // An error is followed by a close; this is only so it is not thrown for want of a listener.
            rabbitConn.on('error', (err) => logger.error(String(err)));
        });

        var rabbitChan;
        try {
            // create mappings here
            rabbitChan = await rabbitConn.createChannel();
        } catch (err) {
            failOnError(err, 'Failed to create channel');
        }

        // create exchange
        await rabbitChan.assertExchange('robot-shop', 'direct', { durable: true })
            .catch((err) => failOnError(err, 'Failed to create exchange'));

        // create queue
        const queue = await rabbitChan.assertQueue('orders', { durable: true })
            .catch((err) => failOnError(err, 'Failed to create queue'));

        // bind queue to exchange
        await rabbitChan.bindQueue(queue.queue, 'robot-shop', 'orders')
            .catch((err) => failOnError(err, 'Failed to bind queue'));

        logger.info('Rabbit MQ ready true');

        // subscribe to bound queue
        await rabbitChan.consume('orders', (d) => {
            // The broker cancelled the consumer: nothing to dispatch.
            if (d === null) {
                return;
            }
            logger.info(`Order ${d.content}`);
            logger.info({ headers: d.properties.headers || {} }, 'Headers');
            const id = getOrderId(d.content);
            // Not waited for: each order is dispatched in its own time, as each had its own goroutine.
            createSpan(d.properties.headers, id).catch((err) => logger.error(String(err)));
        }, { noAck: true })
            .catch((err) => failOnError(err, 'Failed to consume'));

        await closed;
    }
}

logger.info(`Error Percent is ${errorPercent}`);

rabbitConnector(amqpUri).catch((err) => failOnError(err, 'Failed to connect'));

logger.info('Waiting for messages');
