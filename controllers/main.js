'use strict';

var Engine = require('velocity').Engine,
    jsStringEscape = require('js-string-escape'),
    _ = require('lodash');

var PARAM_TYPE_LOOKUP = {
  'path': 'path',
  'query': 'querystring'
};

module.exports.get = function (req, res) {
  var lambdaName = req.swagger.operation['x-lambda-function'];
  if (!lambdaName) {
    res.status(500).send('No lambda function defined in swagger definition using x-lambda-function');
  }
  var lambda = require('../../' + lambdaName);

  // convert the swagger object into a lambda event
  // using the velocity template engine that API gateway uses
  var jsonTemplate = req.swagger.operation['x-amazon-apigateway-integration'].requestTemplates['application/json'];
  var engine = new Engine({
    template: jsonTemplate
  });

  // massage the swagger params into something usable by AWS
  // e.g.
  // { dateRange: { path: {...}, schema: { name: 'dateRange', in: 'path' }, value: 'may-2015' }, ... }
  //   ==>
  // { path: { dateRange: 'may-2015' }, ... }
  var swaggerParams = _.chain(req.swagger.params).values().filter(function (p) {
    return p.value;
  }).groupBy(function (p) {
    return PARAM_TYPE_LOOKUP[p.schema.in];
  }).mapValues(function (collection) {
    return _.chain(collection).groupBy(function (p) {
      return p.schema.name;
    }).mapValues(function (p) {
      return p[0].value;
    }).value();
  }).value();

  var event = engine.render({
    // make an object that mimics what AWS puts into the velocity engine
    util: {
      escapeJavaScript: function (str) {
        return jsStringEscape(str);
      }
    },
    input: {
      json: function () { return JSON.stringify(req.body); },
      params: function () {
        return {
          keySet: function () {
            return _.keys(swaggerParams);
          },
          get: function (groupName) {
            return {
              keySet: function () {
                return _.keys(swaggerParams[groupName]);
              },
              get: function (paramName) {
                return swaggerParams[groupName][paramName];
              }
            };
          }
        };
      }
    }
  });

  lambda.handler(JSON.parse(event), {
    succeed: function (result) {
      console.log('success!');
      res.send(result);
    },
    fail: function () {
      console.log('failure!');
      res.send('failure!');
    }
  });
};
