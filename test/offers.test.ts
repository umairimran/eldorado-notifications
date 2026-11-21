import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager } from '../src/auth.js';
import type { HttpClient, HttpRequest } from '../src/http.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OFFER_CATEGORIES,
  OfferSender,
  buildOfferBody,
  loadCategorySettings,
  matchBoostingRequest,
  parseBoostingRequest,
  saveCategorySettings,
  validateOfferSettings,
  type OfferConfig,
} from '../src/offers.js';
import type { NotificationItem } from '../src/notifications.js';

const cfg: OfferConfig = {
  gameId: '16',
  boostingCategoryId: '6',
  priceAmount: 20,
  currency: 'USD',
  quantity: 1,
  minQuantity: 1,
  deliveryTime: 'Day1',
  message: 'hello buyer',
};

const boosting = (detailsId: string, categoryId: string, gameId = '16', event = 'BoostingRequestCreated'): NotificationItem => ({
  customNotification: null,
  notification: {
    id: 'n-' + detailsId,
    event,
    notificationDate: '2026-11-21T10:00:00Z',
    details: { detailsId, gameId, gameCategoryTitle: 'x' },
    customNotificationData: { gameId, boostingCategoryId: categoryId },
  },
});

test('only matches BoostingRequestCreated in the configured game + category', () => {
  assert.equal(matchBoostingRequest(boosting('req-1', '6'), cfg), 'req-1');
  assert.equal(matchBoostingRequest(boosting('req-2', '0'), cfg), undefined); // Battle Royale Rank Boost
  assert.equal(matchBoostingRequest(boosting('req-3', '3'), cfg), undefined); // Tournament Boost
  assert.equal(matchBoostingRequest(boosting('req-4', '6', '99'), cfg), undefined); // other game
  assert.equal(matchBoostingRequest(boosting('req-5', '6', '16', 'OrderCreated'), cfg), undefined);
});

test('offer body matches the documented BoostingOfferPostPrivateDTO', () => {
  assert.deepEqual(JSON.parse(buildOfferBody('req-1', cfg)), {
    details: {
      boostingRequestId: 'req-1',
      guaranteedDeliveryTime: 'Day1',
      pricing: { quantity: 1, minQuantity: 1, pricePerUnit: { amount: 20, currency: 'USD' } },
      message: 'hello buyer',
    },
  });
});

function setup(postStatus: number[]) {
  const requests: HttpRequest[] = [];
  const statuses = [...postStatus];
  const http: HttpClient = async (req) => {
    requests.push(req);
    if (req.url.endsWith('/seller/token')) return { status: 200, headers: {}, body: JSON.stringify({ accessToken: 't', expiresIn: 900 }), rttMs: 1 };
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
    return { status, headers: {}, body: status === 201 ? JSON.stringify({ id: 'offer-1' }) : '{"title":"Bad Request"}', rttMs: 5 };
  };
  const tokens = new TokenManager({ http, baseUrl: 'https://x.test', clientId: 'a', clientSecret: 'b' });
  const sender = new OfferSender(http, tokens, 'https://x.test', cfg, undefined, async () => {});
  return { sender, requests, tokens };
}

test('sends exactly one offer per boosting request', async () => {
  const { sender, requests, tokens } = setup([201]);
  try {
    const [a, b] = await Promise.all([sender.send('req-1'), sender.send('req-1')]);
    const again = await sender.send('req-1');
    const offers = requests.filter((r) => r.url === 'https://x.test/api/boostingOffers');
    assert.equal(offers.length, 1);
    assert.equal(offers[0].method, 'POST');
    assert.equal([a, b].filter(Boolean).length, 1);
    assert.equal(again, undefined);
    assert.equal((a ?? b)!.offerId, 'offer-1');
  } finally {
    tokens.stop();
  }
});

test('4xx rejections are reported and not retried', async () => {
  const { sender, requests, tokens } = setup([400]);
  try {
    const r = await sender.send('req-9');
    assert.equal(r!.ok, false);
    assert.equal(r!.status, 400);
    assert.equal(requests.filter((x) => x.url.endsWith('/api/boostingOffers')).length, 1);
  } finally {
    tokens.stop();
  }
});

test('page settings are validated before they are used', () => {
  const good = { enabled: true, priceAmount: '20', currency: 'USD', quantity: 1, minQuantity: 1, deliveryTime: 'Day1', message: '  hi  ' };
  const r = validateOfferSettings(good);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value, { enabled: true, priceAmount: 20, currency: 'USD', quantity: 1, minQuantity: 1, deliveryTime: 'Day1', message: 'hi' });
  assert.equal(validateOfferSettings({ ...good, priceAmount: 0 }).ok, false);
  assert.equal(validateOfferSettings({ ...good, priceAmount: 'abc' }).ok, false);
  assert.equal(validateOfferSettings({ ...good, currency: 'XYZ' }).ok, false);
  assert.equal(validateOfferSettings({ ...good, quantity: 1.5 }).ok, false);
  assert.equal(validateOfferSettings({ ...good, minQuantity: 2 }).ok, false); // more than quantity
  assert.equal(validateOfferSettings({ ...good, deliveryTime: 'Day999' }).ok, false);
  assert.equal(validateOfferSettings({ ...good, message: '   ' }).ok, false);
  assert.equal(validateOfferSettings({ ...good, enabled: 'yes' }).ok && (validateOfferSettings({ ...good, enabled: 'yes' }) as { value: { enabled: boolean } }).value.enabled, false);
});

test('parses game, category and request ID from any boosting request', () => {
  assert.deepEqual(parseBoostingRequest(boosting('req-1', '0')), { gameId: '16', categoryId: '0', requestId: 'req-1' });
  assert.deepEqual(parseBoostingRequest(boosting('req-2', '2')), { gameId: '16', categoryId: '2', requestId: 'req-2' });
  assert.equal(parseBoostingRequest(boosting('req-3', '6', '16', 'OrderCreated')), undefined);
});

test('auto-offer categories: Pirate Shop, Battle Royale, Reload, Battle Pass - never Custom request', () => {
  assert.deepEqual(OFFER_CATEGORIES.map((c) => c.id), ['6', '0', '2', '4']);
  assert.ok(!OFFER_CATEGORIES.some((c) => c.id === '1'));
});

test('message: max 500 characters (Eldorado limit); may be empty only while OFF', () => {
  const base = { priceAmount: 20, currency: 'USD', quantity: 1, minQuantity: 1, deliveryTime: 'Day1' };
  assert.equal(validateOfferSettings({ ...base, enabled: true, message: 'x'.repeat(500) }).ok, true);
  assert.equal(validateOfferSettings({ ...base, enabled: true, message: 'x'.repeat(501) }).ok, false);
  assert.equal(validateOfferSettings({ ...base, enabled: false, message: '' }).ok, true);
  assert.equal(validateOfferSettings({ ...base, enabled: true, message: '' }).ok, false);
});

test('settings file: old single-object format becomes Pirate Shop; new format round-trips per category', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eldo-'));
  try {
    const file = join(dir, 'offer-settings.json');
    const s = { enabled: true, priceAmount: 20, currency: 'USD', quantity: 1, minQuantity: 1, deliveryTime: 'Hour5', message: 'hi' };
    await writeFile(file, JSON.stringify(s));
    assert.deepEqual(await loadCategorySettings(file), { '6': s });

    const all = { '6': s, '0': { ...s, priceAmount: 35, message: 'rank' }, '2': { ...s, enabled: false, message: '' } };
    await saveCategorySettings(file, all);
    assert.ok(JSON.parse(await readFile(file, 'utf8')).categories);
    assert.deepEqual(await loadCategorySettings(file), all);

    await writeFile(file, JSON.stringify({ categories: { ...all, '1': s } })); // Custom request is ignored
    assert.equal((await loadCategorySettings(file))!['1'], undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('offers use the settings of the category they are sent for', async () => {
  const { sender, requests, tokens } = setup([201]);
  try {
    await sender.send('req-br', { ...cfg, boostingCategoryId: '0', priceAmount: 35, message: 'rank boost' });
    const body = JSON.parse(requests.find((r) => r.url.endsWith('/api/boostingOffers'))!.body!);
    assert.equal(body.details.pricing.pricePerUnit.amount, 35);
    assert.equal(body.details.message, 'rank boost');
  } finally {
    tokens.stop();
  }
});

test('429 / 5xx are retried at most 3 attempts', async () => {
  const { sender, requests, tokens } = setup([429, 503, 201]);
  try {
    const r = await sender.send('req-7');
    assert.equal(r!.ok, true);
    assert.equal(r!.attempts, 3);
    assert.equal(requests.filter((x) => x.url.endsWith('/api/boostingOffers')).length, 3);
  } finally {
    tokens.stop();
  }
});
