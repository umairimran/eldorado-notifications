import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager } from '../src/auth.js';
import type { HttpClient, HttpRequest } from '../src/http.js';
import { OfferSender, buildOfferBody, matchBoostingRequest, validateOfferSettings, type OfferConfig } from '../src/offers.js';
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
