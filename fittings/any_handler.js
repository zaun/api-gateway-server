'use strict';

var Operation = require('sway/lib/types/operation');
var _ = require('lodash');

/**
 * Make swagger-node-runner treat AWS any method definitions like a normal operation.
 **/
module.exports = function create(fittingDef, bagpipes) {

  return function any(context, cb) {
    var swaggerNodeRunner = bagpipes.config.swaggerNodeRunner;
    var path = swaggerNodeRunner.getPath(context.request);
    var oPath = path.pathToDefinition.concat('x-amazon-apigateway-any-method');
    var op = new Operation(path, 'any', _.get(swaggerNodeRunner.api.definitionRemotesResolved, path.pathToDefinition), path['x-amazon-apigateway-any-method'], oPath);
    context.request.swagger.operation = op;
    cb();
  };
};
