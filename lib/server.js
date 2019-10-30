/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var assert = require('assert-plus');
var artedi = require('artedi');
var events = require('events');
var fast = require('fast');
var fs = require('fs');
var kang = require('kang');
var net = require('net');
var os = require('os');
var restify = require('restify');
var util = require('util');
var uuid = require('node-uuid');
var vasync = require('vasync');
var verror = require('verror');

var boray_client = require('./boray_client');
var dtrace = require('./dtrace');
var errors = require('./errors');
var data_placement = require('./data_placement');

var InvocationError = errors.InvocationError;

var KANG_VERSION = '1.2.0';
var BORAY_LIMIT = 1000;
var BORAY_MULTIPLIER = 2;

var CB_ARGS_SCHEMA = [
    { name: 'owner', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'request_id', type: 'string' }
];

var DB_ARGS_SCHEMA = [
    { name: 'owner', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'request_id', type: 'string' }
];

var LB_ARGS_SCHEMA = [
    { name: 'owner', type: 'string' },
    { name: 'prefix', type: 'optionalString' },
    { name: 'limit', type: 'number' },
    { name: 'marker', type: 'optionalString' },
    { name: 'delimiter', type: 'optionalString' },
    { name: 'request_id', type: 'string' }
];

var GB_ARGS_SCHEMA = [
    { name: 'owner', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'request_id', type: 'string' }
];

var GO_ARGS_SCHEMA = [
    { name: 'owner', type: 'string' },
    { name: 'bucket_id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'request_id', type: 'string' }
];

var CO_ARGS_SCHEMA = [
    { name: 'owner', type: 'string' },
    { name: 'bucket_id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'object_id', type: 'string' },
    { name: 'content_length', type: 'number' },
    { name: 'content_md5', type: 'string' },
    { name: 'content_type', type: 'string' },
    { name: 'headers', type: 'object' },
    { name: 'sharks', type: 'object' },
    { name: 'properties', type: 'object' },
    { name: 'request_id', type: 'string' }
];

var UO_ARGS_SCHEMA = [
    { name: 'owner', type: 'string' },
    { name: 'bucket_id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'object_id', type: 'string' },
    { name: 'content_type', type: 'string' },
    { name: 'headers', type: 'object' },
    { name: 'properties', type: 'object' },
    { name: 'request_id', type: 'string' }
];

var LO_ARGS_SCHEMA = [
    { name: 'owner', type: 'string' },
    { name: 'bucket_id', type: 'string' },
    { name: 'prefix', type: 'optionalString' },
    { name: 'limit', type: 'number' },
    { name: 'marker', type: 'optionalString' },
    { name: 'delimiter', type: 'optionalString' },
    { name: 'request_id', type: 'string' }
];

var GV_ARGS_SCHEMA = [
    { name: 'pnode', type: 'string' }
];

var GDP_ARGS_SCHEMA = [];

function createServer(options, callback) {
    assert.object(options, 'options');
    assert.optionalObject(options.fast, 'options.fast');
    options.fast = options.fast || {};
    assert.optionalNumber(options.fast.client_crc_mode,
        'options.fast.client_crc_mode');
    assert.optionalNumber(options.fast.server_crc_mode,
        'options.fast.server_crc_mode');
    assert.func(callback, 'callback');

    var log = options.log;
    var opts = {
        log: options.log
    };

    // remove ready flag
    log.info('server.createServer: removing ready cookie on startup');
    try {
        fs.unlinkSync('/var/tmp/electric-boray-ready');
    } catch (e) {
        // ignore failures if file DNE
    }

    data_placement.createDataDirector({
        log: options.log
    }, function (err, dataDirector) {
        if (err) {
            throw new verror.VError(err, 'unable to instantiate data director');
        }

        opts.dataDirector = dataDirector;

        var client_crc_mode = options.fast.client_crc_mode ||
            fast.FAST_CHECKSUM_V1;
        var server_crc_mode = options.fast.server_crc_mode ||
            fast.FAST_CHECKSUM_V1;

        var labels = {
            datacenter: options.datacenter,
            server: options.server_uuid,
            zonename: os.hostname(),
            pid: process.pid
        };

        var collector = artedi.createCollector({
            labels: labels
        });

        collector.gauge({
            name: 'client_crc_mode',
            help: 'The node-fast CRC compatibilty mode of the Fast client'
        }).set(client_crc_mode);

        collector.gauge({
            name: 'server_crc_mode',
            help: 'The node-fast CRC compatibilty mode of the Fast server'
        }).set(server_crc_mode);

        var socket = net.createServer({ 'allowHalfOpen': true });
        var server = new fast.FastServer({
            collector: collector,
            log: log.child({ component: 'fast' }),
            server: socket,
            crc_mode: server_crc_mode
        });

        var methods = [
            {
                rpcmethod: 'getobjectlocation',
                rpchandler: getObjectLocation(opts)
            },
            {
                rpcmethod: 'getplacementdata',
                rpchandler: getPlacementData(opts)
            },
            {
                rpcmethod: 'getvnodes',
                rpchandler: getVnodes(opts)
            }
        ];

        methods.forEach(function (rpc) {
            server.registerRpcMethod(rpc);
        });

        var kangOpts = {
            service_name: 'electric-boray',
            version: KANG_VERSION,
            uri_base: '/kang',
            ident: os.hostname + '/' + process.pid,
            list_types: server.kangListTypes.bind(server),
            list_objects: server.kangListObjects.bind(server),
            get: server.kangGetObject.bind(server),
            stats: server.kangStats.bind(server)
        };

        var monitorServer = restify.createServer({
            name: 'Monitor'
        });

        monitorServer.get('/kang/.*', kang.knRestifyHandler(kangOpts));

        monitorServer.get('/metrics',
            function getMetricsHandler(req, res, next) {
                req.on('end', function () {
                    assert.ok(collector, 'collector');
                    collector.collect(artedi.FMT_PROM,
                        function (cerr, metrics) {
                            if (cerr) {
                                next(new verror.VError(err));
                                return;
                            }
                            res.setHeader('Content-Type',
                                'text/plain; version 0.0.4');
                            res.send(metrics);
                    });
                    next();
                });
                req.resume();
        });

        monitorServer.listen(options.monitorPort, options.bindip,
            function () {
                log.info('monitor server started on port %d',
                    options.monitorPort);
        });

        socket.on('listening', function () {
            log.info('boray listening on %d', options.port);
            callback(null, {
                dataDirector: opts.dataDirector
            });
        });

        socket.on('error', function (serr) {
            log.error(serr, 'server error');
        });

        socket.listen(options.port, options.bindip);

        // write ready cookie when server setup is complete
        log.info('electric-boray server setup complete, writing ready cookie');
        try {
            fs.writeFileSync('/var/tmp/electric-boray-ready', null);
        } catch (e) {
            throw new verror.VError(e, 'unable to write ready cookie');
        }
    });
}

function invalidArgs(rpc, argv, types) {
    var route = rpc.methodName();
    var len = types.length;
    var optionalRe = /^optional(.*)$/;

    if (argv.length !== len) {
        rpc.fail(new InvocationError(
            '%s expects %d argument%s %d',
            route, len, len === 1 ? '' : 's', argv.length));
        return true;
    }

    for (var i = 0; i < len; i++) {
        var name = types[i].name;
        var type = types[i].type;
        var val = argv[i];
        var m;

        /*
         * If the argument is an "optional" type, figure out what type it is
         * supposed to be, and loop here early if it is set to `null` or
         * `undefined`.
         */
        if ((m = type.match(optionalRe))) {
            type = m[1].toLowerCase();

            if (val === null || val === undefined) {
                continue;
            }
        }

        // 'array' is not a primitive type in javascript, but certain
        // rpcs expect them. Since typeof ([]) === 'object', we need to
        // special case this check to account for these expectations.
        if (type === 'array') {
            if (!Array.isArray(val)) {
                rpc.fail(new InvocationError('%s expects "%s" (args[%d]) to ' +
                            'be of type array but received type %s instead',
                            route, name, i, typeof (val)));
                return true;
            }
            continue;
        }

        if (type === 'object' && val === null) {
            rpc.fail(new InvocationError('%s expects "%s" (args[%d]) to ' +
                        'be an object but received the value "null"', route,
                        name, i));
            return true;
        }


        if (typeof (argv[i]) !== type) {
            rpc.fail(new InvocationError('%s expects "%s" (args[%d]) to be ' +
                'of type %s but received type %s instead (%j)', route, name, i,
                type, typeof (val), val));
            return true;
        }
    }

    return false;
}

function getObjectLocation(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.dataDirector, 'options.dataDirector');

    function _getObjectLocation(rpc) {
        var msgid = rpc.requestId();
        var argv = rpc.argv();

        if (invalidArgs(rpc, argv, GO_ARGS_SCHEMA)) {
            return;
        }

        var owner = argv[0];
        var bucket = argv[1];
        var key = argv[2];
        var id = argv[3];

        dtrace['getobjectlocation-start'].fire(function () {
            return ([msgid, id, owner, bucket, key]);
        });

        var log = options.log.child({
            req_id: id
        });

        log.debug({
            owner: owner,
            bucket: bucket,
            key: key
        }, 'getObjectLocation: entered');

        options.dataDirector.getObjectLocation(owner, bucket, key,
            function (err, location) {

            if (err) {
                rpc.fail(err);
                return;
            }

            var pnode = location.pnode;
            var vnode = location.vnode;
            var obj = {
                vnode: vnode,
                pnode: pnode
            };

            dtrace['getobjectlocation-done'].fire(function () {
                return ([msgid, obj]);
            });

            if (err) {
                rpc.fail(err);
            } else {
                rpc.write(obj);
                rpc.end();
            }
        });
    }

    return _getObjectLocation;
}

function getPlacementData(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.dataDirector, 'options.dataDirector');

    function _getPlacementData(rpc) {
        var msgid = rpc.requestId();
        var argv = rpc.argv();

        if (invalidArgs(rpc, argv, GDP_ARGS_SCHEMA)) {
            return;
        }

        dtrace['getplacementdata-start'].fire(function () {
            return ([msgid]);
        });

        var log = options.log;

        log.debug('getPlacementData: entered');

        dtrace['getplacementdata-done'].fire(function () {
            return ([msgid]);
        });

        log.debug('getPlacementData: done');

        rpc.write(options.dataDirector.dataPlacement);
        rpc.end();
    }

    return _getPlacementData;
}

function getVnodes(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.dataDirector, 'options.dataDirector');

    function _getVnodes(rpc) {
        var msgid = rpc.requestId();
        var argv = rpc.argv();

        if (invalidArgs(rpc, argv, GV_ARGS_SCHEMA)) {
            return;
        }

        var pnode = argv[0];

        dtrace['getvnodes-start'].fire(function () {
            return ([msgid, pnode]);
        });

        var log = options.log;

        log.debug({
            pnode: pnode
        }, 'getVnodes: entered');

        var vnodes = options.dataDirector.getVnodes(pnode);

        dtrace['getvnodes-done'].fire(function () {
            return ([msgid]);
        });

        log.debug({
            pnode: pnode
        }, 'getVnodes: done');


        rpc.write(vnodes);
        rpc.end();
    }

    return _getVnodes;
}

module.exports = {
    createServer: createServer
};
