'use strict';

var express = require('express'),
    http = require('http'),
    swaggerTools = require('swagger-tools'),
    yamljs = require('yamljs');

if (process.argv.length <= 2) {
  console.error('Usage: node server.js [SWAGGER_FILE]');
  process.exit(1);
}

var app = express();

var options = {
  controllers: './controllers',
  useStubs: true
};
var swaggerDoc = yamljs.load(process.argv[2]);
swaggerTools.initializeMiddleware(swaggerDoc, function (middleware) {
  app.use(middleware.swaggerMetadata());
  app.use(middleware.swaggerRouter(options));
  app.use(middleware.swaggerUi());

  http.createServer(app).listen(7111, function () {
    console.log('API Gateway server listening on port 7111');
  });
});
