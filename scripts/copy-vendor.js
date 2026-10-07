// Copies browser vendor files into public/ so Vercel's CDN can serve them.
// Locally, server.js serves them straight from node_modules.
const fs = require('fs');
const path = require('path');

const dest = path.join(__dirname, '..', 'public', 'app', 'vendor');
fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(require.resolve('lucide/dist/umd/lucide.js'), path.join(dest, 'lucide.js'));
console.log('Copied lucide.js to public/app/vendor/');
