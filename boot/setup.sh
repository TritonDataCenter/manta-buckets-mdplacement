#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
#

#
# Bootstraps the consistent hash ring for buckets-mdplacement.
#

set -o xtrace
set -o errexit
set -o pipefail

SOURCE="${BASH_SOURCE[0]}"
if [[ -h $SOURCE ]]; then
    SOURCE="$(readlink "$SOURCE")"
fi
DIR="$( cd -P "$( dirname "$SOURCE" )" && pwd )"
PROFILE=/root/.bashrc
SVC_ROOT=/opt/smartdc/buckets-mdplacement

source ${DIR}/scripts/util.sh
source ${DIR}/scripts/services.sh

export PATH=$SVC_ROOT/bin:$SVC_ROOT/build/node/bin:/opt/local/bin:/usr/sbin/:/usr/bin:$PATH
export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'

FASH=$SVC_ROOT/node_modules/.bin/fash
SDC_IMGADM=$SVC_ROOT/node_modules/.bin/sdc-imgadm
RING_DIR=/buckets-mdplacement/data_placement
SAPI_URL=$(mdata-get SAPI_URL)
[[ -n $SAPI_URL ]] || fatal "no SAPI_URL found"
sleep 10 # wait 10 seconds for dns to setup, this is so lame but otherwise will resolve in dns resolution errors.

#
# Load the Manta Application object from SAPI.  If this request fails, it will
# be retried until the smf(5) method timeout expires for the "mdata:execute"
# service.
#
while :; do
    if ! sapi_res=$(curl --max-time 60 --ipv4 -sSf \
      -H 'Accept: application/json' -H 'Content-Type: application/json' \
      "$SAPI_URL/applications?name=manta&include_master=true"); then
        printf 'WARNING: could not download SAPI application (retrying)\n' >&2
        sleep 2
        continue
    fi

    if ! napps=$(json length <<< "$sapi_res") || [[ $napps != '1' ]]; then
        printf 'WARNING: found "%s" SAPI applications (retry)\n' "$napps" >&2
        sleep 2
        continue
    fi

    if ! manta_app=$(json 0 <<< "$sapi_res") || [[ -z $manta_app ]]; then
        printf 'WARNING: failed to parse "manta" SAPI application (retry)\n' >&2
        sleep 2
        continue
    fi

    break
done

HASH_RING_IMAGE=$(json metadata.BUCKETS_HASH_RING_IMAGE <<< "$manta_app")
[[ -n $HASH_RING_IMAGE ]] || fatal "no BUCKETS_HASH_RING_IMAGE found"
HASH_RING_FILE=/var/tmp/$(uuid -v4).tar.gz
export SDC_IMGADM_URL=$(json metadata.HASH_RING_IMGAPI_SERVICE <<< "$manta_app")
[[ -n $SDC_IMGADM_URL ]] || fatal "no SDC_IMGADM_URL found"
ZONE_UUID=$(/usr/bin/zonename)
ZFS_PARENT_DATASET=zones/$ZONE_UUID/data
ZFS_DATASET=$ZFS_PARENT_DATASET/buckets-mdplacement


function manta_setup_determine_instances {
    BUCKETS_MDPLACEMENT_INSTANCES=1
    local size=`json -f ${METADATA} SIZE`
    if [ "$size" = "lab" ] || [ "$size" = "production" ]
    then
        BUCKETS_MDPLACEMENT_INSTANCES=4
    fi
}

function manta_setup_buckets_mdplacement_hash_ring {
    # get the hash ring image
    $SDC_IMGADM get-file $HASH_RING_IMAGE -o $HASH_RING_FILE
    local ring_parent_dir=/var/tmp/$(uuid -v4)
    local ring=$ring_parent_dir/hash_ring_serialized/ring.json
    mkdir -p $ring_parent_dir
    tar -xzf $HASH_RING_FILE -C $ring_parent_dir
    # delete the dataset if it already exists
    set +o errexit
    zfs destroy -rf $ZFS_DATASET
    set -o errexit
    # create the dataset
    zfs create -o canmount=noauto $ZFS_DATASET
    [[ $? -eq 0 ]] || fatal "unable to setup buckets hash ring"
    # create the mountpoint dir
    mkdir -p $RING_DIR
    [[ $? -eq 0 ]] || fatal "unable to setup buckets hash ring"
    # set the mountpoint
    zfs set mountpoint=$RING_DIR $ZFS_DATASET
    [[ $? -eq 0 ]] || fatal "unable to setup buckets hash ring"
    # mount the dataset
    zfs mount $ZFS_DATASET
    [[ $? -eq 0 ]] || fatal "unable to setup buckets hash ring"

    cp -R $ring $RING_DIR

    ZFS_SNAPSHOT=$ZFS_DATASET@$(date +%s)000
    zfs snapshot $ZFS_SNAPSHOT
    [[ $? -eq 0 ]] || fatal "unable to setup buckets hash ring"
}

function manta_setup_buckets_mdplacement {
    #Build the list of ports.  That'll be used for everything else.
    local ports
    local kangs
    local statuses
    for (( i=1; i<=$BUCKETS_MDPLACEMENT_INSTANCES; i++ )); do
        ports[$i]=`expr 2020 + $i`
        kangs[$i]=`expr 3020 + $i`
        statuses[$i]=`expr 4020 + $i`
    done

    #Regenerate the registrar config with the real ports included
    #(the bootstrap one just includes 2020 alone)
    IFS=','
    local portlist=$(echo "${ports[*]}" | sed 's/^,//')
    local RTPL=$SVC_ROOT/sapi_manifests/registrar/template
    sed -e "s/@@PORTS@@/${portlist}/g" ${RTPL}.in > ${RTPL}

    #Wait until config-agent regenerates config.json before restarting
    #registrar
    svcadm restart config-agent
    while [[ /opt/smartdc/registrar/etc/config.json -ot ${RTPL} ]]; do
        sleep 1
    done
    svcadm restart registrar

    #To preserve whitespace in echo commands...
    IFS='%'

    #buckets-mdplacement instances
    local buckets_mdplacement_xml_in=$SVC_ROOT/smf/manifests/buckets-mdplacement.xml.in
    for (( i=1; i<=$BUCKETS_MDPLACEMENT_INSTANCES; i++ )); do
        local port=${ports[$i]}
        local kang=${kangs[$i]}
        local status=${statuses[$i]}
        local buckets_mdplacement_instance="buckets-mdplacement-$port"
        local buckets_mdplacement_xml_out=$SVC_ROOT/smf/manifests/buckets-mdplacement-$port.xml
        sed -e "s#@@BUCKETS_MDPLACEMENT_PORT@@#$port#g" \
            -e "s#@@KANG_PORT@@#$kang#g" \
            -e "s#@@STATUS_PORT@@#$status#g" \
            -e "s#@@BUCKETS_MDPLACEMENT_INSTANCE_NAME@@#$buckets_mdplacement_instance#g" \
            $buckets_mdplacement_xml_in  > $buckets_mdplacement_xml_out || \
            fatal "could not process $buckets_mdplacement_xml_in to $buckets_mdplacement_xml_out"

        svccfg import $buckets_mdplacement_xml_out || \
            fatal "unable to import $buckets_mdplacement_instance: $buckets_mdplacement_xml_out"
        svcadm enable "$buckets_mdplacement_instance" || \
            fatal "unable to start $buckets_mdplacement_instance"
    done

    #
    # We join the metric ports in a comma-separated list, then add this list as
    # metricPorts mdata to allow scraping by cmon-agent.
    #
    # The metricPorts values are derived from the buckets-mdplacement service's
    # "SIZE" SAPI metadata. We don't need to worry about keeping the metricPorts
    # updated if this variable changes, because such a change does not affect
    # already-provisioned zones. This is because electric-moray zones pull the
    # "SIZE" variable from /var/tmp/metadata.json, which is only written once,
    # when the zone is provisioned -- it is not managed by config-agent.
    #
    mdata-put metricPorts $(IFS=','; echo "${kangs[*]}")

    unset IFS
}

# Mainline

echo "Running common setup scripts"
manta_common_presetup

echo "Adding local manifest directories"
manta_add_manifest_dir "/opt/smartdc/buckets-mdplacement"

manta_common2_setup "buckets-mdplacement"

manta_setup_determine_instances

echo "Setting up hash ring"
manta_setup_buckets_mdplacement_hash_ring

echo "Setting up buckets-mdplacement"
manta_setup_buckets_mdplacement

manta_common2_setup_log_rotation "buckets-mdplacement"

manta_common2_setup_end

exit 0
