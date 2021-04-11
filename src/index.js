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

// Util to suppress for Discord
const suppressLinks = text => text.replace(/(https?:\/\/\S+)/g, '<$1>')

// Util to escape Discord markdown in text
const escapeMarkdown = text => suppressLinks(text)
    .replace(/\\([*_`~\\])/g, '$1') // unescape already escaped chars
    .replace(/([*_`~\\])/g, '\\$1'); // escape all MD chars

// Util to add quote markdown to text
const quoteText = text => `> ${text.split('\n').join('\n> ')}`;

// Fetch latest Tweet data from Twitter
const fetchLatestTweets = since => {
    // Define the query params for the data we need
    const req = new URL(`https://api.twitter.com/2/users/${process.env.TWITTER_USER_ID}/tweets`);
    req.searchParams.set('max_results', '100');
    req.searchParams.set('tweet.fields', ['referenced_tweets', 'text', 'created_at', 'id', 'author_id'].join(','));
    req.searchParams.set('user.fields', ['username', 'profile_image_url'].join(','));
    req.searchParams.set('expansions', ['author_id', 'referenced_tweets.id', 'referenced_tweets.id.author_id'].join(','));
    if (since) req.searchParams.set('since_id', since);

    // Make the request with the OAuth 2 token
    return fetch(req.toString(), { headers: { Authorization: `Bearer ${process.env.TWITTER_BEARER_AUTH}` } })
        .then(req => req.json());
};

// Post tweet information to Discord
const postDiscordTweet = (type, content, links, username, avatar) => fetch(process.env.DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-type': 'application/json' },
    body: JSON.stringify({
        content: `**${type}**\n\n${quoteText(escapeMarkdown(content))}\n\n${suppressLinks(links)}`,
        username,
        avatar_url: avatar,
    }),
});

// Process a raw Tweet from Discord and send it to Discord
const processTweet = (tweet, includes) => {
    // Resolve the author of the tweet
    const author = includes.users.find(inclUser => inclUser.id === tweet.author_id);

    // Resolve any referenced tweet
    const refTweet = tweet.referenced_tweets && tweet.referenced_tweets.length
        ? includes.tweets.find(inclTweet => inclTweet.id === tweet.referenced_tweets[0].id)
        : null;
    const refType = refTweet ? tweet.referenced_tweets[0].type : null;
    const refAuthor = refTweet ? includes.users.find(inclUser => inclUser.id === refTweet.author_id) : null;

    // Determine the Discord title
    const title = refType === 'retweeted'
        ? '🔁 Retweeted'
        : refType === 'quoted'
            ? '📝 Quoted'
            : refType === 'replied_to'
                ? '⤴️ Replied'
                : '💬 Tweeted';

    // Determine what content to use
    const content = refType === 'retweeted' ? refTweet.text : tweet.text;

    // Determine what links to reference
    const links = refType === 'retweeted'
        ? `https://twitter.com/${refAuthor.username}/status/${refTweet.id}`
        : refType === 'quoted'
            ? `https://twitter.com/${author.username}/status/${tweet.id}\nQuoting https://twitter.com/${refAuthor.username}/status/${refTweet.id}`
            : refType === 'replied_to'
                ? `https://twitter.com/${author.username}/status/${tweet.id}\nReplying to https://twitter.com/${refAuthor.username}/status/${refTweet.id}`
                : `https://twitter.com/${author.username}/status/${tweet.id}`;

    // Post to Discord
    return postDiscordTweet(title, content, links, author.username, author.profile_image_url);
};

// Mirror latest tweets from Twitter to Discord
const mirrorLatestTweets = async () => {
    // Get the last tweet we processed
    const last = await TWEETS_TO_DISCORD_LAST_TWEET.get('latest_id');

    // Get new tweets since last processed (oldest first)
    const data = await fetchLatestTweets(last);
    const tweets = data.data ? data.data.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)) : [];

    // If we haven't run before, store the most recent tweet and abort
    if (!last && tweets.length) {
        await TWEETS_TO_DISCORD_LAST_TWEET.put('latest_id', tweets[tweets.length - 1].id);
        return;
    }

    // Process each tweet
    for (const tweet of tweets) {
        console.log(await processTweet(tweet, data.includes).then(res => res.text()));

        // Store this as the most recent tweet we've processed
        await TWEETS_TO_DISCORD_LAST_TWEET.put('latest_id', tweet.id);
    }
};

// Process all requests to the worker
const handleRequest = async ({ request, wait, sentry }) => {
    const url = new URL(request.url);

    // Health check route
    if (url.pathname === '/health') return textResponse('OK');

    // Execute triggers route
    if (url.pathname === '/execute') {
        // Trigger each workflow in the background after
        wait(mirrorLatestTweets().catch(err => {
            // Log & re-throw any errors
            console.error(err);
            sentry.captureException(err);
            throw err;
        }));
        return textResponse('Executed');
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
