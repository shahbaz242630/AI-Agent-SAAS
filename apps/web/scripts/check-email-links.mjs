#!/usr/bin/env node
/**
 * Does a deployed Eva send people somewhere real after they click a link in one
 * of its emails?
 *
 * ⚠️ RUN THIS AGAINST THE TARGET BEFORE AND AFTER EVERY DEPLOY THAT TOUCHES
 * AUTH. On 2026-08-11 it took one request to prove what an hour of reading code
 * had not: production answered
 *
 *     location: https://localhost:8080/reset-password?error=link
 *
 * for a link that had just been emailed to a real person. Two dead-link defects
 * shipped on consecutive days, both past a green CI run, both found by a human
 * clicking. Unit tests cannot see this one — it is a property of the deployed
 * environment's configuration, not of the code.
 *
 * ⚠️ AND RUN IT BEFORE THE FIX TOO. A check that has only ever passed proves
 * nothing; this one is expected to FAIL against any deployment that predates
 * `WEB_PUBLIC_ORIGIN`.
 *
 *   node apps/web/scripts/check-email-links.mjs https://web-production-15df9.up.railway.app
 */

const target = process.argv[2];
if (!target) {
  console.error("usage: check-email-links.mjs <origin>   e.g. https://eva.example.com");
  process.exit(2);
}

const origin = new URL(target).origin;

/**
 * A deliberately spent/invalid token. The interesting half is not whether the
 * token works — it cannot — but WHERE the answer points: the failure redirect
 * is built from the same origin as the success redirect, so it proves the same
 * property without needing a live token or burning one of the two auth emails
 * Supabase allows per hour.
 */
const probes = [
  { name: "recovery link", path: "/auth/confirm?next=%2Fnew-password&code=probe-not-a-real-code" },
  { name: "confirmation link", path: "/auth/confirm?next=%2Fapp&code=probe-not-a-real-code" },
  {
    name: "recovery link (token_hash form)",
    path: "/auth/confirm?next=%2Fnew-password&type=recovery&token_hash=probe",
  },
];

let failures = 0;

for (const probe of probes) {
  const url = `${origin}${probe.path}`;
  let response;
  try {
    response = await fetch(url, { redirect: "manual" });
  } catch (error) {
    console.error(`✗ ${probe.name}: could not reach ${url} — ${error.message}`);
    failures += 1;
    continue;
  }

  const location = response.headers.get("location");
  if (!location) {
    console.error(`✗ ${probe.name}: answered ${response.status} with no redirect at all`);
    failures += 1;
    continue;
  }

  // A relative Location is same-origin by definition and always fine.
  const destination = new URL(location, origin);
  if (destination.origin !== origin) {
    console.error(
      `✗ ${probe.name}: sends people to ${destination.origin} — expected ${origin}\n` +
        `    full location: ${location}\n` +
        `    Set WEB_PUBLIC_ORIGIN on this service to ${origin} and redeploy.`,
    );
    failures += 1;
    continue;
  }

  console.log(`✓ ${probe.name} → ${destination.pathname}${destination.search}`);
}

if (failures > 0) {
  console.error(
    `\n${failures} of ${probes.length} email links land somewhere that is not ${origin}.`,
  );
  process.exit(1);
}

console.log(`\nAll ${probes.length} email links stay on ${origin}.`);
