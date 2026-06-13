// Shared in-memory user store for Vercel serverless functions.
// NOTE: state lives only inside a single warm function instance — cold starts wipe it.
// Good enough for the demo URL; for real persistence use Vercel KV / Postgres / Redis.
if (!global.__rtcUsers) global.__rtcUsers = {};
module.exports = global.__rtcUsers;
