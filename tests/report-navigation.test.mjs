import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  navigationScript,
  renderTradeNavigation,
} from '../server/report-navigation.mjs';

const element = (rectangle = {}) => ({
  dataset: {},
  attributes: new Map(),
  listeners: new Map(),
  scrollTop: 0,
  offsetHeight: 32,
  style: {},
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  },
  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) callback(event);
  },
  setAttribute(name, value) {
    this.attributes.set(name, value);
  },
  removeAttribute(name) {
    this.attributes.delete(name);
  },
  focus() {
    this.focused = true;
    this.dispatch('focus');
  },
  getBoundingClientRect() {
    return { top: 100, bottom: 130, height: 30, ...rectangle };
  },
});

function navigationHarness({ mobile = false } = {}) {
  let offset = 0;
  const articles = [element(), element()];
  articles[0].getBoundingClientRect = () => ({ top: 1000 - offset });
  articles[1].getBoundingClientRect = () => ({ top: 5000 - offset });
  const links = articles.map((_, index) => {
    const link = element();
    link.dataset = {
      tradeTarget: `trade-${index}`,
      tradeLabel: `手记 ${index + 1}`,
    };
    return link;
  });
  const toggle = element();
  const close = element();
  const panel = element({ top: 70, bottom: 700 });
  const tooltip = element();
  const navigation = element();
  navigation.dataset.open = 'false';
  navigation.querySelector = (selector) =>
    ({
      '.trade-nav-panel': panel,
      '.trade-nav-toggle': toggle,
      '.trade-nav-close': close,
    })[selector];
  navigation.querySelectorAll = () => links;
  navigation.contains = (target) =>
    [navigation, toggle, close, panel, ...links].includes(target);
  const media = element();
  media.matches = mobile;
  const window = element();
  window.innerHeight = 800;
  window.matchMedia = () => media;
  window.requestAnimationFrame = (callback) => callback();
  const document = element();
  document.querySelector = (selector) =>
    ({
      '.trade-navigation': navigation,
      '.trade-nav-tooltip': tooltip,
      '.navigation': element({ height: 56 }),
    })[selector];
  document.getElementById = (id) => articles[Number(id.replace('trade-', ''))];
  vm.runInNewContext(navigationScript, { document, window });
  return {
    articles,
    links,
    toggle,
    panel,
    navigation,
    document,
    scrollTo(position) {
      offset = position;
      window.dispatch('scroll');
    },
  };
}

await test('report navigation safely renders record data and fragment links', () => {
  const html = renderTradeNavigation([
    {
      id: 'a"<>&',
      date: '2026-09-19',
      time: '10:20',
      symbol: '<img src=x onerror="boom">',
      direction: 'long',
    },
  ]);
  assert.ok(html.includes('href="#trade-a%22%3C%3E%26"'));
  assert.ok(html.includes('data-trade-target="trade-a&quot;&lt;&gt;&amp;"'));
  assert.ok(html.includes('&lt;img src=x onerror=&quot;boom&quot;&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('手记 1 · 2026-09-19 10:20'));
  assert.equal(renderTradeNavigation([]), '');
});

await test('active navigation stays on a tall trade until the next trade is reached', () => {
  const harness = navigationHarness();
  const current = (link) => link.attributes.get('aria-current');
  assert.equal(current(harness.links[0]), undefined);
  harness.scrollTo(1000);
  assert.equal(current(harness.links[0]), 'location');
  harness.scrollTo(3600);
  assert.equal(current(harness.links[0]), 'location');
  assert.equal(current(harness.links[1]), undefined);
  harness.scrollTo(5000);
  assert.equal(current(harness.links[0]), undefined);
  assert.equal(current(harness.links[1]), 'location');
});

await test('mobile directory supports keyboard opening, closing, and destination focus', () => {
  const harness = navigationHarness({ mobile: true });
  harness.toggle.dispatch('click');
  assert.equal(harness.navigation.dataset.open, 'true');
  assert.equal(harness.toggle.attributes.get('aria-expanded'), 'true');
  assert.equal(harness.links[0].focused, true);
  harness.document.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(harness.navigation.dataset.open, 'false');
  assert.equal(harness.toggle.focused, true);
  harness.toggle.dispatch('click');
  harness.links[1].dispatch('click', { button: 0 });
  assert.equal(harness.navigation.dataset.open, 'false');
  assert.equal(harness.articles[1].focused, true);
  assert.equal(harness.articles[1].attributes.get('tabindex'), '-1');
});
