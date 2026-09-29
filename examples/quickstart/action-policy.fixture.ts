import { createServer } from 'node:http';

export async function startActionPolicyFixture() {
  let deleteCount = 0;
  let viewCount = 0;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'POST' && request.url === '/api/delete') {
      deleteCount++;
      response.writeHead(200).end();
      return;
    }
    if (request.method === 'POST' && request.url === '/api/view') {
      viewCount++;
      response.writeHead(200).end();
      return;
    }
    if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (request.method !== 'GET' || request.url !== '/') { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html lang="en"><title>Order controls</title>
      <h1>Orders</h1>
      <button id="delete">Delete all orders</button>
      <button id="view">View orders</button>
      <p role="status"></p>
      <script>
        document.querySelector('#delete').addEventListener('click', async () => {
          await fetch('/api/delete', { method: 'POST' });
          document.querySelector('[role=status]').textContent = 'Orders deleted';
        });
        document.querySelector('#view').addEventListener('click', async () => {
          await fetch('/api/view', { method: 'POST' });
          document.querySelector('[role=status]').textContent = 'Orders viewed';
        });
      </script></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind to a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state: () => ({ deleteCount, viewCount }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
