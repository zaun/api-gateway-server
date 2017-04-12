'use strict';

var async = require('async'),
    express = require('express'),
    http = require('http'),
    Runner = require('swagger-node-runner'),
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

process.env.SUPPRESS_NO_CONFIG_WARNING = 'y';
async.each(_.drop(process.argv, 2), function (arg, callback) {
  var swaggerDoc = yamljs.load(arg);
  Runner.create({
    appRoot: '.',
    startWithErrors: true,
    swagger: swaggerDoc,
    fittingsDirs: [ './fittings' ],
    defaultPipe: 'swagger_controllers',
    swaggerControllerPipe: 'swagger_controllers',
    bagpipes: {
      _router: {
        name: 'swagger_router',
        mockMode: false,
        mockControllersDirs: [ 'api/mocks' ],
        controllersDirs: [ './controllers' ]
      },
      'swagger_controllers': [
        'cors',
        'swagger_params_parser',
        '_router'
      ]
    }
  }, function (err, runner) {
    if (err) {
      callback(err);
      return;
    }
    runner.expressMiddleware().register(app);
    callback();
  });
}, function (err) {
  if (err) {
    console.error(err);
  } else {
    http.createServer(app).listen(7111, function () {
      console.log('API Gateway server listening on port 7111');
    });
  }
});
