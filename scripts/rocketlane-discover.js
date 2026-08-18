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

(async () => {
  const categories = await get('/time-entries/categories?pageSize=100');
  console.log(JSON.stringify(categories, null, 2));
})().catch((err) => {
  console.error('Discovery run failed:', err.message);
  process.exit(1);
});
