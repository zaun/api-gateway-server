'use strict';

var Engine = require('velocity').Engine,
    jsonpath = require('jsonpath'),
    jsStringEscape = require('js-string-escape'),
    _ = require('lodash'),
    proxyquire = require('proxyquire'),
    nconf = require('nconf'),
    uuid = require('uuid');

var PARAM_TYPE_LOOKUP = {
  'body': 'body',
  'path': 'path',
  'query': 'querystring',
  'header': 'header'
};

var async = require('async');

nconf.file('config', __dirname + '/../config/config.json');

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

var awsSdk = {
  Lambda: function () {
    this.invoke = function (params, callback) {
      var functionData = nconf.get(params.FunctionName);
      var handler;
      if (functionData) {
        // we found this in the config file
        handler = require(functionData.path)[functionData.name];
      } else {
        // try the newer way of specifying lambdas as just a path
        try {
          var fn = params.FunctionName.split('.');
          var lambda = require('../../' + fn[0]);
          handler = lambda[fn[1] || 'handler'];
        } catch (e) { }
      }
      if (handler) {
        handler(JSON.parse(params.Payload), {
          succeed: function (data) {
            callback(null, {
              Payload: JSON.stringify(data)
            });
          },
          fail: function (data) {
            callback(null, {
              FunctionError: 'handled',
              Payload: JSON.stringify({
                errorMessage: data
              })
            });
          }
        });
      }
      else {
        callback({
          statusCode: 500,
          message: 'Fake AWS Lambda could not find a suitable ' + params.FunctionName + '.  Make sure to add it to the config.json'
        });
      }
    };
  }
};

// it seems that calling proxyquire will not get the cached version so keeping our own cache as a workaround
var lambdaFunctionCache = {};

function handler(req, res) {
  var lambdaConf = req.swagger.operation['x-lambda-function'];
  if (!lambdaConf) {
    res.status(500).send('No lambda function defined in swagger definition using x-lambda-function');
  }
  var lambdaParts = lambdaConf.split('.');
  var lambdaName = lambdaParts[0];

  if (!lambdaFunctionCache[lambdaName]) {
    lambdaFunctionCache[lambdaName] = proxyquire('../../' + lambdaName, {
      'aws-sdk': awsSdk
    });
  }

  var lambdaHandler = lambdaFunctionCache[lambdaName][lambdaParts[1] || 'handler'];

  // look for a security function
  var authLambdaHandler;
  if (req.swagger.security && req.swagger.security.length > 0) {
    var model = Object.keys(req.swagger.security[0])[0];

    var authLambdaConf = req.swagger.swaggerObject.securityDefinitions[model]['x-lambda-function'];
    if (!authLambdaConf) {
      res.status(500).send('No authentication lambda function defined in swagger definition using x-lambda-function');
    }
    var authLambdaParts = authLambdaConf.split('.');
    var authLambda = proxyquire('../../' + authLambdaParts[0], { });
    authLambdaHandler = authLambdaHandler[authLambdaParts[1] || 'handler'];
  }

  if (authLambdaHandler && (!req.swagger.params.Authorization || !req.swagger.params.Authorization.value)) {
    res.status(401).send('Unauthorized');
    return;
  }

  async.waterfall([
    function (callback) {
      if (authLambdaHandler) {
        var authEvent = {
          type: 'TOKEN',
          authorizationToken: req.swagger.params.Authorization.value,
          methodArn: 'arn:aws:execute-api:us-west-2:788731124032:ws97zst445/null/GET/'
        };
        authLambdaHandler(authEvent, {
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

      var isUsingAwsProxy = req.swagger.operation['x-amazon-apigateway-integration'].type === 'aws_proxy';

      // First we need to get the swagger params

      // massage the swagger params into something usable by AWS
      // e.g.
      // { dateRange: { parameterObject: { definition: { name: 'dateRange', in: 'path' }, value: 'may-2015' } }, ... }
      //   ==>
      // { path: { dateRange: 'may-2015' }, ... }
      var swaggerParams = _.chain(req.swagger.params).values().filter(function (p) {
        return p.value;
      }).groupBy(function (p) {
        return PARAM_TYPE_LOOKUP[p.parameterObject.definition.in];
      }).mapValues(function (collection) {
        return _.chain(collection).groupBy(function (p) {
          return p.parameterObject.definition.name;
        }).mapValues(function (p) {
          return p[0].value;
        }).value();
      }).value();

      // generate the event depending on the api gateway integration type
      var event;
      if (isUsingAwsProxy) {
        event = {
          path: req.path,
          httpMethod: req.method,
          headers: _.extend(req.headers, {
            'x-forwarded-proto': req.protocol,
            'x-forwarded-for': req.ip || '127.0.0.1'
          }),
          queryStringParameters: req.query,
          body: typeof(req.body) === 'object' ? JSON.stringify(req.body) : req.body,
          pathParameters: swaggerParams.path,
          requestContext: {
            requestId: uuid()
          }
        };
      }
      else {
        // convert the swagger object into a lambda event
        // using the velocity template engine that API gateway uses
        var templateInfo = req.swagger.operation['x-amazon-apigateway-integration'].requestTemplates;
        var jsonTemplate = templateInfo[req.headers['content-type'] || _.keys(templateInfo)[0]];
        var engine = new Engine({
          template: jsonTemplate
        });

        event = engine.render({
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
          },
          context: {
            requestId: uuid()
          }
        });
        event = JSON.parse(event);
      }

      // if there's any userData, add on the data from the authentication function
      if (userData) {
        if (isUsingAwsProxy) {
          event.requestContext = {
            authorizer: {
              principalId: userData.principalId
            }
          };
        }
        else {
          if (!event.context) {
            event.context = {};
          }
          event.context['authorizer-principal-id'] = userData.principalId;
        }
      }

      console.log(lambdaName + ': [start]   ' + req.method + ' ' + req.url);
      var alreadyCalled = false;
      lambdaHandler(event, {
        succeed: function (result) {
          if (!alreadyCalled) {
            alreadyCalled = true;
          } else {
            console.log(lambdaName + ': [double]  ' + req.method + ' ' + req.url + ' ignored');
            console.log(new Error().stack);
            return;
          }
          if (isUsingAwsProxy) {
            for (var key in result.headers) {
              res.header(key, result.headers[key]);
            }
            console.log(lambdaName + ': [succeed] ' + req.method + ' ' + req.url + ' ' + result.statusCode);
            var body;
            try {
              body = JSON.parse(result.body);
            } catch (e) {
              body = result.body;
            }
            res.status(result.statusCode).send(body);
          }
          else {
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
            console.log(lambdaName + ': [succeed] ' + req.url + ' ' + responseData.statusCode);
            if (responseData.contentHandling === 'CONVERT_TO_BINARY') {
              res.status(responseData.statusCode).send(new Buffer(result, 'base64'));
            } else {
              res.status(responseData.statusCode).send(result);
            }
          }
        },
        fail: function (result) {
          if (!alreadyCalled) {
            alreadyCalled = true;
          } else {
            console.log(lambdaName + ': [double]  ' + req.method + ' ' + req.url + ' ignored');
            console.log(new Error().stack);
            return;
          }
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
                  path: function (path) {
                    return jsonpath.query({ errorMessage: result }, path)[0];
                  },
                  json: function (path) {
                    return jsonpath.query({ errorMessage: result }, path)[0];
                  }
                }
              });

              found = true;
              console.log(lambdaName + ': [fail]    ' + req.method + ' ' + req.url + ' ' + responses[r].statusCode);
              res.status(responses[r].statusCode).send(response);
            }
          });
          // AWS wraps the output of a fail in a JSON like object
          if (!found) {
            res.send('{errorMessage=' + result + '}');
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

module.exports.put = function (req, res) {
  handler(req, res);
};

module.exports.delete = function (req, res) {
  handler(req, res);
};

module.exports.patch = function (req, res) {
  handler(req, res);
};
