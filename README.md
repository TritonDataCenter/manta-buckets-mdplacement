<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# electric-boray

This repository is part of the Joyent Manta project.  For contribution
guidelines, issues, and general documentation, visit the main
[Manta](http://github.com/joyent/manta) project page.

electric-boray is a Node-based service that provides data placement
services. This includes services such as locating the correct physical storage
location given the metadata for an object or providing the virtual nodes that
belong to a physical storage node.


# Building and running

To run your own electric-boray from a copy of this repository, you'll want:

* a Manta deployment, which includes at least one metadata shard of Boray and
  Manatee,
* an electric-boray configuration file, and
* an electric-boray consistent hash ring configuration.

Once you've got these pieces in place, install the dependencies:

    $ make

update your path:

    $ source env.sh

and run electric-boray with something like this:

    $ node ./main.js -f /path/to/config.json -r /path/to/hash/ring -p 2020 \
        2>&1 | bunyan

For example, if the configuration file and hash ring were copied to your
electric-moray workspace, you'd use:

    $ node ./main.js -f ./config.json -r ./leveldb-2021 -p 2020 2>&1 | bunyan


# Testing

First, make sure you're running a local copy of electric-boray as described
above.  Then, run the test suite:

    $ make test

This assumes that an electric-boray server is running on localhost port 2020.
