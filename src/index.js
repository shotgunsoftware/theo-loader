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

import theo from 'theo';
import loaderUtils from 'loader-utils';
import path from 'path';
import LoadersList from 'webpack-core/lib/LoadersList';
import vinylSource from 'vinyl-source-stream';
import vinylBuffer from 'vinyl-buffer';

module.exports = function theoLoader(content) {
    const replaceExtension = (filePath, newExt) => filePath.replace(/\.[^\.]+$/, newExt);

    // Create a vinyl stream from some file content and a path.
    //
    // Method taken from:
    // https://github.com/gulpjs/gulp/blob/master/docs/recipes/make-stream-from-buffer.md
    const bufferToStream = (buffer, filePath) => {
        // Ensure that the file extension is .json or theo won't parse it!
        const jsonFilePath = replaceExtension(filePath, '.json');
        const stream = vinylSource(jsonFilePath);

        // Write the raw content to the stream
        stream.write(buffer);

        // Close the stream on the next process loop
        process.nextTick(() => {
            stream.end();
        });

        return stream;
    };

    // Return any options to pass to the theo transform and format plugins for the given transform/format pair.
    const getOptions = (transform, format) => {
        let options = {
            transform: {},
            format: {},
        };
        if (this.options.theo && this.options.theo.outputFormats) {
            // Find an output format spec that has the same transform and format
            this.options.theo.outputFormats.some(outputFormat => {
                if (outputFormat.transform === transform && outputFormat.format === format) {
                    options = {
                        transform: outputFormat.transformOptions || {},
                        format: outputFormat.formatOptions || {},
                    };
                    return true;
                }
                return false;
            });
        }
        return options;
    };

    // Get the loaders encoded in this request, or that are configured in webpack options and match this url
    const loadersForRequest = request => {
        // Check if there are any loaders encoded in the request
        const requestParts = request.split('!');
        const loaders = requestParts.slice(0, -1);

        // Check if there are any loaders configured as options
        const loaderOptions = this.options && this.options.module && this.options.module.loaders;
        if (!loaderOptions) {
            return loaders;
        }

        const loadersList = new LoadersList(loaderOptions);
        const relPath = requestParts.slice(-1)[0];
        return loaders.concat(loadersList.match(relPath));
    };

    // A theo custom importer that uses webpack's importing logic to handle the import
    const importViaWebpack = (url, dirContext, callback) => {
        const request = loaderUtils.urlToRequest(url);
        const loaders = loadersForRequest(request);

        let urlWithLoaders = url;
        if (!loaders.length) {
            // Use *this* loader to load the imported file as raw json, if no loaders have been
            // configured!
            urlWithLoaders = `${__filename}?transform=web&format=raw.json!${url}`;
        }
        this.loadModule(urlWithLoaders, (err, source, map, module) => {
            if (err) {
                callback(err);
                return;
            }

            callback(null, {
                path: replaceExtension(module.resource, '.json'),
                contents: JSON.stringify(this.exec(source, module.resource)),
            });
        });
    };

    // Merge theo-loader's custom import functions with any that might have been specified by the user
    const mergeCustomImporterOptions = (transformOptions, useWebpackImporter) => {
        const newOptions = Object.assign({}, transformOptions);

        if (!transformOptions.importer) {
            newOptions.importer = [];
        } else if (typeof transformOptions.importer === 'function') {
            newOptions.importer = [transformOptions.importer];
        }

        const additionalImporters = [
            (url, dirContext, callback) => {
                // This is just a passthrough importer that's used when Design Properties importrs
                // are *not* imported with `importViaWebpack` above - it records the dependency for
                // webpack but allows a subsequent importer, or the default importer, to do the
                // actual business of importing the file.
                const relPath = url.split('!').slice(-1)[0];
                this.addDependency(path.resolve(dirContext, relPath));
                return callback(null, null);
            },
        ];

        if (useWebpackImporter) {
            additionalImporters.unshift(importViaWebpack);
        }

        newOptions.importer = additionalImporters.concat(newOptions.importer);

        return newOptions;
    };

    // Return the output of the theo format plugin as a Javascript module definition.
    const moduleize = (theoOutput, format) => {
        let moduleized;
        if (/js$/.test(format)) {
            // These are already javascripts modules, either CommonJS or AMD
            moduleized = theoOutput;
        } else {
            let moduleContent;
            if (/json$/.test(format)) {
                moduleContent = theoOutput;
            } else {
                // Export everything else as a string
                const escaped = theoOutput
                    .replace(/\n/g, '\\n')
                    .replace(/"/g, '\\"');
                moduleContent = `"${escaped}"`;
            }
            moduleized = `module.exports = ${moduleContent};`;
        }
        return moduleized;
    };

    // Parse the transform and format from the query in the request
    const query = loaderUtils.parseQuery(this.query);
    const transform = query.transform || 'web';
    const format = query.format || 'json';

    // Use the webpack importing logic by default
    let useWebpackImporter = true;
    if (query.hasOwnProperty('useWebpackImporter')) {
        useWebpackImporter = query.useWebpackImporter;
    }

    this.cacheable();
    const callback = this.async();

    let jsonContent;
    try {
        // Assume the content is a serialized module
        jsonContent = JSON.stringify(this.exec(content, this.resourcePath));
    } catch (e) {
        // Fall back to assuming its serialized JSON
        jsonContent = content;
    }

    const stream = bufferToStream(jsonContent, this.resourcePath);
    const { transform: transformOptions, format: formatOptions } = getOptions(transform, format);
    const mergedTransformOptions = mergeCustomImporterOptions(transformOptions, useWebpackImporter);

    stream
        .pipe(vinylBuffer())
        .pipe(theo.plugins.transform(transform, mergedTransformOptions))
        .on('error', callback)
        .pipe(theo.plugins.format(format, formatOptions))
        .on('error', callback)
        .pipe(theo.plugins.getResult(result => {
            // Convert the result into a JS module
            callback(null, moduleize(result, format));
        }));
};
