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

util.inherits(LimitMarkerStream, events.EventEmitter);
function LimitMarkerStream(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.markerKey, 'opts.markerKey');
    assert.func(opts.getStream, 'opts.getStream');
    assert.optionalString(opts.marker, 'opts.marker');
    assert.number(opts.limit, 'opts.limit');

    self.log = opts.log;
    self.marker = opts.marker || '';
    self.markerKey = opts.markerKey;
    self.getStream = opts.getStream;
    self.limit = opts.limit;
    self.pendingRecord = null;
    self.done = false;
}

LimitMarkerStream.prototype.setNewMarker = function setNewMarker(marker, cb) {
    var self = this;

    assert.string(marker, 'marker');
    assert.func(cb, 'cb');

    assert.ok(!self.done, 'stream already finished');

    var done = false;

    vasync.whilst(
        function testFunc() {
            return !done;
        },
        function iterateFunc(cb2) {
            var opts = {
                autoPaginate: false
            };

            self.getNextRecord(opts, function (record, isDone) {
                if (isDone) {
                    self.log.debug('setNewMarker exhausted existing page');
                    done = true;
                    self.marker = marker;
                    self.res = null;
                    self.pendingRecord = null;
                    cb2();
                    return;
                }

                assert.object(record, 'record');
                if (record[self.markerKey] >= marker) {
                    // we are done fast forwarding
                    self.pendingRecord = record;
                    done = true;
                    self.marker = record[self.markerKey];
                    self.log.debug({pendingRecord: record, marker: self.marker},
                        'setNewMarker found record above marker');
                    cb2();
                    return;
                }

                // discard this record and keep going
                cb2();
            });
        },
        function whilstDone(err, arg) {
            // no error should be seen here
            assert.ifError(err, 'setNewMarker whilst error');
            cb(err);
        });
};

LimitMarkerStream.prototype._getNewStream = function _getNewStream() {
    var self = this;

    assert.ok(!self.done, 'stream already finished');

    self.log.debug({
        marker: self.marker,
        limit: self.limit
    }, 'calling getStream(marker=%j, limit=%d)',
        self.marker,
        self.limit);

    if (self.res) {
        self.res.removeAllListeners();
    }

    self.res = self.getStream(self.marker, self.limit);
    self.numRecords = 0;
    self.resEnded = false;
    self.recordPending = false;

    self.res.on('end', function () {
        self.log.debug('getNewStream ended');
        self.resEnded = true;
    });

    self.res.on('error', function (err) {
        self.log.error(err, 'getNewStream error');
        self.emit('error', err);
    });
};

LimitMarkerStream.prototype.getNextRecord =
    function getNextRecord(opts, cb) {

    var self = this;

    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }

    assert.object(opts, 'opts');
    assert.optionalBool(opts.skipCheck, 'opts.skipCheck');
    assert.optionalBool(opts.autoPaginate, 'opts.autoPaginate');
    assert.func(cb, 'cb');

    assert.ok(!self.done, 'stream already finished');

    var autoPaginate = (opts.autoPaginate === false) ? false : true;

    if (self.pendingRecord) {
        // a record was left over from setNewMarker, send it out
        var r = self.pendingRecord;
        self.pendingRecord = null;
        self.log.warn({record: r}, 'returning pendingRecord');
        sendRecord(r);
        return;
    }

    if (!self.res) {
        self.log.debug('requesting new stream');
        self._getNewStream();
        setImmediate(function () {
            self.getNextRecord({skipCheck: true}, cb);
        });
        return;
    }

    if (!opts.skipCheck) {
        assert(!self.recordingPending, 'self.recordPending');
    }

    self.recordPending = true;

    var record = self.res.read();

    if (record) {
        self.log.trace({record: record}, 'record available - returning');
        sendRecord(record);
        return;
    }

    if (self.resEnded) {
        self.log.debug('self.resEnded is true');
        self.res = null;

        if (self.numRecords === self.limit) {

            // callback with the isDone boolean set, but without setting
            // self.done
            if (!autoPaginate) {
                self.log.debug('autoPagination disabled, sending isDone');
                cb(null, true);
                return;
            }

            self.log.debug('autoPagination enabled, requesting next page');
            self._getNewStream();
            setImmediate(function () {
                self.getNextRecord({skipCheck: true}, cb);
            });
            return;
        }

        self.log.debug('stream is finished and all records exhausted, done');
        self.done = true;
        cb(null, true);
        return;
    }

    self.log.debug('attaching to readable and end events');

    self.res.on('readable', tryRead);
    self.res.on('end', tryRead);
    var done = false;

    function tryRead() {
        if (done) {
            return;
        }

        self.log.debug('detaching readable and end events');

        done = true;
        self.removeListener('readable', tryRead);
        self.removeListener('end', tryRead);

        setImmediate(function () {
            self.getNextRecord({skipCheck: true}, cb);
        });
    }

    function sendRecord(_record) {
        assert.object(_record, '_record');

        setImmediate(function () {
            self.numRecords++;
            self.recordPending = false;
            self.marker = _record[self.markerKey];
            cb(_record, false);
        });
    }
};

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

function listBuckets(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.clients, 'options.clients');

    function _listBuckets(rpc) {
        var msgid = rpc.requestId();
        var argv = rpc.argv();

        if (invalidArgs(rpc, argv, LB_ARGS_SCHEMA)) {
            return;
        }

        var owner = argv[0];
        var prefix = argv[1];
        var limit = argv[2];
        var marker = argv[3];
        var delimiter = argv[4];
        var id = argv[5];

        if (delimiter && delimiter.length > 1) {
            rpc.fail(new InvocationError(
                'listBuckets delimeter larger than 1 character: %j',
                delimiter));
            return;
        }

        dtrace['listbuckets-start'].fire(function () {
            return ([msgid, id, owner, prefix, limit, marker, delimiter]);
        });

        var log = options.log.child({
            req_id: id
        });

        log.debug({
            owner: owner,
            prefix: prefix,
            limit: limit,
            marker: marker,
            delimiter: delimiter
        }, 'listBuckets: entered');

        var nodes = options.dataDirector.getAllNodes();
        var vnodes = {};
        var totalVnodes = nodes.length;

        // Find an appropriate limit to use with boray
        var borayLimit = Math.ceil(limit / totalVnodes * BORAY_MULTIPLIER);

        log.debug('%d vnodes found total, want %d records, using limit of %d',
            totalVnodes, limit, borayLimit);

        // Create a mapping of vnodes to pnodes.
        nodes.forEach(function (node) {
            var client = options.clients.map[node.pnode];
            assert.object(client, 'client for pnode: ' + node.pnode);

            vnodes[node.vnode] = {
                lmstream: new LimitMarkerStream({
                    marker: marker,
                    markerKey: 'name',
                    limit: borayLimit,
                    log: log.child({vnode: node.vnode}),
                    getStream: function (_marker, _limit) {
                        return client.listBuckets(owner, prefix, _limit,
                            _marker, node.vnode, id);
                    }
                }),
                record: null
            };
        });

        var opts = {
            limit: limit,
            prefix: prefix,
            delimiter: delimiter,
            order_by: 'name',
            log: log,
            vnodes: vnodes
        };
        paginationStream(opts,
            function onRecord(record) {
                dtrace['listbuckets-record'].fire(function () {
                    return ([msgid]);
                });
                log.warn({record: record}, 'writing record');
                rpc.write(formatRecord(record));
            },
            function done(err) {
                if (err) {
                    log.error(err, 'listBuckets error');
                    rpc.fail(err);
                    return;
                }

                log.debug('listBuckets done');

                dtrace['listbuckets-done'].fire(function () {
                    return ([msgid]);
                });

                rpc.end();
            });

        function formatRecord(record) {
            assert.object(record, 'record');

            var obj;

            if (record.type === 'message') {
                assert.bool(record.finished, 'record.finished');
                obj = {
                    type: 'message',
                    finished: record.finished
                };

                return obj;
            }

            assert.string(record.name, 'record.name');

            if (record.type === 'group') {
                assert.optionalString(record.nextMarker, 'record.nextMarker');
                obj = {
                    name: record.name,
                    nextMarker: record.nextMarker,
                    type: 'group'
                };

                return obj;
            }

            assert.date(record.created, 'record.created');

            obj = {
                name: record.name,
                type: 'bucket',
                mtime: record.created
            };

            return obj;
        }
    }

    return _listBuckets;
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

function listObjects(options) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.object(options.clients, 'options.clients');

    function _listObjects(rpc) {
        var msgid = rpc.requestId();
        var argv = rpc.argv();

        if (invalidArgs(rpc, argv, LO_ARGS_SCHEMA)) {
            return;
        }

        var owner = argv[0];
        var bucket_id = argv[1];
        var prefix = argv[2];
        var limit = argv[3];
        var marker = argv[4];
        var delimiter = argv[5];
        var id = argv[6];

        if (delimiter && delimiter.length > 1) {
            rpc.fail(new InvocationError(
                'listObjects delimeter larger than 1 character: %j',
                delimiter));
            return;
        }

        dtrace['listobjects-start'].fire(function () {
            return ([msgid, id, owner, prefix, limit, marker, delimiter]);
        });

        var log = options.log.child({
            req_id: id
        });

        log.debug({
            owner: owner,
            bucket_id: bucket_id,
            prefix: prefix,
            limit: limit,
            marker: marker,
            delimiter: delimiter
        }, 'listObjects: entered');

        var vnodes = {};
        var nodes = options.dataDirector.getAllNodes();
        var totalVnodes = nodes.length;

        // Find an appropriate limit to use with boray
        var borayLimit = Math.ceil(limit / totalVnodes * BORAY_MULTIPLIER);

        log.debug('%d vnodes found total, want %d records, using limit of %d',
            totalVnodes, limit, borayLimit);

        // Create a mapping of vnodes to pnodes.
        nodes.forEach(function (node) {
            var client = options.clients.map[node.pnode];
            assert.object(client, 'client for pnode: ' + node.pnode);

            vnodes[node.vnode] = {
                lmstream: new LimitMarkerStream({
                    marker: marker,
                    markerKey: 'name',
                    limit: borayLimit,
                    log: log.child({vnode: node.vnode}),
                    getStream: function (_marker, _limit) {
                        return client.listObjects(owner, bucket_id,
                            prefix, _limit, _marker, node.vnode, id);
                    }
                }),
                record: null
            };
        });

        var opts = {
            limit: limit,
            prefix: prefix,
            order_by: 'name',
            delimiter: delimiter,
            log: log,
            vnodes: vnodes
        };
        paginationStream(opts,
            function onRecord(record) {
                dtrace['listobjects-record'].fire(function () {
                    return ([msgid]);
                });
                rpc.write(formatRecord(record));
            },
            function done(err) {
                if (err) {
                    log.error(err, 'listObjects error');
                    rpc.fail(err);
                    return;
                }

                log.debug('listObjects done');

                dtrace['listobjects-done'].fire(function () {
                    return ([msgid]);
                });

                rpc.end();
            });

        function formatRecord(record) {
            assert.object(record, 'record');

            var obj;

            if (record.type === 'message') {
                assert.bool(record.finished, 'record.finished');
                obj = {
                    type: 'message',
                    finished: record.finished
                };

                return obj;
            }

            assert.string(record.name, 'record.name');

            if (record.type === 'group') {
                assert.optionalString(record.nextMarker, 'record.nextMarker');
                obj = {
                    name: record.name,
                    nextMarker: record.nextMarker,
                    type: 'group'
                };

                return obj;
            }

            assert.uuid(record.id, 'record.id');
            assert.date(record.created, 'record.created');
            assert.string(record.content_type, 'record.content_type');
            assert.string(record.content_md5, 'record.content_md5');
            assert.number(record.content_length, 'record.content_length');

            obj = {
                name: record.name,
                type: 'bucketobject',
                etag: record.id,
                mtime: record.created,
                contentType: record.content_type,
                contentMD5: record.content_md5,
                contentLength: record.content_length
            };

            return obj;
        }
    }

    return _listObjects;
}

function paginationStream(opts, onRecord, done) {
    assert.object(opts, 'opts');
    assert.object(opts.vnodes, 'opts.vnodes');
    assert.object(opts.log, 'opts.log');
    assert.number(opts.limit, 'opts.limit');
    assert.string(opts.order_by, 'opts.order_by');
    assert.optionalString(opts.delimiter, 'opts.delimiter');
    assert.optionalString(opts.prefix, 'opts.prefix');
    assert.func(onRecord, 'onRecord');
    assert.func(done, 'done');

    var log = opts.log;
    var vnodes = opts.vnodes;
    var limit = opts.limit;
    var delimiter = opts.delimiter;
    var prefix = opts.prefix;

    var nextMarker;

    var totalRecordsSent = 0;
    var doneEarly = false;

    log.debug('paginationStream starting');
    vasync.whilst(
        function () {
            return Object.keys(vnodes).length > 0 && !doneEarly;
        },
        function (cb) {
            vasync.forEachParallel({
                inputs: Object.keys(vnodes),
                func: function (vnode, cb2) {
                    var o = vnodes[vnode];

                    assert.object(o, util.format('vnodes[%d]', vnode));

                    if (o.record) {
                        cb2();
                        return;
                    }

                    if (o.lmstream.done) {
                        log.debug('pagination remove vnode %d from list',
                            vnode);
                        delete vnodes[vnode];
                        cb2();
                        return;
                    }

                    o.lmstream.getNextRecord(function (record, isDone) {
                        if (isDone) {
                            delete vnodes[vnode];
                            cb2();
                            return;
                        }

                        assert.object(record, 'record');
                        assert.string(record.created, 'record.created');
                        record.created = new Date(record.created);
                        o.record = record;
                        cb2();
                    });
                }
            }, function (err) {
                if (err) {
                    cb(err);
                    return;
                }

                if (totalRecordsSent >= limit) {
                    log.debug('limit hit (%d) - ending early', limit);
                    doneEarly = true;
                    cb();
                    return;
                }

                processRecords(cb);
            });
        }, function (err) {
            if (err) {
                done(err);
                return;
            }

            /*
             * If we have exhausted all vnodes of their records, then we know
             * *for sure* that there are no more pending records for the user
             * to request.
             */
            var finished = (Object.keys(vnodes).length === 0);
            vnodes = {};

            onRecord({
                type: 'message',
                finished: finished
            });

            done();
        });

    function processRecords(cb) {
        var keys = Object.keys(vnodes);

        if (keys.length === 0) {
            log.debug('no more records to process, we are done');
            cb();
            return;
        }

        keys.sort(function (a, b) {
            a = vnodes[a].record;
            b = vnodes[b].record;
            return a[opts.order_by] < b[opts.order_by] ? -1 : 1;
        });

        var vnode = parseInt(keys[0], 10);
        assert.number(vnode, 'vnode');

        var o = vnodes[vnode];
        assert.object(o, 'o');

        var rec = o.record;
        o.record = null;

        // just send the plain record if no delimiter was specified
        if (!delimiter) {
            sendRecord(rec);
            cb();
            return;
        }

        // try to split the string by the delimiter
        var name = rec[opts.order_by];

        // delimiter is specified, chop off the prefix (if it is supplied) from
        // the name
        if (prefix) {
            assert.ok(name.length >= prefix.length,
                'name.length >= prefix.length');
            assert.equal(name.substr(0, prefix.length), prefix,
                'prefix correct');

            name = name.substr(prefix.length);
        }

        var idx = name.indexOf(delimiter);

        // no delimiter found, just send the plain record
        if (idx < 0) {
            sendRecord(rec);
            cb();
            return;
        }

        // delimiter found
        var base = (prefix || '') + name.substr(0, idx);
        nextMarker = base + String.fromCharCode(delimiter.charCodeAt(0) + 1);

        // send the group record
        sendRecord({
            name: base + delimiter,
            nextMarker: nextMarker,
            type: 'group'
        });

        // Fast forward each vnode stream to the next marker
        vasync.forEachParallel({
            inputs: Object.keys(vnodes),
            func: function (_vnode, cb2) {
                var ob = vnodes[_vnode];

                assert.object(ob, util.format('vnodes[%d]', _vnode));

                if (ob.lmstream.done) {
                    log.debug('fast-forward remove vnode %d from list',
                        _vnode);
                    delete vnodes[_vnode];
                    cb2();
                    return;
                }

                if (ob.record && ob.record[opts.order_by] &&
                    ob.record[opts.order_by] < nextMarker) {

                    ob.record = null;
                }

                ob.lmstream.setNewMarker(nextMarker, cb2);
            }
        }, function (err) {
            cb(err);
        });

        function sendRecord(_rec) {
            totalRecordsSent++;
            onRecord(_rec);
        }
    }
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

        rpc.write(options.dataDirector);
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
