"use strict";
const dgram = require('dgram')
    , util = require('util')
    , safeJsonStringify = require('safe-json-stringify');
;

function createLogstashUDP (host, port) {
    const udp = dgram.createSocket('udp4');
    return function(message, fields) {
        const logObject = Object.assign({}, fields, {
            '@timestamp': (new Date()).toISOString(),
            type: 'udp_listener',
            message: message
        });
        sendLog(udp, host, port, logObject);
    };
}

function sendLog(udp, host, port, logObject) {
    const buffer = new Buffer(safeJsonStringify(logObject));
    udp.send(buffer, 0, buffer.length, port, host, function(err /*, bytes */) {
        if(err) {
            console.error("LogstashUDP - %s:%p Error: %s", host, port, util.inspect(err));
        }
    });
}

module.exports = createLogstashUDP;

