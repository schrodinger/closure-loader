var loaderUtils = require("loader-utils"),
    merge = require('deepmerge'),
    mapBuilder = require('./dependencyMapBuilder'),
    SourceNode = require("source-map").SourceNode,
    SourceMapConsumer = require("source-map").SourceMapConsumer,
    defaultConfig = config = {
        paths: [],
        es6mode: false,
        watch: true
    };

module.exports = function (source, inputSourceMap) {
    var self = this,
        query = loaderUtils.parseQuery(this.query),
        callback = this.async(),
        originalSource = source,
        config;

    this.cacheable && this.cacheable();

    config = merge(defaultConfig, this.options[query.config || "closureLoader"], query);

    mapBuilder(config.paths, config.watch).then(function(provideMap) {
        var provideRegExp = /goog\.provide *?\((['"])(.*)\1\);?/,
            requireRegExp = /goog\.require *?\((['"])(.*)\1\);?/,
            providesKeys = [],
            requiresKeys = [],
            allKeys = [],
            matches;


        while (matches = provideRegExp.exec(source)) {
            providesKeys.push(matches[2]);
            source = replaceProvide(source, matches[2], matches[0]);
        }

        while (matches = requireRegExp.exec(source)) {
            requiresKeys.push(matches[2]);
            source = replaceRequire(source, matches[2], matches[0], provideMap, providesKeys);
        }

        providesKeys = providesKeys.filter(deduplicate).sort(reverseKeyLengthComparator);
        requiresKeys = requiresKeys.filter(deduplicate);
        var allKeys = requiresKeys.concat(providesKeys).sort(reverseKeyLengthComparator);
        source = collapseKeys(source, allKeys);
        var postfix = createPostfix(providesKeys, config);

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
    });

    /**
     * Escape a string for usage in a regular expression
     *
     * @param {string} string
     * @returns {string}
     */
    function escapeRegExp(string) {
        return string.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
    };

    /**
     * Return a collapsed key to represent a provide or require in our code
     *
     * @param {string} key
     * @returns {string}
     */
    function getCollapsedKey(key) {
      return key.replace(/\./g, '$');
    };

    /**
     * Replace a given goog.require() with a CommonJS require() call.
     *
     * @param {string} source
     * @param {string} key
     * @param {string} search
     * @param {Object} provideMap
     * @param {Array<string>} providesKeys
     * @returns {string}
     */
    function replaceRequire(source, key, search, provideMap, providesKeys) {
        if (!provideMap[key]) {
            throw new Error("Can't find closure dependency " + key);
        }

        var path = loaderUtils.stringifyRequest(self, provideMap[key]);
        var collapsedKey = getCollapsedKey(key);
        var replacement = `${collapsedKey}=require(${path}).${collapsedKey};`;

        /*
         * This shouldn't be necessary but is used where a closure file is missing a require
         * e.g. they require goog.testing.TestCase, but not goog.testing.TestCase.Test
         */
        if(key === 'goog.testing.TestCase' &&
                providesKeys.indexOf('goog.testing.ContinuationTestCase') > -1) {
            var path = loaderUtils.stringifyRequest(self, provideMap['goog.testing.TestCase.Test']);
            replacement += `goog$testing$TestCase.Test=require(${path}).goog$testing$TestCase$Test`;
        }
        return source.replace(new RegExp(escapeRegExp(search), 'g'), replacement);
    };

    /**
     * Replace a given goog.provide() with line to ensure the collapsed key is initialized to an object.
     *
     * @param {string} source
     * @param {string} key
     * @param {string} search
     * @returns {string}
     */
    function replaceProvide(source, key, search) {
        var collapsedKey = getCollapsedKey(key);
        var replacement = `var ${collapsedKey}={};`;

        /*
         * This shouldn't be necessary but is used where a closure file assumes a namespace exists due to a provide
         * e.g. they provide goog.events.EventType but set private values on goog.events
         */
        if(key === 'goog.events.EventType') {
            replacement += 'goog.events={}';
        } else if(key === 'goog.html.SafeUrl') {
          replacement += 'goog.html={}';
        } else if(key === 'goog.dom.MultiRange') {
          replacement += 'goog.dom={}';
        }

        return source.replace(new RegExp(escapeRegExp(search), 'g'), replacement);
    };

    /**
     * Replace all provided and required keys with the collapsed version
     *
     * @param {string} source
     * @param {!Array.<string>} allKeys
     * @returns {string}
     */
    function collapseKeys(source, allKeys) {
        allKeys.forEach(function (key) {
            var collapsedKey = getCollapsedKey(key);
            source = source.replace(new RegExp(escapeRegExp(key), 'g'), collapsedKey);
        });
        return source;
    };

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
    };

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
    };


    /**
     * Create a string which will be injected after the actual module code
     *
     * This will create export statements for all provided namespaces as well as the default
     * export if es6mode is active.
     *
     * @param {Array} providesKeys
     * @param {Object} config
     * @returns {string}
     */
    function createPostfix(providesKeys, config) {
        var postfix = ';';
        providesKeys.forEach(function (key) {
            var collapsedKey = getCollapsedKey(key);
            postfix += `exports.${collapsedKey}=${collapsedKey};`;
        });

        if (config.es6mode && providesKeys.length) {
            var collapsedKey = getCollapsedKey(providesKeys[0]);
            postfix += `exports.default=${collapsedKey};exports.__esModule=true;`;
        }
        return postfix;
    };
};
