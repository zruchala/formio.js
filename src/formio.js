'use strict'

require('whatwg-fetch');
var Q = require('Q');
var EventEmitter = require('eventemitter3');
var ObjectId = require('bson-objectid');
var copy = require('shallow-copy');
var querystring = require('querystring');
var _get = require('lodash.get');
var _sortByOrder = require('lodash.sortByOrder');

var localForage = require('localforage').createInstance({
  name: 'formio',
  version: 1.0,
  storeName: 'formio',
  description: 'The offline storage for formio data.'
});

// Prefix used with offline cache entries in localForage
var OFFLINE_CACHE_PREFIX = 'formioCache-';
var OFFLINE_SUBMISISON_CACHE_PREFIX = 'formioSubmissionCache-';
var OFFLINE_QUEUE_KEY = 'formioOfflineQueue';

module.exports = function(_baseUrl, _noalias, _domain) {
// The default base url.
  var baseUrl = _baseUrl || '';
  var noalias = _noalias || false;

  // Promise that resolves when ready to make requests
  var ready = Q();

  // The temporary GET request cache storage
  var cache = {};

  // The persistent offline cache storage
  var offlineCache = {};

  // The queue of submissions made offline
  var submissionQueue = [];
  var loadSubmissionQueuePromise = localForage.getItem(OFFLINE_QUEUE_KEY)
  .then(function(queue) {
    submissionQueue = queue || [];
  })
  .catch(function(err) {
    console.error('Failed to restore offline submission queue:', err);
  });
  ready = ready.thenResolve(loadSubmissionQueuePromise);

  // Flag indicating if submission queue is currently being processed
  var dequeuing = false;

  // Flag to queue submission requests
  var queueSubmissions = false;

  // Flag to force offline mode
  var forcedOffline = false;



  /**
   * Returns parts of the URL that are important.
   * Indexes
   *  - 0: The full url
   *  - 1: The protocol
   *  - 2: The hostname
   *  - 3: The rest
   *
   * @param url
   * @returns {*}
   */
  var getUrlParts = function(url) {
    return url.match(/^(http[s]?:\/\/)([^/]+)($|\/.*)/);
  };

  var serialize = function(obj) {
    var str = [];
    for(var p in obj)
      if (obj.hasOwnProperty(p)) {
        str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p]));
      }
    return str.join("&");
  };

  /**
   * Removes duplicate forms from offline cached project.
   * Duplicates can occur if form is renamed (old and new
   * stored under different names but have same id/path).
   * NOTE: modifies the given object
   *
   * @param project Cached project
   */
  var removeCacheDuplicates = function(project) {
    Object.keys(project.forms).forEach(function(name) {
      var form = project.forms[name];
      if (!form) { // form was deleted
        return;
      }
      Object.keys(project.forms).forEach(function(otherName) {
        var otherForm = project.forms[otherName];
        if ((form._id === otherForm._id || form.path === otherForm.path) &&
            new Date(otherForm.modified) < new Date(form.modified)) {
            delete project.forms[otherName];
        }
      });
    });
  };

  var savingPromise;

  // Saves the submissionQueue to localForage
  var saveQueue = function() {
    if(savingPromise) {
      // Already waiting to save
      return savingPromise;
    }
    ready = ready.then(function() {
      savingPromise = null;
      return localForage.setItem(OFFLINE_QUEUE_KEY, submissionQueue);
    })
    .catch(function(err) {
      console.error('Error persisting submission queue:', err);
      // Swallow error so it doesn't halt the ready chain
    });
    savingPromise = ready;
    return ready;
  };

  // Returns true if a form is part of a project that has been
  // cached offline.
  var isFormOffline = function(formPath) {
    return Object.keys(offlineCache).some(function(project) {
      return offlineCache[project].forms[formPath];
    });
  }

  // Save a submission to retrieve in GET requests while offline.
  var saveOfflineSubmission = function(formId, submission) {
    var formInfo = resolveFormId(formId);
    if(!isFormOffline(formInfo.path)) {
      return Q();
    }
    formId = formInfo.path || formInfo._id;
    var offlineSubmission = copy(submission);
    offlineSubmission.offline = true;
    return localForage.setItem(
      OFFLINE_SUBMISISON_CACHE_PREFIX + formId + '-' + submission._id,
      offlineSubmission
    ).catch(function(err) {
      console.error('Failed to save offline submission:', err);
      throw err;
    });
  };

  // Finds and returns a submission from the offline data
  var getOfflineSubmission = function(formId, submissionId, ignoreQueuedRequest) {
    var formInfo = resolveFormId(formId);
    // Try to load offline cached submission
    return localForage.getItem(
      OFFLINE_SUBMISISON_CACHE_PREFIX + formInfo.path + '-' + submissionId
    ).then(function(submission) {
      return submission || localForage.getItem(
        OFFLINE_SUBMISISON_CACHE_PREFIX + formInfo._id + '-' + submissionId
      );
    })
    .then(function(submission) {
      // Go through the submission queue for any newer submissions
      // TODO: handle PUT requests and modify the result with them
      return submissionQueue.reduce(function(result, queuedRequest) {
        if ((queuedRequest.request._id || queuedRequest.request.data._id) === submissionId && queuedRequest !== ignoreQueuedRequest) {
          if (queuedRequest.request.method === 'POST') {
            return queuedRequest.request.data;
          }
          else if (queuedRequest.request.method === 'PUT') {
            var resultCopy = copy(result);
            resultCopy.data = queuedRequest.request.data.data;
            resultCopy.modified = new Date().toISOString();
            return resultCopy;
          }
          else if (queuedRequest.request.method === 'DELETE') {
            return null;
          }
        }
        return result;
      }, submission);
    })
    .catch(function(err) {
      console.error('Failed to retrieve offline submission:', err);
      throw err;
    });
  };

  // Deletes a submission from the offline data
  var deleteOfflineSubmission = function(formId, submissionId) {
    var formInfo = resolveFormId(formId);

    return Q.all([
      localForage.removeItem(
        OFFLINE_SUBMISISON_CACHE_PREFIX + formInfo.path + '-' + submissionId
      ),
      localForage.removeItem(
        OFFLINE_SUBMISISON_CACHE_PREFIX + formInfo._id + '-' + submissionId
      ),
    ])
    .catch(function(err) {
      console.error('Failed to delete offline submission:', err);
    });
  }

  // A unique filter function to be used with Array.prototype.filter
  var uniqueFilter = function(value, index, self) {
    return self.indexOf(value) === index;
  };

  // Returns all queued submission id's for a given form
  var getQueuedSubmissionIds = function(formId) {
    var formInfo = resolveFormId(formId);
    return submissionQueue.filter(function(queuedRequest) {
      return (queuedRequest.request.form === formInfo.path ||
        queuedRequest.request.form === formInfo._id) &&
        queuedRequest.request.method !== 'DELETE';
    })
    .map(function(queuedRequest) {
      return queuedRequest.request._id || queuedRequest.request.data._id;
    })
    .filter(uniqueFilter);
  };

  // Given a form _id or path, returns an object with both
  // if available offline
  var resolveFormId = function(formId) {
    if (ObjectId.isValid(formId)) {
      // formId is the form's _id
      var result = {
        _id: formId,
        path: null
      };
      Object.keys(offlineCache).forEach(function(projectId) {
        Object.keys(offlineCache[projectId].forms).forEach(function(formPath) {
          var form = offlineCache[projectId].forms[formPath];
          if (form._id === formId) {
            result = {
              _id: formId,
              path: formPath
            };
          }
        });
      });

      return result;
    }
    else {
      // formId is the form's path
      var result = {
        _id: null,
        path: formId
      }
      Object.keys(offlineCache).forEach(function(projectId) {
        var form = offlineCache[projectId].forms[formId];
        if (form) {
          result = {
            _id: form._id,
            path: formId
          };
        }
      });

      return result;
    }
  }

  // The formio class.
  var Formio = function(path) {

    // Ensure we have an instance of Formio.
    if (!(this instanceof Formio)) { return new Formio(path); }
    if (!path) {
      // Allow user to create new projects if this was instantiated without
      // a url
      this.projectUrl = baseUrl + '/project';
      this.projectsUrl = baseUrl + '/project';
      this.projectId = false;
      this.query = '';
      return;
    }

    // Initialize our variables.
    this.projectsUrl = '';
    this.projectUrl = '';
    this.projectId = '';
    this.formUrl = '';
    this.formsUrl = '';
    this.formId = '';
    this.submissionsUrl = '';
    this.submissionUrl = '';
    this.submissionId = '';
    this.actionsUrl = '';
    this.actionId = '';
    this.actionUrl = '';
    this.query = '';

    // Normalize to an absolute path.
    if ((path.indexOf('http') !== 0) && (path.indexOf('//') !== 0)) {
      baseUrl = baseUrl ? baseUrl : window.location.href.match(/http[s]?:\/\/api./)[0];
      path = baseUrl + path;
    }

    var hostparts = getUrlParts(path);
    var parts = [];
    var hostName = hostparts[1] + hostparts[2];
    path = hostparts.length > 3 ? hostparts[3] : '';
    var queryparts = path.split('?');
    if (queryparts.length > 1) {
      path = queryparts[0];
      this.query = '?' + queryparts[1];
    }

    // See if this is a form path.
    if ((path.search(/(^|\/)(form|project)($|\/)/) !== -1)) {

      // Register a specific path.
      var registerPath = function(name, base) {
        this[name + 'sUrl'] = base + '/' + name;
        var regex = new RegExp('\/' + name + '\/([^/]+)');
        if (path.search(regex) !== -1) {
          parts = path.match(regex);
          this[name + 'Url'] = parts ? (base + parts[0]) : '';
          this[name + 'Id'] = (parts.length > 1) ? parts[1] : '';
          base += parts[0];
        }
        return base;
      }.bind(this);

      // Register an array of items.
      var registerItems = function(items, base, staticBase) {
        for (var i in items) {
          var item = items[i];
          if (item instanceof Array) {
            registerItems(item, base, true);
          }
          else {
            var newBase = registerPath(item, base);
            base = staticBase ? base : newBase;
          }
        }
      };

      registerItems(['project', 'form', ['submission', 'action']], hostName);
    }
    else {

      // This is an aliased url.
      this.projectUrl = hostName;
      this.projectId = (hostparts.length > 2) ? hostparts[2].split('.')[0] : '';
      var subRegEx = new RegExp('\/(submission|action)($|\/.*)');
      var subs = path.match(subRegEx);
      this.pathType = (subs && (subs.length > 1)) ? subs[1] : '';
      path = path.replace(subRegEx, '');
      path = path.replace(/\/$/, '');
      this.formsUrl = hostName + '/form';
      this.formUrl = hostName + path;
      this.formId = path.replace(/^\/+|\/+$/g, '');
      var items = ['submission', 'action'];
      for (var i in items) {
        var item = items[i];
        this[item + 'sUrl'] = hostName + path + '/' + item;
        if ((this.pathType === item) && (subs.length > 2) && subs[2]) {
          this[item + 'Id'] = subs[2].replace(/^\/+|\/+$/g, '');
          this[item + 'Url'] = hostName + path + subs[0];
        }
      }
    }
  };

  /**
   * Load a resource.
   *
   * @param type
   * @returns {Function}
   * @private
   */
  var _load = function(type) {
    var _id = type + 'Id';
    var _url = type + 'Url';
    return function(query, opts) {
      if (typeof query === 'object') {
        query = '?' + serialize(query.params);
      }
      if (!this[_id]) { return Q.reject('Missing ' + _id); }
      return this.makeRequest(type, this[_url] + this.query, 'get', null, opts);
    };
  };

  /**
   * Save a resource.
   *
   * @param type
   * @returns {Function}
   * @private
   */
  var _save = function(type) {
    var _id = type + 'Id';
    var _url = type + 'Url';
    return function(data, opts) {
      var method = this[_id] ? 'put' : 'post';
      var reqUrl = this[_id] ? this[_url] : this[type + 'sUrl'];
      cache = {};
      return this.makeRequest(type, reqUrl + this.query, method, data, opts);
    };
  };

  /**
   * Delete a resource.
   *
   * @param type
   * @returns {Function}
   * @private
   */
  var _delete = function(type) {
    var _id = type + 'Id';
    var _url = type + 'Url';
    return function(opts) {
      if (!this[_id]) { Q.reject('Nothing to delete'); }
      cache = {};
      return this.makeRequest(type, this[_url], 'delete', null, opts);
    };
  };

  /**
   * Resource index method.
   *
   * @param type
   * @returns {Function}
   * @private
   */
  var _index = function(type) {
    var _url = type + 'Url';
    return function(query, opts) {
      query = query || '';
      if (typeof query === 'object') {
        query = '?' + serialize(query.params);
      }
      return this.makeRequest(type, this[_url] + query, 'get', null, opts);
    };
  };

  // Returns cached results if offline, otherwise calls Formio.request
  Formio.prototype.makeRequest = function(type, url, method, data, opts) {
    var self = this;
    method = (method || 'GET').toUpperCase();
    if(!opts || typeof opts !== 'object') {
      opts = {};
    }

    return ready // Wait until offline caching is finished
    .then(function() {
      // If queuing is enabled, requests need to be queued regardless of if
      // we're online or offline.
      if (queueSubmissions && !opts.skipQueue && type === 'submission' &&
          (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
        // Push request to end of offline queue
        var queuedRequest = {
            request: {
              _id: self.submissionId,
              type: type,
              url: url,
              method: method,
              data: data,
              form: self.formId,
              formUrl: self.formUrl
            }
        };
        // Set enumerable to false, IndexedDB doesn't like serializing
        // Q Deferred objects.
        Object.defineProperty(queuedRequest, 'deferred', {
          enumerable: false,
          value: Q.defer()
        });

        submissionQueue.push(queuedRequest);
        saveQueue();
        Formio.offline.emit('queue', queuedRequest.request);

        // Start the submission queue
        Formio.dequeueSubmissions();

        return queuedRequest.deferred.promise;
      }

      if(Formio.isForcedOffline()) {
        // Fake a network error so we go straight into offline logic
        var err = new Error('Formio is forced into offline mode.');
        err.networkError = true;
        throw err;
      }

      return Formio.request(url, method, data);
    })
    .catch(function(err) {
      if(!err.networkError) {
        // A regular error, no offline logic needed
        throw err;
      }

      // Try to get offline cached response if offline
      var cache = offlineCache[self.projectId];

      // Form GET
      if (type === 'form' && method === 'GET') {
        if (!cache || !cache.forms) {
          throw err; // No cache available
        }
        // Find and return form
        var form = Object.keys(cache.forms).reduce(function(result, name) {
          if (result) return result;
          var form = cache.forms[name];
          if (form._id === self.formId || form.path === self.formId) return form;
        }, null);

        if(!form) {
          err.message += ' (No offline cached data found)';
          throw err;
        }

        return form;
      }

      // Form INDEX
      if (type === 'forms' && method === 'GET') {
        if (!cache || !cache.forms) {
          throw err; // No cache available
        }
        return cache.forms;
      }

      // Submission GET
      if (type === 'submission' && method === 'GET') {
        return getOfflineSubmission(self.formId, self.submissionId)
        .then(function(submission) {
          if(!submission) {
            throw err;
          }
          return submission;
        });
      }

      // Submission INDEX
      if (type === 'submissions' && method === 'GET') {
        return localForage.keys()
        .then(function(keys) {
          keys = keys.concat(
            getQueuedSubmissionIds(self.formId)
            .map(function(submissionId) {
              return OFFLINE_SUBMISISON_CACHE_PREFIX + self.formId + '-' + submissionId
            })
          ).filter(uniqueFilter);
          var formInfo = resolveFormId(self.formId);

          return Q.all(
            keys.filter(function(key) {
              return key.indexOf(OFFLINE_SUBMISISON_CACHE_PREFIX + formInfo.path) === 0 ||
                key.indexOf(OFFLINE_SUBMISISON_CACHE_PREFIX + formInfo._id) === 0;
            })
            .map(function(key) {
              var submissionId = key.split('-')[2];
              return getOfflineSubmission(self.formId, submissionId);
            })
          ).then(function(submissions) {
            // Filter out null (deleted) submissions
            submissions = submissions.filter(function(submission) {
              return submission;
            });
            var serverCount = submissions.length;
            var qs = querystring.parse(url.split('?')[1] || '');

            if (qs.sort) {
              var sort = (qs.sort).split(/\s+/);
              var order = [];
              sort = sort.map(function(prop) {
                if (prop.charAt(0) === '-') {
                  order.push('desc');
                  return prop.substring(1);
                }
                order.push('asc');
                return prop;
              });
              submissions = _sortByOrder(submissions, sort, order);
            }


            Object.keys(qs).forEach(function(param) {
              var value = qs[param];
              var filter = param.split('__')[1];
              var param = param.split('__')[0];
              var filterFn = null;
              switch(param) {
                case 'sort':
                case 'limit':
                case 'skip':
                case 'select': break; // Do nothing
                default:
                  switch(filter) {
                    case undefined: filterFn = function(submission) {
                        return _get(submission, param) == value;
                      };
                      break;
                    case 'ne': filterFn = function(submission) {
                        return _get(submission, param) != value;
                      };
                      break;
                    case 'gt': filterFn = function(submission) {
                        return _get(submission, param) > value;
                      };
                      break;
                    case 'gte': filterFn = function(submission) {
                        return _get(submission, param) >= value;
                      };
                      break;
                    case 'lt': filterFn = function(submission) {
                        return _get(submission, param) < value;
                      };
                      break;
                    case 'lte': filterFn = function(submission) {
                        return _get(submission, param) <= value;
                      };
                      break;
                    case 'in': filterFn = function(submission) {
                        return value.split(',').indexOf(_get(submission, param)) !== -1;
                      };
                      break;
                    case 'regex': filterFn = function(submission) {
                        var parts = value.match(/\/?([^/]+)\/?([^/]+)?/);
                        var regex = new RegExp(parts[1], parts[2]);
                        return _get(submission, param).match(regex);
                      };
                      break;
                  }
                  break;
              }
              if(filterFn) {
                submissions = submissions.filter(filterFn);
              }
            });
            var limit = Number(qs.limit) || 10;
            var skip = Number(qs.skip) || 0;
            if(skip !== 0 || limit < submissions.length) {
              submissions = submissions.slice(skip, skip + limit);
            }
            submissions.limit = limit;
            submissions.skip = skip;
            submissions.serverCount = serverCount;

            return submissions;
          });
        });
      }

      throw err; // No offline logic, just throw the error
    })
    .then(function(result) {
      // Check if need to update cache after request
      var cache = offlineCache[self.projectId];
      if (!cache) return result; // Skip caching

      if (type === 'form' && method !== 'DELETE' && !result.offline) {
        if (new Date(cache.forms[result.name].modified) >= new Date(result.modified)) {
          // Cache is up to date
          return result;
        }
        var cachedResult = copy(result);
        cachedResult.offline = true;
        cache.forms[result.name] = cachedResult;
      }
      else if (type === 'form' && method === 'DELETE') {
        var formInfo = resolveFormId(self.formId);
        var formPath = '';
        cache.forms.forEach(function(form) {
          if(form.path === formInfo.path || form._id === formInfo._id) {
            formPath = form.path;
          }
        });
        delete cache.forms[formPath];
      }
      else if (type === 'forms' && method === 'GET') {
        if (result.length && result[0].offline) {
          return result; // skip caching because this is offline cached data
        }
        // Don't replace all forms, as some may be omitted due to permissions
        result.forEach(function(form) {
          var cachedForm = copy(form);
          cachedForm.offline = true;
          cache.forms[form.name] = cachedForm;
        });
      }
      else if (type === 'submission' && method !== 'DELETE' && !result.offline) {
        return saveOfflineSubmission(self.formId, result)
        .then(function() {
          return result;
        });
      }
      else if (type === 'submission' && method === 'DELETE') {
        var formInfo = resolveFormId(self.formId);
        return deleteOfflineSubmission(self.formId, self.submissionId)
        .then(function() {
          return result;
        });
      }
      else if (type === 'submissions' && method === 'GET') {
        if(result.length && result[0].offline) {
          return result; // skip caching because this is offline cached data
        }
        return Q.all(result.map(saveOfflineSubmission.bind(null, self.formId)))
        .thenResolve(result);
      }
      else {
        // Nothing to cache
        return result;
      }

      // Update localForage
      removeCacheDuplicates(cache); // Clean up duplicates
      ready = ready.thenResolve(localForage.setItem(OFFLINE_CACHE_PREFIX + self.projectId, cache))
      .catch(function(err) {
        // Swallow error so it doesn't halt the ready chain
        console.error(err);
      });

      return result;
    });
  };

  // Define specific CRUD methods.
  Formio.prototype.loadProject = _load('project');
  Formio.prototype.saveProject = _save('project');
  Formio.prototype.deleteProject = _delete('project');
  Formio.prototype.loadForm = _load('form');
  Formio.prototype.saveForm = _save('form');
  Formio.prototype.deleteForm = _delete('form');
  Formio.prototype.loadForms = _index('forms');
  Formio.prototype.loadSubmission = _load('submission');
  Formio.prototype.saveSubmission = _save('submission');
  Formio.prototype.deleteSubmission = _delete('submission');
  Formio.prototype.loadSubmissions = _index('submissions');
  Formio.prototype.loadAction = _load('action');
  Formio.prototype.saveAction = _save('action');
  Formio.prototype.deleteAction = _delete('action');
  Formio.prototype.loadActions = _index('actions');
  Formio.prototype.availableActions = function() { return Formio.request(this.formUrl + '/actions'); };
  Formio.prototype.actionInfo = function(name) { return Formio.request(this.formUrl + '/actions/' + name); };

  // Static methods.
  Formio.loadProjects = function() { return this.request(baseUrl + '/project'); };
  Formio.request = function(url, method, data) {
    if (!url) { return Q.reject('No url provided'); }
    method = (method || 'GET').toUpperCase();
    var cacheKey = btoa(url);

    return ready.then(function() {
      // Get the cached promise to save multiple loads.
      if (method === 'GET' && cache.hasOwnProperty(cacheKey)) {
        return cache[cacheKey];
      }
      else {
        return Q()
        .then(function() {
          // Set up and fetch request
          var headers = new Headers({
            'Accept': 'application/json',
            'Content-type': 'application/json; charset=UTF-8'
          });
          var token = Formio.getToken();
          if (token) {
            headers.append('x-jwt-token', token);
          }

          var options = {
            method: method,
            headers: headers,
            mode: 'cors'
          };
          if (data) {
            options.body = JSON.stringify(data);
          }

          return fetch(url, options);
        })
        .catch(function(err) {
          err.message = 'Could not connect to API server (' + err.message + ')';
          err.networkError = true;
          throw err;
        })
        .then(function(response) {
          // Handle fetch results
          if (response.ok) {
            var token = response.headers.get('x-jwt-token');
            if (response.status >= 200 && response.status < 300 && token && token !== '') {
              Formio.setToken(token);
            }
            // 204 is no content. Don't try to .json() it.
            if (response.status === 204) {
              return {};
            }
            return response.json()
            .then(function(result) {
              // Add some content-range metadata to the result here
              var range = response.headers.get('content-range');
              if (range) {
                range = range.split('/');
                if(range[0] !== '*') {
                  var skipLimit = range[0].split('-');
                  result.skip = Number(skipLimit[0]);
                  result.limit = skipLimit[1] - skipLimit[0] + 1;
                }
                result.serverCount = range[1] === '*' ? range[1] : Number(range[1]);
              }
              return result;
            });
          }
          else {
            if (response.status === 440) {
              Formio.setToken(null);
            }
            // Parse and return the error as a rejected promise to reject this promise
            return (response.headers.get('content-type').indexOf('application/json') !== -1 ?
              response.json() : response.text())
              .then(function(error){
                throw error;
              });
          }
        })
        .catch(function(err) {
          // Remove failed promises from cache
          delete cache[cacheKey];
          // Propagate error so client can handle accordingly
          throw err;
        });
      }
    })
    .then(function(result) {
      // Save the cache
      if (method === 'GET') {
        cache[cacheKey] = Q(result);
      }

      // Shallow copy result so modifications don't end up in cache
      if(Array.isArray(result)) {
        var resultCopy = result.map(copy);
        resultCopy.skip = result.skip;
        resultCopy.limit = result.limit;
        resultCopy.serverCount = result.serverCount;
        return resultCopy;
      }
      return copy(result);
    });
  };

  Formio.setToken = function(token) {
    token = token || '';
    if (token === this.token) { return; }
    this.token = token;
    if (!token) {
      Formio.setUser(null);
      return localStorage.removeItem('formioToken');
    }
    localStorage.setItem('formioToken', token);
    Formio.currentUser(); // Run this so user is updated if null
  };
  Formio.getToken = function() {
    if (this.token) { return this.token; }
    var token = localStorage.getItem('formioToken') || '';
    this.token = token;
    return token;
  };
  Formio.setUser = function(user) {
    if (!user) {
      this.setToken(null);
      return localStorage.removeItem('formioUser');
    }
    localStorage.setItem('formioUser', JSON.stringify(user));
  };
  Formio.getUser = function() {
    return JSON.parse(localStorage.getItem('formioUser') || null);
  };

  Formio.setBaseUrl = function(url, _noalias) {
    baseUrl = url;
    noalias = _noalias;
    Formio.baseUrl = baseUrl;
  }
  Formio.clearCache = function() { cache = {}; };

  Formio.currentUser = function() {
    var user = this.getUser();
    if (user) { return Q(user) }
    var token = this.getToken();
    if (!token) { return Q(null) }
    return this.request(baseUrl + '/current')
    .then(function(response) {
      Formio.setUser(response);
      return response;
    });
  };

// Keep track of their logout callback.
  Formio.logout = function() {
    return this.request(baseUrl + '/logout').finally(function() {
      this.setToken(null);
      this.setUser(null);
      Formio.clearCache();
    }.bind(this));
  };
  Formio.fieldData = function(data, component) {
    if (!data) { return ''; }
    if (component.key.indexOf('.') !== -1) {
      var value = data;
      var parts = component.key.split('.');
      var key = '';
      for (var i = 0; i < parts.length; i++) {
        key = parts[i];

        // Handle nested resources
        if (value.hasOwnProperty('_id')) {
          value = value.data;
        }

        // Return if the key is not found on the value.
        if (!value.hasOwnProperty(key)) {
          return;
        }

        // Convert old single field data in submissions to multiple
        if (key === parts[parts.length - 1] && component.multiple && !Array.isArray(value[key])) {
          value[key] = [value[key]];
        }

        // Set the value of this key.
        value = value[key];
      }
      return value;
    }
    else {
      // Convert old single field data in submissions to multiple
      if (component.multiple && !Array.isArray(data[component.key])) {
        data[component.key] = [data[component.key]];
      }
      return data[component.key];
    }
  };

  /**
   * EventEmitter for offline mode events.
   * See Node.js documentation for API documentation: https://nodejs.org/api/events.html
   */
  Formio.offline = new EventEmitter();

  /**
   * Sets up a project to be cached offline
   * @param  url  The url to the project (same as you would pass to Formio constructor)
   * @param  path Optional. Path to local project.json definition to get initial project forms from if offline.
   * @return {[type]}      [description]
   */
  Formio.cacheOfflineProject = function(url, path) {
    var formio = new Formio(url);
    var projectId = formio.projectId;

    var projectPromise = localForage.getItem(OFFLINE_CACHE_PREFIX + projectId)
    .then(function(cached) {
      if (cached) {
        return cached;
      }

      // Otherwise grab offline project definition
      else if (path) {
        return fetch(path)
        .then(function(response) {
          return response.json();
        })
        .then(function(project) {
          project.forms = project.forms || {};

          // Move resources into forms collection, easier to manage that way
          Object.keys(project.resources || {}).forEach(function(resourceName) {
            project.forms[resourceName] = project.resources[resourceName];
          });
          delete project.resources;

          Object.keys(project.forms).forEach(function(formName) {
            // Set modified time as early as possible so any newer
            // form will override this one if there's a name conflict.
            project.forms[formName].created = new Date(0).toISOString();
            project.forms[formName].modified = new Date(0).toISOString();
            project.forms[formName].offline = true;
          });
          return project;
        });
      }

      else {
        // Return an empty project so requests start caching offline.
        return { forms: {} };
      }

    });

    // Add this promise to the ready chain
    ready = ready.thenResolve(projectPromise)
    .then(function(project) {
      offlineCache[projectId] = project;
      return localForage.setItem(OFFLINE_CACHE_PREFIX + projectId, project);
    })
    .catch(function(err) {
      console.error('Error trying to cache offline storage:', err);
      // Swallow the error so failing caching doesn't halt the ready promise chain
    });
    return ready;
  };

  /**
   * Clears the offline cache. This will also stop previously
   * cached projects from caching future requests for offline access.
   */
  Formio.clearOfflineData = function() {
    // Clear in-memory cache
    offlineCache = {};
    submissionQueue = [];
    // Clear localForage cache
    localForage.keys()
    .then(function(keys) {
      return Q.all(keys.map(function(key) {
        if (key.indexOf(OFFLINE_CACHE_PREFIX) === 0 ||
            key.indexOf(OFFLINE_SUBMISISON_CACHE_PREFIX) === 0) {
          return localForage.removeItem(key);
        }
      }));
    })
    .then(function() {
      return localForage.setItem(OFFLINE_QUEUE_KEY, []);
    });

  };

  /**
   * Forces Formio to go into offline mode.
   * @param offline
   */
  Formio.forceOffline = function(offline) {
    forcedOffline = offline;
  };

  /**
   * @return true if Formio is in offline mode (forced or not),
   *         false otherwise
   */
  Formio.isForcedOffline = function() {
    return forcedOffline;
  };

  /**
   * Sets whether form submission requests should
   * be queued. If enabled, submissions are queued to run one
   * after another. Failed submissions halt the queue, which
   * can be restarted by calling Formio.dequeueSubmissions().
   *
   * If disabled (default), submission requests are sent immediately.
   * @param queue
   */
  Formio.queueSubmissions = function(queue) {
    queueSubmissions = queue;
  };

  /**
   * Returns a promise that resolves with the number of
   * submissions left in the submission queue.
   */
  Formio.submissionQueueLength = function() {
    return submissionQueue.length;
  };

  /**
   * Returns a promise that resolves with the next
   * queued submission to be sent.
   */
  Formio.getNextQueuedSubmission = function() {
    return submissionQueue[0].request;
  };

  /**
   * Sets the next queued submission to be sent.
   * Returns a promise that resolves when the next
   * submission has been successfully set.
   */
  Formio.setNextQueuedSubmission = function(request) {
    submissionQueue[0].request = request;
    saveQueue();
  };

  /**
   * Skips the next queued submission to be sent.
   * Returns a promise when the submission has been
   * successfully skipped.
   */
  Formio.skipNextQueuedSubmission = function() {
    submissionQueue.shift();
    saveQueue();
  };

  /**
   * Attempts to send queued submission requests.
   * Each request is sent one at a time. A request that
   * fails will emit the `formError` event on Formio.offline,
   * and stop dequeuing further requests
   */
  Formio.dequeueSubmissions = function() {
    ready.then(function() {
      if (dequeuing) {
        return;
      }

      if (!submissionQueue.length) {
        Formio.offline.emit('queueEmpty');
        return;
      }

      var request = submissionQueue[0].request;
      dequeuing = true;

      var requestPromise;
      if (Formio.isForcedOffline()) {
        // Fake a network error so we go straight into offline logic
        var err = new Error('Formio is forced into offline mode.');
        err.networkError = true;
        requestPromise = Q.reject(err);
      }
      else {
        Formio.offline.emit('dequeue', request);
        requestPromise = Q(Formio.request(request.url, request.method, request.data));
      }


      return requestPromise
      .then(function(submission) {
        // Remove request from queue
        var queuedRequest = submissionQueue.shift();
        saveQueue();
        if (queuedRequest.request.method !== 'DELETE') {
          saveOfflineSubmission(queuedRequest.request.form, submission);
        }
        else {
          deleteOfflineSubmission(queuedRequest.request.form, queuedRequest.request._id);
        }
        // Resolve promise if it hasn't already been resolved with a fake value
        if (queuedRequest.deferred && queuedRequest.deferred.promise.inspect().state === 'pending') {
          queuedRequest.deferred.resolve(submission);
        }
        else if (queuedRequest.request.method !== 'DELETE') {
          // Emit submission if promise isn't available to reject
          Formio.offline.emit('formSubmission', submission);
        }

        // Continue to next queue item
        dequeuing = false;
        Formio.dequeueSubmissions();
      })
      .catch(function(err) {
        // Stop dequeuing because we got a network error trying to request
        dequeuing = null;

        if (!err.networkError) {
          var queuedRequest = submissionQueue[0];
          if(queuedRequest.deferred && queuedRequest.deferred.promise.inspect().state === 'pending') {
            // If we can reject the promise, no need to keep it in the queue
            submissionQueue.shift();
            saveQueue();
            queuedRequest.deferred.reject(err);
          }
          else {
            // Emit error if promise isn't available to reject
            Formio.offline.emit('formError', err, request);
          }
        }

        // Emit an event indicating that the request will be retried later
        // if it hasn't already been removed from the queue
        if (queuedRequest === submissionQueue[0]) {
          Formio.offline.emit('requeue', request);
        }

        // Go through all queued requests and resolve with fake data so
        // app can continue offline
        submissionQueue.forEach(function(queuedRequest) {
          if (queuedRequest.deferred && queuedRequest.deferred.promise.inspect().state === 'pending') {
            var user = Formio.getUser();
            if (queuedRequest.request.method === 'POST') {
              queuedRequest.request.data = {
                _id: ObjectId.generate(),
                owner: user ? user._id : null,
                offline: true,
                form: queuedRequest.request.form,
                data: queuedRequest.request.data.data,
                created: new Date().toISOString(),
                modified: new Date().toISOString(),
                externalIds: [],
                roles: []
              };
              queuedRequest.deferred.resolve(queuedRequest.request.data);
            }
            else if (queuedRequest.request.method === 'PUT') {
              getOfflineSubmission(queuedRequest.request.form, queuedRequest.request._id, queuedRequest)
              .then(function(submission) {
                submission.data = queuedRequest.request.data.data;
                submission.modified = new Date().toISOString();
                queuedRequest.request.data = submission;
                queuedRequest.deferred.resolve(submission);
              })
            }
            else if (queuedRequest.request.method === 'DELETE') {
              queuedRequest.deferred.resolve({});
            }
          }

        });
        saveQueue();

      });
    });
  };

  return Formio;
};
