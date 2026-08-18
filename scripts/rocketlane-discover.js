const API_KEY = process.env.ROCKETLANE_API_KEY;
const BASE = 'https://api.rocketlane.com/api/1.0';

async function get(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'api-key': API_KEY, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function show(title, data, max = 6000) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(data, null, 2).slice(0, max));
}

(async () => {
  const users = (await get('/users?status.eq=ACTIVE')).data || [];
  show(
    `Active users with role (${users.length} total, first 10)`,
    users.slice(0, 10).map((u) => ({
      userId: u.userId,
      email: u.email,
      name: `${u.firstName} ${u.lastName || ''}`.trim(),
      role: u.role,
      createdAt: u.createdAt,
    }))
  );

  const submitted = (
    await get(
      '/time-entries?approvalStatus.eq=SUBMITTED&includeFields=status,submittedBy,submittedAt,approvedBy,approvedAt'
    )
  ).data || [];
  show(`Submitted (pending) time entries (${submitted.length} found)`, submitted.slice(0, 5));
})().catch((err) => {
  console.error('Discovery run failed:', err.message);
  process.exit(1);
});
