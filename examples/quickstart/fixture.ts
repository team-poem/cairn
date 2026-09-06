import { createServer } from 'node:http';

export const BASE_URL = 'http://127.0.0.1:4318';

/** Deliberately visits /success even after a failed POST: navigation alone is insufficient proof. */
export async function startFixture(broken = false) {
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/api/submit' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        response.writeHead(broken ? 500 : body === 'Cairn' ? 200 : 400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ saved: !broken && body === 'Cairn' }));
      });
      return;
    }
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/success') {
      response.end('<!doctype html><html lang="en"><title>Submission complete</title><h1>Success page</h1></html>');
      return;
    }
    if (request.url !== '/') { response.writeHead(404).end(); return; }
    response.end(`<!doctype html><html lang="en"><title>Cairn quickstart</title>
      <form><label>Name <input name="name" required></label><button>Submit</button></form>
      <script>document.querySelector('form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await fetch('/api/submit', { method: 'POST', body: event.target.elements.name.value });
        history.pushState({}, '', '/success');
        document.body.innerHTML = '<h1>Success page</h1>';
      });</script></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(4318, '127.0.0.1', resolve);
  });
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
