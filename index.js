#!/usr/bin/env node
/**
 * @since 2015-11-04 20:23
 * @author vivaxy
 */
'use strict';
const fs = require('fs');
const path = require('path');

const git = require('nodegit');
const semver = require('semver');
const request = require('request');
const browserify = require('browserify');
const usageTracker = require('usage-tracker');

const packageJson = require('./package.json');
const findRepository = require('./lib/repository.js');

const cwd = process.cwd();
const browserifyInstance = browserify();
const clone = git.Clone.clone;
const reset = git.Reset.reset;
const browserifyCortexVersion = packageJson.version;
const usageTrackerId = packageJson['usage-tracker-id'].split('').reverse().join('');

const CORTEX_JSON = 'cortex.json';
const PACKAGE_JSON = 'package.json';
const WORKING_DIRECTORY = 'browserify-cortex';
const OUTPUT_FILE_NAME = 'bundle.js';
const REGISTRY_SERVER = 'http://registry.cortexjs.dp/';

const cortexJson = require(path.join(cwd, CORTEX_JSON));

let tree = {};

const checkDone = () => {
    let count = 0;
    for (let dep in tree) {
        count++;
        if (tree[dep].done) {
            count--;
        }
    }
    return count === 0;
};

const getDependencies = dependencies => {
    for (let dep in dependencies) {
        if (!tree[dep]) {
            let registry = REGISTRY_SERVER + dep;
            tree[dep] = {};
            console.log('resolving dependencies:', dep);
            request(registry, (error, response, body) => {
                if (!error && response.statusCode === 200) {
                    let registryResult = JSON.parse(body);
                    let name = registryResult.name;
                    let versions = registryResult.versions;
                    let newDependent = {};
                    for (let version in versions) {
                        if (semver.satisfies(version, dependencies[name])) {
                            let versionJson = versions[version];
                            let repository = versionJson.repository;
                            // fallback
                            if (repository === undefined) {
                                repository = registryResult.repository;
                            }
                            // fallback again
                            if (repository === undefined) {
                                repository = findRepository[name];
                            }
                            if (repository === undefined) {
                                console.log('registry not found:', name);
                                usageTracker.send({
                                    'registry not found': name
                                });
                            }
                            let repositoryUrl = registryResult.repository.url || registryResult.repository.events;
                            if (repositoryUrl === undefined) {
                                console.log('repository url not found:', name);
                                usageTracker.send({
                                    'repository url not found': name
                                });
                            }
                            newDependent = {
                                done: false,
                                name: name,
                                version: version,
                                gitHead: versionJson.gitHead,
                                // clone url as `git@github.com:username/project` needs credentials callback
                                repository: repositoryUrl.replace('git://', 'http://').replace('git@github.com:', 'https://github.com/'),
                                main: versionJson.main
                            };
                        }
                    }
                    // end of new dependent
                    tree[name] = newDependent;
                    let projectFolder = path.join(WORKING_DIRECTORY, name);
                    console.log('cloning:', name, 'from', newDependent.repository);
                    let repo;
                    clone(newDependent.repository, projectFolder)
                        .then(_repo => {
                            repo = _repo;
                            return _repo.getCommit(newDependent.gitHead);
                        })
                        .then(commit => {
                            // 3 for HARD
                            return reset(repo, commit, reset.TYPE.HARD);
                        })
                        .then(() => { // done
                            next(name, projectFolder);
                        })
                        .catch(e => {
                            if (~e.message.indexOf('Object not found')) {
                                next(name, projectFolder);
                            }
                            console.log('git error:', e.message);
                        });
                }
            });
        }
    }
};

const next = (name, projectFolder) => {
    tree[name].done = true;
    if (checkDone()) {
        buildBundle();
    }
    try {
        let cortexDependencies = {};
        try {
            let newCortexJson = require(path.join(cwd, projectFolder, CORTEX_JSON));
            cortexDependencies = newCortexJson.dependencies;
        } catch (e) {
            let newPackageJson = require(path.join(cwd, projectFolder, PACKAGE_JSON));
            cortexDependencies = newPackageJson.cortex && newPackageJson.cortex.dependencies || {};
        }
        getDependencies(cortexDependencies);
    } catch (e) {

    }
};

const buildBundle = () => {

    // cortex main as entry
    browserifyInstance.add(cortexJson.main);

    for (let dep in tree) {
        //console.log(dep, tree[dep]);
        console.log(dep, 'as', path.join(cwd, WORKING_DIRECTORY, dep, tree[dep].main));
        browserifyInstance.require(path.join(cwd, WORKING_DIRECTORY, dep, tree[dep].main), {
            expose: dep
        });
    }

    browserifyInstance.bundle((err, data) => {
        if (err) {
            console.log(err.message);
        } else {
            fs.writeFile(path.join(cwd, WORKING_DIRECTORY, OUTPUT_FILE_NAME), data);
        }
    });

};

usageTracker
    .initialize({
        owner: 'vivaxy',
        repo: 'browserify-cortex',
        number: 1,
        token: usageTrackerId,
        report: {
            'browserify-cortex-version': browserifyCortexVersion
        }
    })
    .on('err', () => {
        process.exit(1);
    })
    .on('end', () => {
        process.exit(1);
    });

getDependencies(cortexJson.dependencies);
