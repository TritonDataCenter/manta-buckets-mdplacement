/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var dtrace = require('dtrace-provider');



///--- Globals

var DTraceProvider = dtrace.DTraceProvider;

var PROBES = {
    // msgid, req_id, owner, bucket, key
    'getobjectlocation-start': ['int', 'char *', 'char *', 'char *', 'char *'],

    // msgid, value
    'getobjectlocation-done': ['int', 'json'],

    // msgid, pnode
    'getvnodes-start': ['int', 'char *'],

    // msgid
    'getvnodes-done': ['int'],

    // msgid
    'getplacementdata-start': ['int'],

    // msgid
    'getplacementdata-done': ['int']
};
var PROVIDER;



///--- API

module.exports = function exportStaticProvider() {
    if (!PROVIDER) {
        PROVIDER = dtrace.createDTraceProvider('electric-boray');

        PROVIDER._fast_probes = {};

        Object.keys(PROBES).forEach(function (p) {
            var args = PROBES[p].splice(0);
            args.unshift(p);

            var probe = PROVIDER.addProbe.apply(PROVIDER, args);
            PROVIDER._fast_probes[p] = probe;
        });

        PROVIDER.enable();
    }

    return (PROVIDER);
}();
