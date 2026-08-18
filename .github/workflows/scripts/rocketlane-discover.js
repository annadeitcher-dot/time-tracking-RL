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

function show(title, data) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(data, null, 2).slice(0, 4000));
}

(async () => {
  show('Fields', await get('/fields'));
  show('Time entries (sample)', await get('/time-entries?limit=10'));
  show('Projects (sample)', await get('/projects?limit=5'));
})().catch((err) => {
  console.error('Discovery run failed:', err.message);
  process.exit(1);
});
