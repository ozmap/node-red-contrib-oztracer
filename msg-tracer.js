const { context, metrics, propagation, trace, SpanStatusCode } = require('@opentelemetry/api');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { BasicTracerProvider, ConsoleSpanExporter, SimpleSpanProcessor, AlwaysOnSampler } = require('@opentelemetry/sdk-trace-base');
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

const collectorOptions = {
    url: 'http://mhnet.ozmap.com.br:4318/v1/traces'
};
const oTLPTraceExporter = new OTLPTraceExporter(collectorOptions);
const spanProcessor = new SimpleSpanProcessor(oTLPTraceExporter);

function createTracer(node){    
    let name = node.name || node.label;
    const provider = new BasicTracerProvider({
        generalLimits:{
            attributeValueLengthLimit: 2048,
            attributeCountLimit: 256
        },
        spanLimits:{
            attributeValueLengthLimit: 2048,
            attributeCountLimit:256,
            linkCountLimit:256,
            eventCountLimit: 256
        },
        sampler: new AlwaysOnSampler(),
        resource: new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: name,
        }),
    });
    
    provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    provider.addSpanProcessor(spanProcessor);
    provider.register();

    return provider.getTracer(name);
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
                node.tracer = createTracer(node)
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
        if (!msg.OZParentSpan) {
            msg.OZParentSpan = tracer.startSpan(flow.name);
        }
        //inicio do calculo do custo do span
        const ctx = trace.setSpan(context.active(), msg.OZParentSpan);
        msg.OZSpan = tracer.startSpan(node.name, flow.name, ctx);
        if(node.type === 'http in' && msg.req){
            msg.OZSpan.setAttribute("headers", JSON.stringify(msg.req.headers));
            msg.OZSpan.setAttribute("params", JSON.stringify(msg.req.params));
            msg.OZSpan.setAttribute("query", JSON.stringify(msg.req.query));
            msg.OZSpan.setAttribute("body", JSON.stringify(msg.req.body));
        }else{
            msg.OZSpan.setAttribute("message", JSON.stringify(msg.payload));
        }
    });

    // Quando uma mensagem chega no nó, é hora de terminar o span começado no incio,
    // Se for on nó http response, ta na hora de terminar o span pai também
    RED.hooks.add("onReceive", (receiveEvent) => {
        let msg = receiveEvent.msg;
        let destination = receiveEvent.destination;
        let node = destination.node;

        if (msg.OZSpan) {
            msg.OZSpan.setStatus({code: SpanStatusCode.OK});
            msg.OZSpan.end();
        }
        if (msg.OZParentSpan && node.type === 'http response') {
            msg.OZParentSpan.setStatus({code: SpanStatusCode.OK});
            msg.OZParentSpan.end()
        }
    });

    // Example onComplete hook
    RED.hooks.add("onComplete", (completeEvent) => {
        if (completeEvent.error) {
            completeEvent.msg.OZSpan.setStatus({code: SpanStatusCode.ERROR});
            completeEvent.msg.OZSpan.end();
            
            completeEvent.msg.OZParentSpan.setAttribute("error-message", completeEvent.error);
            completeEvent.msg.OZParentSpan.setStatus({code: SpanStatusCode.ERROR});
            completeEvent.msg.OZParentSpan.end()

            completeEvent.msg.OZParentSpan = null;
            completeEvent.msg.OZSpan = null
        }
    });

};
