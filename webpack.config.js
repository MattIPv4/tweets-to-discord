const path = require('path');
const env = require('dotenv').config({ path: path.join(__dirname, `${process.env.NODE_ENV}.env`) });
const { DefinePlugin } = require('webpack');
const WorkersSentryWebpackPlugin = require('workers-sentry/webpack');

module.exports = {
    entry: './src/index.js',
    plugins: [
        // Expose our environment in the worker
        new DefinePlugin(Object.entries(env.parsed).reduce((obj, [ key, val ]) => {
            obj[`process.env.${key}`] = JSON.stringify(val);
            return obj;
        }, { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV) })),

        // Publish source maps to Sentry on each build
        new WorkersSentryWebpackPlugin(
            process.env.SENTRY_AUTH_TOKEN,
            process.env.SENTRY_ORG,
            process.env.SENTRY_PROJECT,
        ),
    ],
};
