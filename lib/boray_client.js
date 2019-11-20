/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var assert = require('assert-plus');
var clone = require('clone');
var fs = require('fs');
var mdapi = require('buckets-mdapi');
var url = require('url');
var verror = require('verror');

/*
 * Create boray clients in order to interact with boray instances.  Available
 * boray clients are listed in the ring configuration in LevelDB, which we
 * access in electric boray via node-fash.
 */
function createClient(options, callback) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.arrayOfString(options.pnodes, 'options.pnodes');
    assert.object(options.borayOptions, 'options.borayOptions');
    assert.func(callback, 'callback');

    var log = options.log;

    var clientMap = {};
    var clientArray = [];

    var pnodes = options.pnodes;

    pnodes.forEach(function (pnode) {
        var pnodeUrl = url.parse(pnode);
        assert.string(pnodeUrl.port, 'pnodeUrl.port');
        assert.string(pnodeUrl.hostname, 'pnodeUrl.hostname');

        log.info({
            url: pnodeUrl
        }, 'creating boray client');

        var borayargs = clone(options.borayOptions);
        if (!borayargs.cueballOptions) {
            borayargs.cueballOptions = {};
        }
        borayargs.unwrapErrors = true;
        borayargs.srvDomain = pnodeUrl.hostname;
        borayargs.cueballOptions.defaultPort = parseInt(pnodeUrl.port, 10);
        borayargs.log = options.log.child({
            component: 'boray-client-' + pnodeUrl.hostname
        });
        borayargs.crc_mode = options.crc_mode;

        var client = mdapi.createClient(borayargs);
        clientMap[pnode] = client;
        clientArray.push(client);

        if (clientArray.length === pnodes.length) {
            // write ready cookie when clients have connected
            log.info('all boray clients instantiated writing ready cookie');
            try {
                fs.writeFileSync('/var/tmp/electric-boray-ready', null);
            } catch (e) {
                throw new verror.VError(e, 'unable to write ready cookie');
            }
        }
    });

    if (clientArray.length <= 0) {
        throw new verror.VError('No boray clients exist!');
    }

    return callback(null, {
        map: clientMap,
        array: clientArray
    });
}

module.exports = {
    createClient: createClient
};
