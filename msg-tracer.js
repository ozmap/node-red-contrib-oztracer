const { context, metrics, propagation, trace } = require('@opentelemetry/api');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const tracer = trace.getTracer('node-red-machine');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const fse = require('fs-extra');
const jsondiffpatch = require('jsondiffpatch');
const _ = require('lodash');
const cycle = require('./cycle.js');

const flows = {};

function createProviderPerFlow(flowname) {
    const provider = new BasicTracerProvider({
        resource: new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: flowname,
        }),
    });
    const collectorOptions = {
        url: 'http://devops.ozmap.com.br:4318/v1/traces'
    };
    provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter(collectorOptions)));
    provider.register();
    return provider;
}


module.exports = function (RED) {
    const msgTracerConfigFolderPath = path.resolve(RED.settings.userDir, 'msg-tracer-config');
    const msgTracerConfigPath = path.join(msgTracerConfigFolderPath, 'local.json');
    const flowManagerConfig = JSON.parse(JSON.stringify(require('config')));
    const persistFlowManagerConfigFile = async function () {
        await fse.ensureDir(msgTracerConfigFolderPath);
        fs.writeFile(msgTracerConfigPath, JSON.stringify(flowManagerConfig), 'utf8', function () { });
    };

    RED.events.on('flows:started', function () {
        RED.nodes.eachNode(function (node) {
            if (node.type === 'tab' || node.type.startsWith('subflow:')) {
                flows[node.id] = node;
                createProviderPerFlow(node.name);
                node.tracer = trace.getTracer(node.name)
            }
        });
    });

    RED.hooks.add("onSend", (sendEvents) => {
        let evt = sendEvents[0];
        let source = evt.source
        let node = source.node;
        let msg = evt.msg; 
        let flowId = source.node.z;
        let flow = flows[flowId];
        let tracer = flow.tracer;
        
        //Primeira vez neste flow, vamos criar o span pai
        if(!msg.parentSpan){
            msg.parentSpan = tracer.startSpan(flow.name);
        }
        //inicio do calculo do custo do span
        const ctx = trace.setSpan(context.active(), msg.parentSpan);
        msg.span = tracer.startSpan(node.name, flow.name, ctx);
        msg.span.setAttribute('input-message', msg.payload);
    });

    // Quando uma mensagem chega no nó, é hora de terminar o span começado no incio,
    // Se for on nó http response, ta na hora de terminar o span pai também
    RED.hooks.add("onReceive", (receiveEvent) => {
        let msg = receiveEvent.msg;
        let destination = receiveEvent.destination;
        let node = destination.node;
        if(msg.span){
            msg.span.end();
        }
        if(node.type === 'http response' && msg.parentSpan){
            msg.parentSpan.end()
        }
    });

    // Example onComplete hook
    RED.hooks.add("onComplete", (completeEvent) => {
        //console.log("complete",completeEvent.node.node.name )
        if (completeEvent.error) {
            //console.log(`Message completed with error: ${completeEvent.error}`);
        }
    });


};
