#!/usr/bin/env node
/**
 * Loads the twelve authored inspection scenarios (three per room tier) and the
 * three custom fault categories they use into a running stack, through the same
 * management API the Scenario Maker saves with.
 *
 *   node scripts/seed-tier-scenarios.mjs --dry-run     # prints the plan, changes nothing
 *   node scripts/seed-tier-scenarios.mjs               # applies it
 *
 * The scenarios themselves live in web/src/sim/inspection/tierScenarios.js, which
 * is what the test suite checks. This file only delivers them.
 *
 * Options:
 *   --url=http://localhost:8080     gateway base URL (or GATEWAY_URL)
 *   --username=admin --password=…   (defaults to ADMIN_INITIAL_PASSWORD from .env)
 *   --only=STD-1,DLX-3              load just these scenario keys
 *   --dry-run                       log in and read, but write nothing
 *
 * Safe to re-run. A category is matched by its label, so an existing one is
 * reused rather than duplicated. A scenario is matched by its name, so a re-run
 * UPDATES it in place: edits made in the Scenario Maker to one of these twelve
 * are overwritten, which is what makes the data file the source of truth.
 * Scenarios with any other name are never touched.
 */

import { readFileSync } from 'node:fs';
import { CATEGORIES, SCENARIOS, toPayload } from '../web/src/sim/inspection/tierScenarios.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const BASE = args.url || process.env.GATEWAY_URL || 'http://localhost:8080';
const DRY = !!args['dry-run'];
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const head = (t) => console.log(`\n${c.bold}${c.cyan}── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}${c.reset}`);
const ok = (t) => console.log(`  ${c.green}✓${c.reset} ${t}`);
const bad = (t) => console.log(`  ${c.red}✗${c.reset} ${t}`);
const note = (t) => console.log(`  ${c.dim}~ ${t}${c.reset}`);

// Same resolution order as seed-multilane.mjs.
function resolveAdminPassword(flag) {
  if (flag && flag !== true) return String(flag);
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (process.env.ADMIN_INITIAL_PASSWORD) return process.env.ADMIN_INITIAL_PASSWORD;
  try {
    const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('ADMIN_INITIAL_PASSWORD='));
    if (line) return line.slice('ADMIN_INITIAL_PASSWORD='.length).trim();
  } catch { /* no .env — fall through */ }
  console.error('No admin password available. Run `bash scripts/gen-env.sh`, or pass');
  console.error('--password=… / ADMIN_PASSWORD=… (the CURRENT password if it was changed).');
  process.exit(2);
}

const USERNAME = args.username || 'admin';
const PASSWORD = resolveAdminPassword(args.password);
let token = null;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return parsed;
}

const labelKey = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

async function main() {
  head('Sign in');
  try {
    const login = await api('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
    token = login.token || login.accessToken;
    if (!token) throw new Error('login returned no token');
    ok(`authenticated as ${USERNAME} at ${BASE}${DRY ? '  (dry run — nothing will be written)' : ''}`);
  } catch (e) {
    bad(`login failed: ${e.message}`);
    console.log(`\n${c.yellow}Is the stack up? Try: docker compose up -d${c.reset}\n`);
    process.exit(2);
  }

  // ── Categories ────────────────────────────────────────────────────────────
  head('Fault categories');
  const existing = await api('GET', '/api/training/categories?all=true');
  const categoryIds = {};
  for (const cat of CATEGORIES) {
    const found = existing.find((r) => labelKey(r.label) === labelKey(cat.label));
    if (found && found.active) {
      categoryIds[cat.key] = found.id;
      note(`"${cat.label}" already exists (${found.id}) — reused`);
      continue;
    }
    if (DRY) {
      categoryIds[cat.key] = found?.id || `custom_${cat.key}`;
      note(`would ${found ? 'revive' : 'create'} "${cat.label}"`);
      continue;
    }
    const saved = await api('POST', '/api/training/categories', {
      ...(found ? { id: found.id } : {}),
      label: cat.label,
      why: cat.why,
      feedback: cat.feedback,
    });
    categoryIds[cat.key] = saved.id;
    ok(`${found ? 'revived' : 'created'} "${cat.label}" (${saved.id})`);
  }

  // ── Scenarios ─────────────────────────────────────────────────────────────
  head('Scenarios');
  const rows = await api('GET', '/api/training/scenarios');
  const todo = SCENARIOS.filter((s) => !ONLY || ONLY.has(s.key));
  let created = 0;
  let updated = 0;
  let failed = 0;
  for (const def of todo) {
    const payload = toPayload(def, categoryIds);
    const found = rows.find((r) => r.name === def.name && r.roomTier === def.roomTier);
    const faults = payload.tags.filter((t) => t.defectId).length;
    const detail = `${faults} faults, ${payload.tags.length - faults} decoys`;
    if (DRY) {
      note(`would ${found ? 'update' : 'create'} ${def.name} [${def.roomTier}] — ${detail}`);
      continue;
    }
    try {
      if (found) {
        await api('PATCH', `/api/training/scenarios/${found.id}`, { ...payload, active: true });
        updated += 1;
        ok(`updated ${def.name} [${def.roomTier}] — ${detail}`);
      } else {
        await api('POST', '/api/training/scenarios', payload);
        created += 1;
        ok(`created ${def.name} [${def.roomTier}] — ${detail}`);
      }
    } catch (e) {
      failed += 1;
      bad(`${def.name}: ${e.message}`);
    }
  }

  head('Done');
  if (DRY) console.log(`  dry run: ${todo.length} scenario(s) checked, nothing written.\n`);
  else console.log(`  ${created} created, ${updated} updated, ${failed} failed.\n`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  bad(e.message);
  process.exit(1);
});
