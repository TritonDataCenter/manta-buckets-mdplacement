/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var assert = require('assert-plus');
var bignum = require('bignum');
var crypto = require('crypto');
var fash = require('fash');
var fs = require('fs');
var vasync = require('vasync');
var schema = require('./schema/index');


function DataDirector(options, cb) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');
    assert.func(cb, 'callback');

    var self = this;

    this.version = null;
    this.pnodes = [];
    this.log_ = options.log;
    this.dataPlacement = {};

    vasync.pipeline({
        arg: self,
        funcs: [
            getDirectorVersion,
            getPlacementData
        ]
    }, function (err, dp) {
        if (err) {
            return (cb(err));
        }
        this.dataPlacement = dp;

        console.log('Data placement: ' + JSON.stringify(this.dataPlacement));
        self.log_.info('dataDirector.new: initialized new data director');
        return (cb(null, self));
    });
}

//TODO: Eventually this should call out to data placement service
function getDirectorVersion(self, callback) {
    self.dataPlacement.version = '1.0.0';
    return callback(null, true);
}

//TODO: Eventually this should call out to data placement service
function getPlacementData(self, callback) {
    if (self.dataPlacement.version === '1.0.0') {
        //TODO: Eventually this should call out to a separate function per
        // version
        var ring;
        try {
            var ring_path = '/buckets-mdplacement/data_placement/ring.json';
            var file_data = fs.readFileSync(ring_path);
            ring = JSON.parse(file_data, 'utf8');

        } catch (ex) {
            var parse_err =
                new Error('Failed to parse data placement information: ' +
                    ex.message);
            return callback(parse_err);
        }

        ring.pnodes = Object.keys(ring.pnodeToVnodeMap);
        self.dataPlacement.ring = ring;
        return callback(null, self.dataPlacement);
    } else {
        var err = new Error('Invalid data placement version: ' +
            self.dataPlacement.version);
        return callback(err);
    }
}

///--- API

/**
 * Gets the hashed pnode for an object given an owner, bucket, and key.
 * @param {String} bucket The bucket this key belongs to, if a schema exists
 * for this bucket, the key is transformed.
 * @param {String} key The key.
 * @param {Function} callback The callback of the type f(err, hashedNode).
 *
 */
DataDirector.prototype.getObjectLocation =
    function getObjectLocation(owner, bucket, key, callback) {

    var self = this;
    var log = self.log_;

    log.debug({
        bucket: bucket,
        key: key
    }, 'DataDirector.getNode: entered');

    var tkey = owner + ':' + bucket + ':' + key;

    log.debug({
        key: key,
        tkey: tkey
    }, 'DataDirector.getNode: key transformed');

    var value = crypto.createHash(this.dataPlacement.ring.algorithm.NAME).
        update(tkey).digest('hex');
    // find the node that corresponds to this hash.
    var vnodeHashInterval =
        this.dataPlacement.ring.algorithm.VNODE_HASH_INTERVAL;

    var vnode = parseInt(bignum(value, 16).div(bignum(vnodeHashInterval, 16)),
        10);

    var pnode = this.dataPlacement.ring.vnodeToPnodeMap[vnode].pnode;
    var data = this.dataPlacement.ring.pnodeToVnodeMap[pnode][vnode];

    return callback(null, {vnode: vnode, pnode: pnode, data: data});
};


/**
 * Gets the hashed pnode for a bucket given an owner and bucket.
 * @param {String} bucket The bucket this key belongs to, if a schema exists
 * for this bucket, the key is transformed.
 * @param {String} key The key.
 * @param {Function} callback The callback of the type f(err, hashedNode).
 *
 */
DataDirector.prototype.getBucketLocation =
    function getBucketLocation(owner, bucket, callback) {

    var self = this;
    var log = self.log_;

    log.debug({
        owner: owner,
        bucket: bucket
    }, 'DataDirector.getNode: entered');

    var tkey = owner + ':' + bucket;

    log.debug({
        tkey: tkey
    }, 'DataDirector.getNode: key transformed');

    var value = crypto.createHash(this.dataPlacement.ring.algorithm.NAME).
        update(tkey).digest('hex');
    // find the node that corresponds to this hash.
    var vnodeHashInterval =
        this.dataPlacement.ring.algorithm.VNODE_HASH_INTERVAL;
    console.log('hash interval: ' + vnodeHashInterval);
    console.log('value: ' + value);

    var vnode = parseInt(bignum(value, 16).div(bignum(vnodeHashInterval, 16)),
        10);
    console.log('Map to vnode: ' + vnode);

    var pnode = this.dataPlacement.ring.vnodeToPnodeMap[vnode].pnode;
    var data = this.dataPlacement.ring.pnodeToVnodeMap[pnode][vnode];

    return callback(null, {vnode: vnode, pnode: pnode, data: data});
};


function findVnode(options) {
    assert.object(options, 'options');
    assert.object(options.vnodeHashInterval, 'options.vnodeHashinterval');
    assert.string(options.hash, 'options.hash');
    return parseInt(bignum(options.hash, 16).
        div(options.vnodeHashInterval), 10);
}

DataDirector.prototype.getPnodes = function getPnodes() {
    var self = this;
    var log = self.log_;

    log.debug('DataDirectory.getPnodes: entered');

    if (self.dataPlacement.version === '1.0.0') {
        return (self.dataPlacement.ring.pnodes);
    } else {
        return ([]);
    }
};

DataDirector.prototype.getVnodes = function getVnodes(pnode) {
    var self = this;
    var log = self.log_;

    log.debug('DataDirectory.getVnodes (%s): entered', pnode);

    if (self.dataPlacement.version === '1.0.0') {
        var vnodeDataForPnode = self.dataPlacement.ring.pnodeToVnodeMap[pnode];
        if (vnodeDataForPnode) {
            return (Object.keys(vnodeDataForPnode));
        }
    }

    return ([]);
};

DataDirector.prototype.getAllNodes = function getAllNodes() {
    var self = this;
    var log = self.log_;
    var ret = [];

    if (self.dataPlacement.version !== '1.0.0') {
        return ret;
    }

    log.debug('DataDirectory.getAllNodes(): entered');

    var map = self.dataPlacement.ring.vnodeToPnodeMap;
    Object.keys(map).forEach(function (vnode) {
        vnode = parseInt(vnode, 10);
        assert.number(vnode, 'vnode');

        var obj = {
            vnode: vnode,
            pnode: map[vnode].pnode
        };
        ret.push(obj);
    });

    return (ret);
};


///--- Privates

function createDataDirector(options, cb) {
    assert.object(options, 'options');
    assert.object(options.log, 'options.log');

    options.log = options.log.child({component: 'data_placement'});

    return (new DataDirector(options, cb));
}

///--- Exports

module.exports = {
    createDataDirector: createDataDirector
};
