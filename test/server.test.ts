import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { WebServer, type OfferPanel } from '../src/server.js';
import type { OfferSettings } from '../src/offers.js';

const settings: OfferSettings = { enabled: false, priceAmount: 20, currency: 'USD', quantity: 1, minQuantity: 1, deliveryTime: 'Day1', message: 'hi' };
const panel: OfferPanel = {
  get: () => settings,
  save: async () => ({ ok: true, value: settings }),
  categoryLabel: 'x',
  deliveryTimes: ['Day1'],
  currencies: ['USD'],
};

async function withServer(password: string | undefined, fn: (base: string) => Promise<void>) {
  const web = new WebServer(resolve('public', 'index.html'), 1000, panel, 200, password);
  await web.listen(0, '127.0.0.1');
  try {
    await fn(`http://127.0.0.1:${web.port}`);
  } finally {
    await web.close();
  }
}

test('with a password, the page and API require login', async () => {
  await withServer('correct horse battery', async (base) => {
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/login');

    const api = await fetch(`${base}/api/offer-settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eldo-page': '1' }, body: '{}' });
    assert.equal(api.status, 401);
    assert.equal((await fetch(`${base}/events`)).status, 401);

    const bad = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ password: 'nope' }), redirect: 'manual' });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ password: 'correct horse battery' }), redirect: 'manual' });
    assert.equal(good.status, 303);
    const cookie = good.headers.get('set-cookie')!.split(';')[0];
    assert.match(cookie, /^eldo_session=/);
    assert.match(good.headers.get('set-cookie')!, /HttpOnly/);

    const session = await fetch(`${base}/api/session`, { headers: { cookie } });
    assert.equal(session.status, 200);
    const home = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(home.status, 200);
  });
});

test('without a password (local-only mode) the page is open', async () => {
  await withServer(undefined, async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200);
  });
});
