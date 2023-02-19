const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const fse = require('fs-extra');
const jsondiffpatch = require('jsondiffpatch');
const _ = require('lodash');
const cycle = require('./cycle.js');


module.exports = function(RED) {    
    const msgTracerConfigFolderPath = path.resolve(RED.settings.userDir, 'msg-tracer-config');
    const msgTracerConfigPath = path.join(msgTracerConfigFolderPath, 'local.json');
    const flowManagerConfig = JSON.parse(JSON.stringify(require('config')));
    const persistFlowManagerConfigFile = async function () {
        await fse.ensureDir(msgTracerConfigFolderPath);
        fs.writeFile(msgTracerConfigPath, JSON.stringify(flowManagerConfig), 'utf8', function () {});
    };

        const flows = {};
        const subflows = {};

        
        RED.events.on('flows:started', function () {
            RED.nodes.eachNode(function (node) {
                if(node.type === 'tab') {
                    flows[node.id] = node;
                } else if(node.type === 'subflow') {
                    subflows[node.id] = node;
                }
            });      
            console.log(flows,subflows)
        });
        

    
    RED.hooks.add("onSend", (sendEvents) => {
        console.log('total',sendEvents.length)
        console.log('onSend',sendEvents[0].source.node);
    });

    RED.hooks.add("onReceive", (receiveEvent) => {
       //console.log('onReceive', receiveEvent);
    });

    // Example onComplete hook
    RED.hooks.add("onComplete", (completeEvent) => {
        //console.log(completeEvent.node.node )
        if (completeEvent.error) {
            console.log(`Message completed with error: ${completeEvent.error}`);
        }
    });


};
