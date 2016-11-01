'use strict';

var async = require('async'),
    express = require('express'),
    http = require('http'),
    swaggerTools = require('swagger-tools'),
    yamljs = require('yamljs'),
    _ = require('lodash');

if (process.argv.length <= 2) {
  console.error('Usage: node server.js [SWAGGER_FILE]');
  process.exit(1);
}

var app = express();

app.use(function (req, res, next) {
  if (req.method === 'OPTIONS') {
    var ALLOWED_HEADERS = [
      'Accept',
      'Accept-Encoding',
      'Accept-Version',
      'Allow',
      'Authorization',
      'Cache-Control',
      'Content-Type',
      'Origin',
      'Pragma',
      'Set-Cookie',
      'X-Prototype-Version',
      'X-Requested-With',
      'X-Sagely-Client'
    ];
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', ALLOWED_HEADERS.join(','));
    res.header('Access-Control-Expose-Headers', 'X-Server-Version');
    res.header('Access-Control-Max-Age', 60 * 60 * 24 * 365);
  }

  next();
});

var options = {
  controllers: './controllers',
  useStubs: true
};
async.each(_.drop(process.argv, 2), function (arg, callback) {
  var swaggerDoc = yamljs.load(arg);
  swaggerTools.initializeMiddleware(swaggerDoc, function (middleware) {
    app.use(middleware.swaggerMetadata());
    app.use(middleware.swaggerRouter(options));
    app.use(middleware.swaggerUi({
      apiDocs: '/api-docs' + swaggerDoc.basePath,
      swaggerUi: '/docs' + swaggerDoc.basePath
    }));
    callback();
  });
}, function () {
  http.createServer(app).listen(7111, function () {
    console.log('API Gateway server listening on port 7111');
  });
});
