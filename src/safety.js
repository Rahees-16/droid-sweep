'use strict';
const { labelParts } = require('./ui');

const DEFAULT_DENY = ['delete', 'remove', 'clear', 'erase', 'reset', 'logout', 'log out', 'sign out', 'signout',
  'pay', 'payment', 'checkout', 'buy', 'purchase', 'subscribe', 'order', 'send', 'post', 'publish', 'submit',
  'confirm', 'transfer', 'uninstall', 'factory', 'wipe', 'call', 'dial', 'share'];

function norm(s) {
  return ' ' + String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}
function splitList(v) {
  return (Array.isArray(v) ? v : [v]).filter(Boolean).flatMap((x) => String(x).split(',')).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function buildPolicy({ deny = [], allow = [] } = {}) {
  const allowSet = new Set(splitList(allow).map((k) => norm(k).trim()));
  const set = new Set([...DEFAULT_DENY, ...splitList(deny)].map((k) => norm(k).trim()));
  const keywords = [...set].filter((k) => !allowSet.has(k) && !allowSet.has(k.replace(/ /g, '')));
  const res = keywords.map((k) => [k, new RegExp(` ${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es|ed|d|ing)? `)]);
  return {
    keywords,
    // returns the matching keyword or null
    match(node) {
      const hay = labelParts(node).map(norm).join(' ');
      for (const [k, re] of res) if (re.test(hay)) return k;
      return null;
    },
  };
}

module.exports = { buildPolicy, DEFAULT_DENY, norm };
