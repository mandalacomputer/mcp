import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { runHttp } from '../src/http.js';

it('rejects an occupied port without announcing successful startup', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const port = (occupied.address() as AddressInfo).port;
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(runHttp({ port, host: '127.0.0.1' })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(log.mock.calls.some(([line]) => String(line).includes(' on http://'))).toBe(false);
  } finally {
    log.mockRestore();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});

it('resolves a listening server and closes it successfully', async () => {
  const server = await runHttp({ port: 0, host: '127.0.0.1' });
  expect(server.listening).toBe(true);
  expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  expect(server.listening).toBe(false);
});
