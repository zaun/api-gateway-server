'use strict';

var Engine = require('velocity').Engine,
    jsStringEscape = require('js-string-escape'),
    _ = require('lodash');

var PARAM_TYPE_LOOKUP = {
  'path': 'path',
  'query': 'querystring',
  'header': 'header'
};

var async = require('async');

// dereference a dotted string into an object
// e.g. "a.b.c" => a.b.c
function index(obj, i) { return obj[i]; }
function getProperty(obj, str) {
  // check for string literal
  if (str.charAt(0) === '\'' && str.charAt(str.length - 1) === '\'') {
    return str.substring(1, str.length - 1);
  }
  return str.split('.').reduce(index, obj);
}

// set an object property from a dotted string
function setProperty(obj, str, value) {
  if (typeof str === 'string') {
    return setProperty(obj, str.split('.'), value);
  } else if (str.length === 1 && value !== undefined) {
    obj[str[0]] = value;
    return value;
  } else if (str.length === 0) {
    return obj;
  } else {
    if (!obj[str[0]]) {
      obj[str[0]] = {};
    }
    return setProperty(obj[str[0]], str.slice(1), value);
  }
}

function handler(req, res) {
  var lambdaName = req.swagger.operation['x-lambda-function'];
  if (!lambdaName) {
    res.status(500).send('No lambda function defined in swagger definition using x-lambda-function');
  }
  var lambda = require('../../' + lambdaName);

  // look for a security function
  var authLambda;
  if (req.swagger.security && req.swagger.security.length > 0) {
    var model = Object.keys(req.swagger.security[0])[0];

    var authLambdaName = req.swagger.swaggerObject.securityDefinitions[model]['x-lambda-function'];
    if (!authLambdaName) {
      res.status(500).send('No authentication lambda function defined in swagger definition using x-lambda-function');
    }
    authLambda = require('../../' + authLambdaName);
  }

  if (authLambda && (!req.swagger.params.Authorization || !req.swagger.params.Authorization.value)) {
    res.status(401).send('Unauthorized');
    return;
  }

  async.waterfall([
    function (callback) {
      if (authLambda) {
        var authEvent = {
          type: 'TOKEN',
          authorizationToken: req.swagger.params.Authorization.value,
          methodArn: 'arn:aws:execute-api:us-west-2:788731124032:ws97zst445/null/GET/'
        };
        authLambda.handler(authEvent, {
          succeed: function (result) {
            var statements = result.policyDocument.Statement;
            var allowedStatements = _.find(statements, { 'Effect': 'Allow' });

            // proceed if we find any allowed statements since our auth function is allowing all
            if (allowedStatements) {
              callback(null, result);
            }
            else {
              callback({'code': 403, 'data': 'User is not authorized to access this resource'});
            }
          },
          fail: function (result) {
            callback({'code': 401, 'data': result});
          }
        });
      }
      else {
        // no auth function set so proceed
        callback(null, null);
      }
    },
    function (userData, callback) {
      // convert the swagger object into a lambda event
      // using the velocity template engine that API gateway uses
      var templateInfo = req.swagger.operation['x-amazon-apigateway-integration'].requestTemplates;
      var jsonTemplate = templateInfo[req.headers['content-type'] || _.keys(templateInfo)[0]];
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
          json: function () {
            if (!req.body) {
              return JSON.stringify({});
            }
            return JSON.stringify(req.body);
          },
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

      event = JSON.parse(event);
      // if there's any userData, add on the data from the authentication function
      if (userData) {
        if (!event.context) {
          event.context = {};
        }
        event.context['authorizer-principal-id'] = userData.principalId;
      }

      lambda.handler(event, {
        succeed: function (result) {
          var responseData = req.swagger.operation['x-amazon-apigateway-integration'].responses.default;

          // construct the AWS-like mapping object
          var integrationObj = { integration: { response: { body: result } } };
          var responseObj = { };
          _.each(_.keys(responseData.responseParameters), function (p) {
            setProperty(responseObj, p, getProperty(integrationObj, responseData.responseParameters[p]));
          });

          // set the mapped headers
          if (responseObj.method && responseObj.method.response) {
            _.each(_.keys(responseObj.method.response.header), function (k) {
              res.set(k, responseObj.method.response.header[k]);
            });
          }
          res.status(responseData.statusCode).send(result);
        },
        fail: function (result) {
          var responses = req.swagger.operation['x-amazon-apigateway-integration'].responses;
          var found = false;
          _.each(_.keys(responses), function (r) {
            if ((new RegExp(r)).test(result)) {
              var type = _.find(req.headers.accept.split(','), function (t) {
                return _.find(_.keys(responses[r].responseTemplates), t);
              }) || _.keys(responses[r].responseTemplates)[0];
              var engine = new Engine({
                template: responses[r].responseTemplates[type]
              });

              var response = engine.render({
                // make an object that mimics what AWS puts into the velocity engine
                util: {
                  escapeJavaScript: function (str) {
                    return jsStringEscape(str);
                  }
                },
                input: {
                  body: result,
                  json: function () { return JSON.stringify(result); }
                }
              });

              found = true;
              res.status(responses[r].statusCode).send(response);
            }
          });
          if (!found) {
            res.send(result);
          }
        }
      });
      callback(null);
    }
  ], function (error) {
    if (error) {
      res.status(error.code).send(error.data);
    }
  });
}

module.exports.get = function (req, res) {
  handler(req, res);
};

module.exports.post = function (req, res) {
  handler(req, res);
};