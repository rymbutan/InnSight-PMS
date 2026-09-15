// Messaging has no reference data to seed.
//
// Every other service seeds the rows its domain cannot start without — room
// types, roles, categories. Messaging owns only conversations, which are written
// by the people having them, and a mirror of the user directory, which
// src/subscribers/redis.subscriber.js backfills from auth-service on boot.
// Seeding either one would be inventing data nobody said.
//
// The file exists because scripts/db-seed.sh drives an array of service names
// and runs `npm run db:seed` for each; a missing script would fail that loop.
console.log('[Messaging] Nothing to seed — conversations are user-written and the directory mirrors auth.');
