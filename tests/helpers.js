'use strict';
const path = require('path');
const { FakeDriver } = require('../src/driver');
const { explore } = require('../src/explorer');
const { buildPolicy } = require('../src/safety');
const spec = require('./fixtures/demo-app');

const fixtures = path.join(__dirname, 'fixtures');
const fakeClock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

function makeDriver(overrides = {}) {
  const s = { ...spec, ...overrides, screens: { ...spec.screens, ...(overrides.screens || {}) } };
  return new FakeDriver(s, { fixturesDir: fixtures });
}
async function run(opts = {}, driver = makeDriver()) {
  const result = await explore(driver, { pkg: 'com.example.demo', ...opts, policy: buildPolicy(opts.policy || {}) }, { clock: fakeClock() });
  return { driver, result };
}
module.exports = { fixtures, fakeClock, makeDriver, run, spec };
