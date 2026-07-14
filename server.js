// v2
const http = require('http');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || '';

const mime = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

// 1. Remove Google Sign-In button + divider
const GOOGLE_BTN = [
  '        <!-- Social sign-in -->',
  '        <button class="auth-social-btn" id="google-btn">',
  '          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">',
  '            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>',
  '            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>',
  '            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>',
  '            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>',
  '          </svg>',
  '          Continue with Google',
  '        </button>',
  '        <div class="auth-divider">or sign in with email</div>',
  '        <!-- Email / password -->'
].join('\n');

// 2. Remove Google click handler JS
const GOOGLE_JS_OLD = [
  "    document.getElementById('google-btn').addEventListener('click', async () => {",
  "      const errEl = document.getElementById('auth-error');",
  "      errEl.textContent = '';",
  "      const { error } = await Auth.signInWithGoogle();",
  "      if (error) errEl.textContent = error.message;",
  "      // On success, Supabase redirects to the provider then back here;",
  "      // onAuthStateChange fires automatically when the page reloads.",
  "    });",
  "",
  "    document.getElementById('auth-btn')"
].join('\n');

// 3. Auto sign-in after signup (no email confirmation needed)
const SIGNUP_OLD = [
  "      const { error } = await Auth.signUp(email, password, { full_name: name });",
  "      if (error) { errEl.textContent = error.message; }",
  "      else { errEl.style.color = '#16A34A'; errEl.textContent = 'Check your email to confirm your account.'; }"
].join('\n');
const SIGNUP_NEW = [
  "      const { error } = await Auth.signUp(email, password, { full_name: name });",
  "      if (error) { errEl.textContent = error.message; return; }",
  "      const { error: signInErr } = await Auth.signIn(email, password);",
  "      if (signInErr) { errEl.textContent = signInErr.message; }"
].join('\n');

// 4. Fix Supabase session-lock deadlock in onAuthStateChange
const AUTH_DEADLOCK_OLD = [
  "    Auth.onAuthStateChange(async (event, session) => {",
  "      const overlay = document.getElementById('auth-overlay');",
  "      if (session?.user) {",
  "        currentUser = session.user;",
  "        overlay.classList.add('hidden');",
  "        document.getElementById('auth-error').textContent = '';",
  "        await loadOrgs();",
  "",
  "        // Show flash message if returning from Shopify OAuth",
  "        const flash = localStorage.getItem('flash_success');",
  "        if (flash) {",
  "          localStorage.removeItem('flash_success');",
  "          setTimeout(async () => {",
  "            document.getElementById('settings-modal').classList.remove('hidden');",
  "            await refreshSettingsData();",
  "          }, 500);",
  "        }",
  "      } else {"
].join('\n');
const AUTH_DEADLOCK_NEW = [
  "    Auth.onAuthStateChange((event, session) => {",
  "      const overlay = document.getElementById('auth-overlay');",
  "      if (session?.user) {",
  "        currentUser = session.user;",
  "        overlay.classList.add('hidden');",
  "        document.getElementById('auth-error').textContent = '';",
  "        // Defer to break Supabase session-lock chain (prevents deadlock)",
  "        setTimeout(async () => {",
  "          await loadOrgs();",
  "          const flash = localStorage.getItem('flash_success');",
  "          if (flash) {",
  "            localStorage.removeItem('flash_success');",
  "            setTimeout(async () => {",
  "              document.getElementById('settings-modal').classList.remove('hidden');",
  "              await refreshSettingsData();",
  "            }, 500);",
  "          }",
  "        }, 0);",
  "      } else {"
].join('\n');

// 5. Bypass navigator.locks in Supabase client (prevents cross-tab session lock deadlocks)
const CREATE_CLIENT_OLD = "    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);";
const CREATE_CLIENT_NEW = [
  "    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {",
  "      auth: { lock: async (n, t, fn) => fn() }",
  "    });"
].join('\n');

http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/dashboard.html';
  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath);
  const contentType = mime[ext] || 'text/plain';
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    if (ext === '.html') {
      if (SUPABASE_URL) {
        data = data.replace(/https:\/\/YOUR_PROJECT_REF\.supabase\.co/g, SUPABASE_URL);
        data = data.replace(/YOUR_ANON_KEY_HERE/g, SUPABASE_ANON);
      }
      data = data.replace(GOOGLE_BTN,        '        <!-- Email / password -->');
      data = data.replace(GOOGLE_JS_OLD,     "    document.getElementById('auth-btn')");
      data = data.replace(SIGNUP_OLD,        SIGNUP_NEW);
      data = data.replace(AUTH_DEADLOCK_OLD, AUTH_DEADLOCK_NEW);
      data = data.replace(CREATE_CLIENT_OLD, CREATE_CLIENT_NEW);
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}).listen(port, () => console.log('Listening on port ' + port));
