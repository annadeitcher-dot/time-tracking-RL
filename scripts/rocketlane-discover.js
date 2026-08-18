const API_KEY = process.env.ROCKETLANE_API_KEY;
const BASE = 'https://api.rocketlane.com/api/1.0';

if (!API_KEY) {
  console.error('Missing ROCKETLANE_API_KEY');
  process.exit(1);
}

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
  const fields = await get('/fields');
  const byType = {};
  for (const f of fields.data || []) (byType[f.objectType] ||= []).push(f);
  show('Object types seen in /fields', Object.keys(byType));
  show('USER fields', byType['USER'] || []);

  const timeEntries = (await get('/time-entries')).data || [];
  show('Time entries (first 5, raw)', timeEntries.slice(0, 5));

  const projects = (await get('/projects')).data || [];
  show(
    'Projects (summarized, first 8)',
    projects.slice(0, 8).map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      archived: p.archived,
      projectTypeField: (p.fields || []).find((f) => f.fieldLabel === 'Project Type'),
    }))
  );

  try {
    const users = (await get('/users')).data || [];
    show('Users (first 5, raw)', users.slice(0, 5));
  } catch (err) {
    show('Users endpoint error', { message: err.message });
  }
})().catch((err) => {
  console.error('Discovery run failed:', err.message);
  process.exit(1);
});
