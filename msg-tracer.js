const path = require('path')
    , log4js = require('log4js')
    , bodyParser = require('body-parser')
    , fs = require('fs')
    , fse = require('fs-extra')
    , LogStashUdp = require('./logstash')
    , decache = require('decache')
    , serveStatic = require('serve-static')
    , jsondiffpatch = require('jsondiffpatch')
    , _ = require('lodash')
;

require('./cycle.js');

log4js.configure({
    appenders: { console: { type: 'console' } },
    categories: { default: { appenders: ['console'], level: 'ALL' } }
});

const nodeName = path.basename(__filename).split('.')[0];

const rootLogger = log4js.getLogger(nodeName);

module.exports = function(RED) {

    const msgTracerConfigFolderPath = path.resolve(RED.settings.userDir, 'msg-tracer-config');

    let flows = {};
    let subflows = {};

    const msgTracerConfigPath = path.join(msgTracerConfigFolderPath, 'local.json');
    let flowManagerConfig;

    const persistFlowManagerConfigFile = async function () {
        await fse.ensureDir(msgTracerConfigFolderPath);
        fs.writeFile(msgTracerConfigPath, JSON.stringify(flowManagerConfig), 'utf8', function () {});
    };

    try {
        const buEnv = process.env["NODE_CONFIG_DIR"];
        process.env["NODE_CONFIG_DIR"] = msgTracerConfigFolderPath;
        decache('config');
        flowManagerConfig = JSON.parse(JSON.stringify(require('config')));
        decache('config');
        if(buEnv === undefined) {
            delete process.env["NODE_CONFIG_DIR"];
        } else {
            process.env["NODE_CONFIG_DIR"] = buEnv;
        }

        if(Object.keys(flowManagerConfig).length === 0) throw null;
    } catch(e) {
        flowManagerConfig = {uiTrace: false};
        persistFlowManagerConfigFile();
    }

    let logstash;
    function setupLogstash() {
        if(flowManagerConfig.enableLogging && flowManagerConfig.host && flowManagerConfig.port) {
            logstash = LogStashUdp(flowManagerConfig.host, flowManagerConfig.port);
        } else {
            logstash = null;
        }
    }
    setupLogstash();


    let debugSettings = {};
    let caughtMsgs = {};

    function caughtMsgsWithoutOrig() {
        const retVal = {};
        for(let key of Object.keys(caughtMsgs)) {
            const cleanObj = Object.assign({}, caughtMsgs[key]);
            delete cleanObj.origMsg;
            retVal[key] = cleanObj;
        }
        return retVal;
    }

    function publishDebugSettings() {
        RED.comms.publish(nodeName+"/debug", debugSettings, true);
    }
    RED.comms.publish(nodeName+"/caught", {}, true); // initial

    RED.httpAdmin.get('/' + nodeName + '/caught/:caughtId/msg', function(req, res) {
        try {
            const msg = caughtMsgs[req.params.caughtId].origMsg;
            const safeMsg = Object.assign({}, msg);
            delete safeMsg.req;
            delete safeMsg.res;
            delete safeMsg.debugger;
            res.send(safeMsg);
        } catch (e) {
            res.status(404).send({"error":"Could not find caught msg"})
        }
    });
    RED.httpAdmin.put('/' + nodeName + '/debug', bodyParser.json(), function(req, res) {
        if(req.body && req.body.constructor === {}.constructor) {
            debugSettings = req.body;
            res.send({ok:true});
            publishDebugSettings();
        } else {
            res.status(202).send({error: 'Must send json object {...}'});
        }
    });

    RED.httpAdmin.put('/' + nodeName + '/caught/continue/:id', function(req, res) {
        const caughtId = req.params.id;
        const execu = caughtMsgs[caughtId];
        if(execu && execu.resolve) execu.resolve();
        res.send({ok:true});
    });

    RED.httpAdmin.post('/' + nodeName + '/caught/continue', function(req, res) {
        resolveAllCaughtPoints();
        res.send({ok:true});
    });

    RED.httpAdmin.put('/' + nodeName + '/caught/step/:id', function(req, res) {
        const caughtId = req.params.id;
        const execu = caughtMsgs[caughtId];
        if(execu && execu.resolve) execu.resolve('step');
        res.send({ok:true});
    });

    RED.httpAdmin.post('/' + nodeName + '/caught/step', function(req, res) {
        resolveAllCaughtPoints('step');
        res.send({ok:true});
    });

    RED.httpAdmin.put('/' + nodeName + '/caught/kill/:id', function(req, res) {
        const caughtId = req.params.id;
        const execu = caughtMsgs[caughtId];
        if(execu && execu.resolve) execu.resolve('kill');
        res.send({ok:true});
    });

    RED.httpAdmin.post('/' + nodeName + '/caught/kill', function(req, res) {
        resolveAllCaughtPoints('kill');
        res.send({ok:true});
    });

    RED.httpAdmin.put('/' + nodeName + '/caught/patch/:id', function(req, res) {
        try {
            const caughtId = req.params.id;
            const delta = req.body;

            jsondiffpatch.patch(
                caughtMsgs[caughtId].origMsg,
                delta
            );
            res.send({ok:true});
            RED.comms.publish(nodeName+"/caught", caughtMsgsWithoutOrig(), true);
        } catch(e) {
            res.status(404).send(e);
        }
    });

    RED.httpAdmin.put('/' + nodeName + '/config', bodyParser.json(), function(req, res) {
        if(req.body && req.body.constructor === {}.constructor) {
            flowManagerConfig = req.body;
            persistFlowManagerConfigFile();
            updateClientSideConfigState();
            setupLogstash();
            res.send(flowManagerConfig);
        } else {
            res.status(202).send({error: 'Must send json object {...}'});
        }
    });

    RED.httpAdmin.patch('/' + nodeName + '/config', bodyParser.json(), function(req, res) {
        if(req.body && req.body.constructor === {}.constructor) {
            Object.assign(flowManagerConfig, req.body);
            persistFlowManagerConfigFile();
            updateClientSideConfigState();
            setupLogstash();
            res.send(flowManagerConfig);
        } else {
            res.status(202).send({error: 'Must send json object {...}'});
        }
    });

    function updateClientSideConfigState() {
        RED.comms.publish(nodeName+"/config", flowManagerConfig, true);
    }

    function getFlowPath(node) {
        const workspace = flows[node.z];
        if(workspace) return workspace.label;
        else {
            const parentNode = RED.nodes.getNode(node.z);
            if(!parentNode) return '';
            const subFlowId = parentNode.type.split('subflow:')[1];
            let subflowName = null;
            for(const subflowKey of Object.keys(subflows)) {
                const flowNode = subflows[subflowKey];
                if(flowNode.id === subFlowId) {
                    subflowName = flowNode.name;
                    break;
                }
            }
            return getFlowPath(parentNode) + '/' + subflowName;
        }
    }

    function nodeLogProperties(nodeObj) {
        const nodeObjectForLog = {
            id: nodeObj._alias || nodeObj.id || null, // _alias if it's a subflow, id in normal case.
            name: nodeObj.name || null,
            label: nodeObj.label || null,
            type: nodeObj.type || null,
        };

        const stepText = nodeObjectForLog.type + '@ ' + (nodeObjectForLog.name||nodeObjectForLog.label||'(NameLess)') + ' #' +nodeObjectForLog.id;

        return {
            stepText: stepText,
            node: nodeObjectForLog
        }
    }

    function patchNodeProto(NodeProto) {
        const backupReceive = NodeProto.receive;

        function proxySend(msg) {

            if(msg) {
                const handleMsg = (m)=>{
                    if(m && m.tracerLog) {
                        if(logstash) {
                            const logInfo = JSON.decycle(m.tracerLog);
                            const nodeLogProps = nodeLogProperties(this);
                            logstash('Node-RED tracer result after ' + nodeLogProps.stepText + JSON.stringify(logInfo), {
                                nodered_tracer_log: {
                                    node: nodeLogProps.node,
                                    info: logInfo
                                }
                            });
                        }
                        delete m.tracerLog;
                    }
                };

                if(Array.isArray(msg)) {
                    for(const m of msg) {
                        handleMsg(m);
                    }
                } else handleMsg(msg);
            }
            this.msgTracerOriginalSend(msg);
        }

        NodeProto.receive = async function (msg) {

            if(!this.msgTracerOriginalSend) {
                this.msgTracerOriginalSend = this.send;
                this.send = this.msgTracerProxySend = proxySend;
            }

            let brkOption = undefined;
            let singleBreak;
            if(msg && msg.debugger) {
                singleBreak = true;
                delete msg.debugger;
            } else {
                singleBreak = false;
            }

            if(flowManagerConfig.uiTrace) {
                try {
                    const flowPath = getFlowPath(this);
                    const clonedMsg = _.cloneDeep(JSON.decycle(msg));
                    if(clonedMsg && clonedMsg.req) {
                        delete clonedMsg.req;
                        delete clonedMsg.res;
                    }

                    if(flowPath && this.hasOwnProperty('type') && !this.type.startsWith('subflow:')) {
                        const categoryName = flowPath;

                        const nodeLogProps = nodeLogProperties(this);
                        const dataToLog = {
                            nodered_tracer_step: {
                                msg: clonedMsg || null,
                                node: nodeLogProps.node
                            }
                        };
                        if(flowManagerConfig.console) {
                            const logger = log4js.getLogger(nodeName + ' ' + categoryName);
                            logger.debug(nodeLogProps.stepText + '%j', dataToLog, {
                                data: dataToLog
                            });
                        }

                        RED.comms.publish(nodeName+"/log", {
                            time: new Date().toJSON(),
                            msg: clonedMsg,
                            node: nodeLogProps.node
                        });

                        if(logstash) {
                            logstash(nodeLogProps.stepText, {
                                nodered_tracer_step: {
                                    msg: JSON.stringify(clonedMsg) || "",
                                    node: nodeLogProps.node,
                                    path: categoryName
                                }
                            });
                        }
                    }
                } catch (e) {
                    rootLogger.error(e);
                }
            }

            if(
                (this.id && debugSettings.hasOwnProperty(this.id) && debugSettings[this.id].break) ||
                (this._alias && debugSettings.hasOwnProperty(this._alias) && debugSettings[this._alias].break) || // nodes within a subflow
                singleBreak
            ) {
                const genId = RED.util.generateId();
                brkOption = await new Promise((resolve)=>{
                    const awaitingMsg = {
                        nodeId: this._alias? this._alias : this.id, // _alias is the actual id of subflow nodes
                        date: new Date(),
                        resolve:resolve,
                        origMsg: msg
                    };

                    caughtMsgs[genId] = awaitingMsg;

                    const objWithoutResolve = Object.assign({}, awaitingMsg);
                    delete objWithoutResolve.resolve;
                    RED.comms.publish(nodeName+"/caught", caughtMsgsWithoutOrig(), true);
                });
                delete caughtMsgs[genId];
                RED.comms.publish(nodeName+"/caught", caughtMsgsWithoutOrig(), true);
            }

            try {
                if(brkOption === 'step') {

                    // this send wrapper is a "backup" for the `msg.debugger` indicator, in case the node instance delete it.
                    this.send = function(msg) {
                        try {
                            if(msg) {
                                if(Array.isArray(msg)) {
                                    for(let i=0;i<msg.length;i++) {
                                        if(msg[i]) msg[i].debugger = true;
                                    }
                                } else {
                                    msg.debugger = true;
                                }
                            }
                            this.msgTracerProxySend(msg);
                            if(msg) {
                                if(Array.isArray(msg)) {
                                    for(let i=0;i<msg.length;i++) {
                                        if(msg[i]) delete msg[i].debugger;
                                    }
                                } else {
                                    delete msg.debugger;
                                }
                            }
                        } catch(ignore) {}

                        setTimeout(()=>{
                            this.send = this.msgTracerProxySend;
                        },0);
                    };
                    if(msg) msg.debugger = true;
                } else {
                    if(msg) delete msg.debugger;
                }
            } catch(i) {}

            try {
                if(brkOption === 'kill') return;

                backupReceive.bind(this)(msg);
            } catch (e) {
                rootLogger.error('NodeRed could not continue step'); // Should not happen
            }
        };
    }

    function resolveAllCaughtPoints(val) {
        for(let catchId of Object.keys(caughtMsgs)) {
            // Release all caught msg(s) from last breakpoints
            try {
                const catchInfo = caughtMsgs[catchId];
                catchInfo.resolve(val || undefined);
            } catch(e) {}
        }
    }

    let patchedNodeToSupportDebugging = false;
    RED.events.on('flows:started', function () {

        if(!patchedNodeToSupportDebugging) {
            try {
                RED.nodes.eachNode(function (nodeConfig) {
                    const n = RED.nodes.getNode(nodeConfig.id);
                    if(n && n.__proto__ && n.__proto__.constructor && n.__proto__.constructor.super_ && n.__proto__.constructor.super_.name === 'Node') {
                        const NodeConstructor = n.__proto__.constructor.super_;
                        patchNodeProto(NodeConstructor.prototype);
                        patchedNodeToSupportDebugging = true;
                        throw 'break';
                    }
                })
            } catch(ignore) {}
        }

        resolveAllCaughtPoints();

        // Delete non-existent breakpoints
        for(let nodeId of Object.keys(debugSettings)) {
            const nodeRef = RED.nodes.getNode(nodeId);
            if(!nodeRef) delete debugSettings[nodeId];
        }
        publishDebugSettings();

        flows = {};
        subflows = {};
        RED.nodes.eachNode(function (node) {
            if(node.type === 'tab') {
                flows[node.id] = node;
            } else if(node.type === 'subflow') {
                subflows[node.id] = node;
            }
        });
        updateClientSideConfigState();
    });
    const pathOfJsonDiffPatch = path.join(require.resolve('jsondiffpatch'), '..', "jsondiffpatch.umd.slim.js");
    RED.httpAdmin.use( '/'+nodeName+'/jsondiffpatch.js', serveStatic(pathOfJsonDiffPatch));
};
