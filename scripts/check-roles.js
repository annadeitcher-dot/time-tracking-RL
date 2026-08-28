const API_KEY = process.env.ROCKETLANE_API_KEY;
const BASE_URL = 'https://api.rocketlane.com/api/1.0';

async function main() {
  const usersRes = await fetch(`${BASE_URL}/users?includeFields=roleId&pageSize=5`, { headers: { 'api-key': API_KEY } });
  console.log('=== Users with roleId ===');
  console.log(await usersRes.text());

  const rolesRes = await fetch(`${BASE_URL}/roles`, { headers: { 'api-key': API_KEY } });
  console.log('=== Roles list ===');
  console.log(await rolesRes.text());
}

main().catch(err => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
