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
