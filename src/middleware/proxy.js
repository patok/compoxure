var _ = require('lodash');
var utils = require('../utils');
var HtmlParserProxy = require('./htmlparser');
var HttpStatus = require('http-status-codes');
var ReliableGet = require('reliable-get');
var url = require('url');
var extractSlots = require('../extract-slots');
var Core = require('parxer/lib/core');

module.exports = function backendProxyMiddleware(config, eventHandler, optionsTransformer) {

  var reliableGet = new ReliableGet(config),
    htmlParserMiddleware = HtmlParserProxy.getMiddleware(config, reliableGet, eventHandler, optionsTransformer);

  reliableGet.on('log', eventHandler.logger);
  reliableGet.on('stat', eventHandler.stats);

  return function (req, res) {

    htmlParserMiddleware(req, res, function () {

      req.tracer = req.headers['x-tracer'] || 'no-tracer';

      var DEFAULT_LOW_TIMEOUT = 5000,
        referer = req.headers.referer || 'direct',
        userAgent = req.headers['user-agent'] || 'unknown',
        remoteAddress = req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress,
        remoteIp = req.headers['x-forwarded-for'] || remoteAddress,
        backend = req.backend,
        targetUrl = backend.target + (backend.dontPassUrl ? '' : req.url),
        targetHost = url.parse(backend.target).hostname,
        host = backend.host || targetHost,
        accept = backend.accept || 'text/html',
        device = req.templateVars['device:type'],
        backendHeaders = {
          'x-forwarded-host': req.headers.host || 'no-forwarded-host',
          'x-forwarded-for': req.headers['x-forwarded-for'] || remoteAddress,
          host: host,
          accept: accept,
          'x-tracer': req.tracer,
          'user-agent': userAgent,
          'x-device': device,
          'x-geoip-country-code': req.headers['x-geoip-country-code'],
          'x-csrf-token': req.headers['x-csrf-token']
        },
        targetCacheKey = backend.cacheKey || utils.urlToCacheKey(targetUrl),
        targetCacheTTL = utils.timeToMillis(backend.ttl || '30s'),
        explicitNoCache = backend.noCache || req.explicitNoCache,
        options;

      if (config.cdn && config.cdn.url) { backendHeaders['x-cdn-url'] = config.cdn.url; }

      if (req.cookies && req.headers.cookie) {
        var whitelist = config.cookies && config.cookies.whitelist;
        backendHeaders.cookie = whitelist ? utils.filterCookies(whitelist, req.cookies) : req.headers.cookie;
      }

      if (req.headers['accept-language']) {
        backendHeaders['accept-language'] = req.headers['accept-language'];
      }

      if (backend.headers) {
        backend.headers.forEach(function (header) {
          backendHeaders[header] = req.headers[header] || '';
        });
      }

      eventHandler.logger('debug', 'GET ' + req.url, {
        tracer: req.tracer,
        referer: referer,
        remoteIp: remoteIp,
        userAgent: userAgent
      });

      options = {
        url: targetUrl,
        cacheKey: targetCacheKey,
        cacheTTL: targetCacheTTL,
        explicitNoCache: explicitNoCache,
        timeout: utils.timeToMillis(backend.timeout || DEFAULT_LOW_TIMEOUT),
        headers: backendHeaders,
        tracer: req.tracer,
        type: 'backend',
        statsdKey: 'backend_' + utils.urlToCacheKey(host),
        eventHandler: eventHandler
      };

      var logError = function (err, message) {
        var logLevel = err.statusCode === 404 ? 'warn' : 'error';
        eventHandler.logger(logLevel, message, {
          tracer: req.tracer
        });
      }

      var handleError = function (err, oldCacheData) {

        // Check to see if we have any statusCode handlers defined
        if (err.statusCode && config.statusCodeHandlers && config.statusCodeHandlers[err.statusCode]) {
          var handlerDefn = config.statusCodeHandlers[err.statusCode];
          var handlerFn = config.functions && config.functions[handlerDefn.fn];
          if (handlerFn) {
            return handlerFn(req, res, req.templateVars, handlerDefn.data, options, err, res.parse);
          }
        }

        if (req.backend.quietFailure && oldCacheData) {
          var newTemplateVars = utils.formatTemplateVariables(oldCacheData.headers);
          req.templateVars = _.assign(req.templateVars, newTemplateVars);
          res.parse(oldCacheData.content);
          logError(err, 'Backend FAILED but serving STALE content from key ' + targetCacheKey + ' : ' + err.message);
        } else {
          if (!res.headersSent) {
            res.writeHead(err.statusCode || HttpStatus.INTERNAL_SERVER_ERROR);
            res.end(err.message);
          }
          logError(err, 'Backend FAILED but to respond: ' + err.message);
        }
      }

      var setAdditionalHeaders = function () {
        var headersToAdd = _.keys(backend.addResponseHeaders);
        headersToAdd.forEach(function (header) {
          var headerValue = backend.addResponseHeaders[header];
          if (headerValue) { res.setHeader(header, headerValue); }
        });
      }

      var passThroughHeaders = function (backendHeaders) {
        var headersToAllow = backend.passThroughHeaders || [];
        headersToAllow.forEach(function (header) {
          var headerValue = backendHeaders[header];
          if (headerValue) { res.setHeader(header, headerValue); }
        });
      }

      optionsTransformer(req, options, function (err, transformedOptions) {
        if (err) { return handleError(err); }

        if (config.enableExtension && req.method === 'POST' && req.is('text/compoxure')) {
          res.parse(req.body);
          return;
        }

        reliableGet.get(transformedOptions, function (err, response) {
          var layoutUrl;
          if (err) {
            handleError(err, response);
          } else {
            var newTemplateVars = utils.formatTemplateVariables(response.headers);
            req.templateVars = _.assign(req.templateVars, newTemplateVars);
            if (response.headers['set-cookie']) {
              res.setHeader('set-cookie', response.headers['set-cookie']);
            }
            setAdditionalHeaders();
            passThroughHeaders(response.headers);
            if ('cx-layout' in response.headers) {
              // extract slots from original html
              extractSlots(response.content, function (err, slots) {
                req.templateVars.slots =  slots;
                layoutUrl = Core.render(response.headers['cx-layout'], req.templateVars);
                // get the layout
                reliableGet.get({
                  url: layoutUrl,
                  cacheKey: 'layout: '+ layoutUrl,
                  cacheTTL: 60000 * 5 // 5 mins
                }, function (err, response) {
                  res.parse(response.content);
                });
              });
            } else {
              res.parse(response.content);
            }
          }
        });
      });

    });

  }
}
