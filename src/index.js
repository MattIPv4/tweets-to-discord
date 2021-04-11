const WorkersSentry = require('workers-sentry/worker');

// Util to send a text response
const textResponse = content => new Response(content, {
    headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Expires': '0',
        'Surrogate-Control': 'no-store',
    },
});

// Util to send a JSON response
const jsonResponse = obj => new Response(JSON.stringify(obj), {
    headers: {
        'Content-Type': 'application/json',
    },
});

const fetchRecentTweets = lastId => fetch(
    `https://api.twitter.com/2/users/:id/tweets?limit=100${lastId ? `&since=${lastId}` : ''}`,
    { headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER_AUTH}` } },
).then(req => req.json());

const mirrorLatestTweets = async () => {
    const data = await fetchRecentTweets();
    console.log(data);
};

// Process all requests to the worker
const handleRequest = async ({ request, wait, sentry }) => {
    const url = new URL(request.url);

    // Health check route
    if (url.pathname === '/health') return textResponse('OK');

    // Execute triggers route
    if (url.pathname === '/execute') {
        // Trigger each workflow in the background after
        wait(mirrorLatestTweets().catch(err => sentry.captureException(err)));
        return jsonResponse({});
    }

    // Not found
    return new Response(null, { status: 404 });
};

// Register the worker listener
addEventListener('fetch', event => {
    // Start Sentry
    const sentry = new WorkersSentry(event, process.env.SENTRY_DSN);

    // Process the event
    return event.respondWith(handleRequest({
        request: event.request,
        wait: event.waitUntil.bind(event),
        sentry,
    }).catch(err => {
        // Log & re-throw any errors
        console.error(err);
        sentry.captureException(err);
        throw err;
    }));
});

// Also listen for a cron trigger
addEventListener('scheduled', event => {
    // Start Sentry
    const sentry = new WorkersSentry(event, process.env.SENTRY_DSN);

    // Process the event
    return event.waitUntil(mirrorLatestTweets().catch(err => {
        // Log & re-throw any errors
        console.error(err);
        sentry.captureException(err);
        throw err;
    }));
});
