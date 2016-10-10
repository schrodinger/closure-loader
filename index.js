var loaderUtils = require("loader-utils"),
    merge = require('deepmerge'),
    mapBuilder = require('./dependencyMapBuilder'),
    SourceNode = require("source-map").SourceNode,
    SourceMapConsumer = require("source-map").SourceMapConsumer,

    // Set collapsePrefixes to an Array of namespaces to collapse
    // For example [''] will collapse variables from bb.app.etc to bb_app_etc
    // This improves what UglifyJS can do when mangling
    defaultConfig = config = {
        paths: [],
        es6mode: false,
        watch: true,
        collapsePrefixes: []
    },
    postfix;


module.exports = function (source, inputSourceMap) {
    var self = this,
        query = loaderUtils.parseQuery(this.query),
        callback = this.async(),
        originalSource = source,
        allCollapsedVars = [],
        exportedVars = [],
        exportedCollapsedVars = [],
        config;

    this.cacheable && this.cacheable();

    config = merge(defaultConfig, this.options[query.config || "closureLoader"], query);

    mapBuilder(config.paths, config.watch).then(function(provideMap) {
        var commentedRequireRegExp = new RegExp('\\/\\/\\s*goog\\.require *?\\(([\'"])(.*?)\\1\\);?', 'g');
        var commentedRequires = [];
        while (commentedRequire = commentedRequireRegExp.exec(source)) {
          commentedRequires.push(commentedRequire[0]);
        }
        if (commentedRequires.length > 0) {
          throw new Error('Commented out goog.requires are not allowed ' + JSON.stringify(commentedRequires, undefined, 2));
        }

        var provideRegExp = /goog\.provide *?\((['"])(.*?)\1\);?/,
            requireRegExp = new RegExp('goog\\.require *?\\(([\'"])(.*?)\\1\\);?', 'g');
            exportVarTree = {},
            matches;

        // Iterate through all goog.requires and collect the keys in order
        // as well as a map from the key to the matched string
        var requiredKeys = [];
        var requiresMatchMap = {};
        while (matches = requireRegExp.exec(source)) {
            var requireKey = matches[2];
            if (isCollapsiblePackage(requireKey)) {
              allCollapsedVars.push(requireKey);
            }
            requiredKeys.push(requireKey);
            requiresMatchMap[requireKey] = matches[0];
        }

        // Iterate through all goog.provides, and collect the keys to export.
        // Remove all the provides, but if the key is collapsible, go ahead and declare a var for it
        // Also if we have no requires, go ahead and ensure the exported keys namespace exists.
        var createdNamespaces = ['goog'];
        while (matches = provideRegExp.exec(source)) {
            var provideKey = matches[2];
            var replaceRegex = new RegExp(escapeRegExp(matches[0]), 'g');
            var provideReplacement = '';

            if (isCollapsiblePackage(provideKey)) {
              allCollapsedVars.push(provideKey);
              exportedCollapsedVars.push(provideKey);
              var collapsedKey = getCollapsedKey(provideKey, provideMap);
              provideReplacement = `var ${collapsedKey}={};`;
            } else {
              exportedVars.push(provideKey);
              if (requiredKeys.length === 0) {
                  provideReplacement = ensureNamespace(provideKey, createdNamespaces, false);
              }
            }
            source = source.replace(replaceRegex, provideReplacement);
        }

        // For each goog.require replace with a CommonJS require.
        // Also, after the last require, ensure all the namespaces for exported variables exist
        requiredKeys.forEach(function (requireKey, index) {
            var isLast = requiredKeys.length - 1 === index;
            var additionalVars = isLast ? exportedVars : null;
            source = replaceRequire(source, requireKey, requiresMatchMap[requireKey],
                provideMap, createdNamespaces, additionalVars);
        });

        exportedVars = exportedVars
            .filter(deduplicate)
            .filter(removeNested)
            .map(buildVarTree(exportVarTree));

        // Sort all keys in reverse length so we replace the longer keys first to avoid replacing with the wrong value
        // Then replace all usages of keys in source with their collapsed value
        // e.g. If a file provides both bb.etc.Actions and bb.etc.Actions.EventType
        // replace bb.etc.Actions.EventType first to avoid changing to bb_etc_Actions.EventType.BLAH
        allCollapsedVars = allCollapsedVars.filter(deduplicate).sort(reverseKeyLengthComparator);
        source = replaceWithCollapsedKeys(source, allCollapsedVars, provideMap);

        exportedCollapsedVars = exportedCollapsedVars.filter(deduplicate);
        postfix = createPostfix(exportVarTree, exportedVars, exportedCollapsedVars, config, provideMap);

        if(inputSourceMap) {
            var currentRequest = loaderUtils.getCurrentRequest(self),
                node = SourceNode.fromStringWithSourceMap(originalSource, new SourceMapConsumer(inputSourceMap));

            node.add(postfix);
            var result = node.toStringWithSourceMap({
                file: currentRequest
            });

            callback(null, source + postfix, result.map.toJSON());
            return;
        }

        callback(null, source + postfix, inputSourceMap);
    }).catch(function(error) {
      callback(error);
    });

    /**
     * Escape a string for usage in a regular expression
     *
     * @param {string} string
     * @returns {string}
     */
    function escapeRegExp(string) {
        return string.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
    }

    /**
     * Find the an ancestor namespace of the key which we've ensured exists.
     * This should be the closest ancestor since we store these in an array as we create them
     * and we never create a namespace without creating it's parent first
     *
     * @param {string} key
     * @param {Array<string>} createdNamespaces
     * @returns {string}
     */
    function findParent(key, createdNamespaces) {
        for (var i=createdNamespaces.length-1; i >= 0; i--) {
            if (key.startsWith(createdNamespaces[i] + '.')) return createdNamespaces[i];
        }
        return null;
    }

    /**
     * Return true if the key should be collapsed
     *
     * @param {string} key
     * @returns {boolean}
     */
    function isCollapsiblePackage(key) {
      return config.collapsePrefixes.some(function(prefix) {
          return key.startsWith(prefix);
      });
    }

    /**
     * Return a collapsed key to represent a provide or require in our code
     * NOTE (jordan) Keys for JSX file provides must be capitalized so React knows they're components
     *
     * @param {string} key
     * @param {Object} provideMap
     * @returns {string}
     */
    function getCollapsedKey(key, provideMap) {
      var newKey = key.replace(/\./g, '_');
      if (provideMap[key].endsWith('.jsx')) {
        newKey = 'B' + newKey.substring(1);
      }
      return newKey;
    }

    /**
     * A sort function for ordering keys in reverse order of length.
     * We sort in reverse order so we replace something like goog.dom.query before we replace goog.dom
     *
     * @param {string} a
     * @param {string} b
     * @returns {number} comparison
     */
    function reverseKeyLengthComparator(a, b) {
        return b.length - a.length;
    }

    /**
     * Search through the source and replace any collapsible keys with their collapsed value.
     * This doesn't replace cases where the key is in quotation marks
     *
     * @param {string} source
     * @param {Array} allCollapsedVars
     * @param {Object} provideMap
     * @returns {string}
     */
    function replaceWithCollapsedKeys(source, allCollapsedVars, provideMap) {
        allCollapsedVars.forEach(function (key) {
            var collapsedKey = getCollapsedKey(key, provideMap);

            // Search ensures we match a trailing character which is invalid in a variable name to avoid collisions
            // We also don't match cases where the key is a string such as displayName fields
            // NOTE (jordan) The trailing character regex is incomplete, but probably good enough
            // NOTE (jordan) We also specifically handle the case of <namespace>.'
            // for: http://opengrok/xref/seurat/SEURAT-JavaScript/dev/src/bb/util/proxies/AjaxProxy.js#115
            var search = new RegExp(escapeRegExp(key) + '(?![\'"a-zA-Z0-9_\\$]|\\.\')', 'g');
            source = source.replace(search, collapsedKey);
        });
        return source;
    }

    /**
     * Replace a given goog.require() with a CommonJS require() call.
     * We also ensure the namespace for the key exists before the require.
     * If additionalVars are passed in (as we do for the last require call), we ensure those vars
     * namespaces exist after the require.
     *
     * @param {string} source
     * @param {string} key
     * @param {string} search
     * @param {Object} provideMap
     * @param {Array<string>} createdNamespaces
     * @param {Array<string>} additionalVars
     * @returns {string}
     */
    function replaceRequire(source, key, search, provideMap, createdNamespaces, additionalVars) {
        var replaceRegex = new RegExp(escapeRegExp(search), 'g');
        var path, requireString;

        if (!provideMap[key]) {
            throw new Error("Can't find closure dependency " + key);
        }

        path = loaderUtils.stringifyRequest(self, provideMap[key]);

        if (isCollapsiblePackage(key)) {
            var collapsedKey = getCollapsedKey(key, provideMap);
            var replacement = `var ${collapsedKey}=require(${path}).${collapsedKey};`;
            return source.replace(replaceRegex, replacement);
        }

        // If the required module has a parent module which was previously required,
        // ensure injected namespaces in case they were overwritten
        var prefixString = ensureNamespace(key, createdNamespaces, true);
        createdNamespaces.push(key);

        // If this is the last require let's check and make sure
        // no provide injected namespaces were overwritten
        var suffixString = '';
        if (additionalVars) {
            additionalVars.forEach(function (additionalVar) {
                suffixString += ensureNamespace(additionalVar, createdNamespaces, false);
            });
        }

        replaceString = `${prefixString}${key}=require(${path}).${key};${suffixString}`;
        return source.replace(replaceRegex, replaceString);
    }

    /**
     * Given a key and an array of created namespaces, create the namespace for the key if it doesn't exist.
     *
     * @param {string} key
     * @param {Array<string>} createdNamespaces
     * @param {boolean} removeLast
     * @returns {string}
     */
    function ensureNamespace(key, createdNamespaces, removeLast) {
      var ensureString = '';
      if (createdNamespaces.indexOf(key) > -1) {
        return ensureString;
      }

      var parent = findParent(key, createdNamespaces);
      var neededNamespaces = key.split('.');
      if (parent) {
        neededNamespaces = key.replace(parent + '.', '').split('.');
      }

      if (removeLast) {
        neededNamespaces.pop();
      }
      neededNamespaces.forEach(function(namespace) {
          if (parent) {
            parent = `${parent}.${namespace}`;
            ensureString += `${parent}=${parent}||{};`;
          } else {
            parent = namespace;
            ensureString += `var ${parent}=goog.global.${parent}=goog.global.${parent}||{};`;
          }
          createdNamespaces.push(parent);
      });
      return ensureString;
    }

    /**
     * Array filter function to remove duplicates
     *
     * @param {string} key
     * @param {number} idx
     * @param {Array} arr
     * @returns {boolean}
     */
    function deduplicate(key, idx, arr) {
        return arr.indexOf(key) === idx;
    }

    /**
     * Array filter function to remove vars which already have a parent exposed
     *
     * Example: Remove a.b.c if a.b exists in the array
     *
     * @param {[type]} key [description]
     * @param {[type]} idx [description]
     * @param {[type]} arr [description]
     *
     * @returns {[type]} [description]
     */
    function removeNested(key, idx, arr) {
        var foundParent = false;

        key.split('.')
            .forEach(function (subKey, subIdx, keyParts) {
                var parentKey;
                if(subIdx === (keyParts.length - 1)) return;
                parentKey = keyParts.slice(0, subIdx + 1).join('.');
                foundParent = foundParent || arr.indexOf(parentKey) >= 0;
            });

        return !foundParent;
    }

    /**
     * Creates a function that extends an object based on an array of keys
     *
     * Example: `['abc.def', 'abc.def.ghi', 'jkl.mno']` will become `{abc: {def: {ghi: {}}, jkl: {mno: {}}}`
     *
     * @param {Object} tree - the object to extend
     * @returns {Function} The filter function to be called in forEach
     */
    function buildVarTree(tree) {
        return function (key) {
            var layer = tree;
            key.split('.').forEach(function (part) {
                layer[part] = layer[part] || {};
                layer = layer[part];
            });
            return key;
        }
    }

    /**
     * Create a string which will be injected after the actual module code
     *
     * This will create export statements for all provided namespaces as well as the default
     * export if es6mode is active.
     *
     * @param {Object} exportVarTree
     * @param {Array} exportedVars
     * @param {Array} exportedCollapsedVars
     * @param {Object} config
     * @param {Object} provideMap
     * @returns {string}
     */
    function createPostfix(exportVarTree, exportedVars, exportedCollapsedVars, config, provideMap) {
        postfix = ';\n';
        Object.keys(exportVarTree).forEach(function (rootVar) {
            var jsonObj;
            enrichExport(exportVarTree[rootVar], rootVar);
            jsonObj = JSON.stringify(exportVarTree[rootVar]).replace(/(['"])%(.*?)%\1/g, '$2');
            postfix += 'exports.' + rootVar + '=' + jsonObj + ';';
        });

        exportedCollapsedVars.forEach(function (key) {
          var collapsedKey = getCollapsedKey(key, provideMap);
          postfix += `exports.${collapsedKey}=${collapsedKey};`;
        });

        if (config.es6mode && exportedVars.length) {
            postfix += 'exports.default=' + exportedVars.shift() + ';exports.__esModule=true;';
        } else if (config.es6mode && exportedCollapsedVars.length) {
            postfix += 'exports.default=' + getCollapsedKey(exportedCollapsedVars[0], provideMap) + ';exports.__esModule=true;';
        }

        return postfix;
    }

    /**
     * Replace all empty objects in an object tree with a special formatted string containing the path
     * of that empty object in the tree
     *
     * Example: `{abc: {def: {}}}` will become `{abc: {def: "%abc.def%"}}`
     *
     * @param {Object} object - The object tree to enhance
     * @param {string} path - The base path for the given object
     */
    function enrichExport(object, path) {
        path = path ? path + '.' : '';
        Object.keys(object).forEach(function (key) {
            var subPath = path + key;

            if (Object.keys(object[key]).length) {
                enrichExport(object[key], subPath);
            } else {
                object[key] = '%' + subPath + '%';
            }
        });
    }
};
