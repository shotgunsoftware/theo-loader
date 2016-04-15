'use strict';

var _theo = require('theo');

var _theo2 = _interopRequireDefault(_theo);

var _loaderUtils = require('loader-utils');

var _loaderUtils2 = _interopRequireDefault(_loaderUtils);

var _path = require('path');

var _path2 = _interopRequireDefault(_path);

var _LoadersList = require('webpack-core/lib/LoadersList');

var _LoadersList2 = _interopRequireDefault(_LoadersList);

var _vinylSourceStream = require('vinyl-source-stream');

var _vinylSourceStream2 = _interopRequireDefault(_vinylSourceStream);

var _vinylBuffer = require('vinyl-buffer');

var _vinylBuffer2 = _interopRequireDefault(_vinylBuffer);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/**
 * Copyright 2016 Autodesk Inc. http://www.autodesk.com
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

module.exports = function theoLoader(content) {
    var _this = this;

    var replaceExtension = function replaceExtension(filePath, newExt) {
        return filePath.replace(/\.[^\.]+$/, newExt);
    };

    // Create a vinyl stream from some file content and a path.
    //
    // Method taken from:
    // https://github.com/gulpjs/gulp/blob/master/docs/recipes/make-stream-from-buffer.md
    var bufferToStream = function bufferToStream(buffer, filePath) {
        // Ensure that the file extension is .json or theo won't parse it!
        var jsonFilePath = replaceExtension(filePath, '.json');
        var stream = (0, _vinylSourceStream2.default)(jsonFilePath);

        // Write the raw content to the stream
        stream.write(buffer);

        // Close the stream on the next process loop
        process.nextTick(function () {
            stream.end();
        });

        return stream;
    };

    // Return any options to pass to the theo transform and format plugins for the given transform/format pair.
    var getOptions = function getOptions(transform, format) {
        var options = {
            transform: {},
            format: {}
        };
        if (_this.options.theo && _this.options.theo.outputFormats) {
            // Find an output format spec that has the same transform and format
            _this.options.theo.outputFormats.some(function (outputFormat) {
                if (outputFormat.transform === transform && outputFormat.format === format) {
                    options = {
                        transform: outputFormat.transformOptions || {},
                        format: outputFormat.formatOptions || {}
                    };
                    return true;
                }
                return false;
            });
        }
        return options;
    };

    // Get the loaders encoded in this request, or that are configured in webpack options and match this url
    var loadersForRequest = function loadersForRequest(request) {
        // Check if there are any loaders encoded in the request
        var requestParts = request.split('!');
        var loaders = requestParts.slice(0, -1);

        // Check if there are any loaders configured as options
        var loaderOptions = _this.options && _this.options.module && _this.options.module.loaders;
        if (!loaderOptions) {
            return loaders;
        }

        var loadersList = new _LoadersList2.default(loaderOptions);
        var relPath = requestParts.slice(-1)[0];
        return loaders.concat(loadersList.match(relPath));
    };

    // A theo custom importer that uses webpack's importing logic to handle the import
    var importViaWebpack = function importViaWebpack(url, dirContext, callback) {
        var request = _loaderUtils2.default.urlToRequest(url);
        var loaders = loadersForRequest(request);

        var urlWithLoaders = url;
        if (!loaders.length) {
            // Use *this* loader to load the imported file as raw json, if no loaders have been
            // configured!
            urlWithLoaders = __filename + '?transform=web&format=raw.json!' + url;
        }
        _this.loadModule(urlWithLoaders, function (err, source, map, module) {
            if (err) {
                callback(err);
                return;
            }

            callback(null, {
                path: replaceExtension(module.resource, '.json'),
                contents: JSON.stringify(_this.exec(source, module.resource))
            });
        });
    };

    // Merge theo-loader's custom import functions with any that might have been specified by the user
    var mergeCustomImporterOptions = function mergeCustomImporterOptions(transformOptions, useWebpackImporter) {
        var newOptions = Object.assign({}, transformOptions);

        if (!transformOptions.importer) {
            newOptions.importer = [];
        } else if (typeof transformOptions.importer === 'function') {
            newOptions.importer = [transformOptions.importer];
        }

        var additionalImporters = [function (url, dirContext, callback) {
            // This is just a passthrough importer that's used when Design Properties importrs
            // are *not* imported with `importViaWebpack` above - it records the dependency for
            // webpack but allows a subsequent importer, or the default importer, to do the
            // actual business of importing the file.
            var relPath = url.split('!').slice(-1)[0];
            _this.addDependency(_path2.default.resolve(dirContext, relPath));
            return callback(null, null);
        }];

        if (useWebpackImporter) {
            additionalImporters.unshift(importViaWebpack);
        }

        newOptions.importer = additionalImporters.concat(newOptions.importer);

        return newOptions;
    };

    // Return the output of the theo format plugin as a Javascript module definition.
    var moduleize = function moduleize(theoOutput, format) {
        var moduleized = void 0;
        if (/js$/.test(format)) {
            // These are already javascripts modules, either CommonJS or AMD
            moduleized = theoOutput;
        } else {
            var moduleContent = void 0;
            if (/json$/.test(format)) {
                moduleContent = theoOutput;
            } else {
                // Export everything else as a string
                var escaped = theoOutput.replace(/\n/g, '\\n').replace(/"/g, '\\"');
                moduleContent = '"' + escaped + '"';
            }
            moduleized = 'module.exports = ' + moduleContent + ';';
        }
        return moduleized;
    };

    // Parse the transform and format from the query in the request
    var query = _loaderUtils2.default.parseQuery(this.query);
    var transform = query.transform || 'web';
    var format = query.format || 'json';

    // Use the webpack importing logic by default
    var useWebpackImporter = true;
    if (query.hasOwnProperty('useWebpackImporter')) {
        useWebpackImporter = query.useWebpackImporter;
    }

    this.cacheable();
    var callback = this.async();

    var jsonContent = void 0;
    try {
        // Assume the content is a serialized module
        jsonContent = JSON.stringify(this.exec(content, this.resourcePath));
    } catch (e) {
        // Fall back to assuming its serialized JSON
        jsonContent = content;
    }

    var stream = bufferToStream(jsonContent, this.resourcePath);

    var _getOptions = getOptions(transform, format);

    var transformOptions = _getOptions.transform;
    var formatOptions = _getOptions.format;

    var mergedTransformOptions = mergeCustomImporterOptions(transformOptions, useWebpackImporter);

    stream.pipe((0, _vinylBuffer2.default)()).pipe(_theo2.default.plugins.transform(transform, mergedTransformOptions)).on('error', callback).pipe(_theo2.default.plugins.format(format, formatOptions)).on('error', callback).pipe(_theo2.default.plugins.getResult(function (result) {
        // Convert the result into a JS module
        callback(null, moduleize(result, format));
    }));
};