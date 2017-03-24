'use strict';

const EventEmitter = require('events').EventEmitter;
const camelCase = require('lodash/camelCase');
const defaults = require('lodash/defaults');
const assign = require('lodash/assign');
//const valvelet = require('valvelet');
const path = require('path');
const got = require('got');
const fs = require('fs');

const pkg = require('./package');

/**
Create bucket
*/
const TokenBucket = require('tokenbucket');
var bucket = new TokenBucket({
  size: 38,
  tokensToAddPerInterval: 2,
  interval: 1000
})
//tokensLeft can be set
function valvelet(fn, limit, interval, size) {
  const queue = [];
  let count = 0;

  size || (size = Math.pow(2, 32) - 1);

  function timeout() {
    count--;
    if (queue.length) shift();
  }

  function shift() {
    // do we have tokens?
    bucket.removeTokens(1).then(function(remainingTokens) {
      console.log('Tokens left: ' + remainingTokens);

      count++;
      const data = queue.shift();
      data[2](fn.apply(data[0], data[1]));

    }).catch(function (err) {
      console.log(err)
    });

    setTimeout(timeout, interval);
  }

  return function limiter() {
    const args = arguments;

    return new Promise((resolve, reject) => {
      if (queue.length === size) return reject(new Error('Queue is full'));

      queue.push([this, args, resolve]);
      if (count < limit) shift();
    });
  };
}

/**
 * Creates a Shopify instance.
 *
 * @param {Object} options Configuration options
 * @param {String} options.shopName The name of the shop
 * @param {String} options.apiKey The API Key
 * @param {String} options.password The private app password
 * @param {String} options.accessToken The persistent OAuth public app token
 * @param {Boolean|Object} [options.autoLimit] Limits the request rate
 * @param {Number} [options.timeout] The request timeout
 * @constructor
 * @public
 */
function Shopify(options) {
  if (!(this instanceof Shopify)) return new Shopify(options);
  if (
      !options
    || !options.shopName
    || !options.accessToken && (!options.apiKey || !options.password)
    || options.accessToken && (options.apiKey || options.password)
  ) {
    throw new Error('Missing or invalid options');
  }

  this.options = defaults(options, { timeout: 60000 });

  //
  // API call limits, updated with each request.
  //
  this.callLimits = {
    remaining: undefined,
    current: undefined,
    max: undefined
  };

  this.baseUrl = {
    auth: !options.accessToken && `${options.apiKey}:${options.password}`,
    hostname: `${options.shopName}.myshopify.com`,
    protocol: 'https:'
  };

  if (options.autoLimit) {
    const conf = assign({ calls: 2, interval: 1000 }, options.autoLimit);
    this.request = valvelet(this.request, conf.calls, conf.interval);
  }
}

Shopify.prototype = Object.create(EventEmitter.prototype);

/**
 * Updates API call limits.
 *
 * @param {String} header X-Shopify-Shop-Api-Call-Limit header
 * @private
 */
Shopify.prototype.updateLimits = function updateLimits(header) {
  if (!header) return;

  const limits = header.split('/').map(Number);
  const callLimits = this.callLimits;

  callLimits.remaining = limits[1] - limits[0];
  callLimits.current = limits[0];
  callLimits.max = limits[1];

  this.emit('updateLimits', callLimits);
};

/**
 * Sends a request to a Shopify API endpoint.
 *
 * @param {Object} url URL object
 * @param {String} method HTTP method
 * @param {String} [key] Key name to use for req/res body
 * @param {Object} [params] Request body
 * @return {Promise}
 * @private
 */
Shopify.prototype.request = function request(url, method, key, params) {
  const options = assign({
    headers: { 'User-Agent': `${pkg.name}/${pkg.version}` },
    timeout: this.options.timeout,
    json: true,
    retries: 0,
    method
  }, url);

  if (this.options.accessToken) {
    options.headers['X-Shopify-Access-Token'] = this.options.accessToken;
  }

  if (params) {
    const body = key ? { [key]: params } : params;

    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  return got(options).then(res => {
    const body = res.body;

    this.updateLimits(res.headers['x-shopify-shop-api-call-limit']);

    if (key) return body[key];
    return body || {};
  }, err => {
    this.updateLimits(
      err.response && err.response.headers['x-shopify-shop-api-call-limit']
    );

    return Promise.reject(err);
  });
};

//
// Require and instantiate the resources lazily.
//
fs.readdirSync(path.join(__dirname, 'resources')).forEach(name => {
  const prop = camelCase(name.slice(0, -3));

  Object.defineProperty(Shopify.prototype, prop, {
    get: function get() {
      const resource = require(`./resources/${name}`);

      return Object.defineProperty(this, prop, {
        value: new resource(this)
      })[prop];
    },
    set: function set(value) {
      return Object.defineProperty(this, prop, { value })[prop];
    }
  });
});

module.exports = Shopify;
